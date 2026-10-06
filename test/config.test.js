'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, resolveApiKey, gate, configWarnings, isPlaceholderKey, listZcodeProviders, SYNC_TIMEOUT_CAP_MS } = require('../hooks/lib/config');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-cfg-'));
}

// 隔离用户级配置：测试不得读本机真实 ~/.zcode/advisor.config.json。
// 0.2.17 起还必须隔离 ZCode 服务商配置（~/.zcode/v2/config.json）——否则测试会读到
// 开发者本机真实的服务商与 key，断言随环境漂移（且明文 key 进入测试输出）。
function hermeticEnv(extra) {
  return Object.assign({
    ZCODE_ADVISOR_USER_CONFIG: path.join(os.tmpdir(), `zcadv-no-user-${Date.now()}.json`),
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(os.tmpdir(), `zcadv-no-zcode-${Date.now()}.json`),
    // 隔离第二个数据源（provider_config.json）——不然会读开发机真实服务商
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(os.tmpdir(), `zcadv-no-zpc-${Date.now()}.json`)
  }, extra);
}

test('无配置文件时返回内置默认值', () => {
  const cfg = loadConfig(tmpRoot(), hermeticEnv());
  // 0.2.17：model 不再是硬编码默认（glm-5.3-flash）——留空表示「取所选服务商清单首项」。
  assert.strictEqual(cfg.model, '');
  assert.strictEqual(cfg.immuneTurns, 3);
  assert.strictEqual(cfg.proseFallback, true);
  // 无 ZCode 服务商可解析 → 门禁会拦下，必须挂可见 problem（不是静默空跑）。
  assert.ok(cfg.problems.some((p) => p.startsWith('zcode_provider_missing')));
  assert.deepStrictEqual(cfg.configSources, []);
});

test('配置文件覆盖默认值，环境变量再覆盖配置文件', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ model: 'glm-5.3', immuneTurns: 5 }));
  const cfg = loadConfig(root, hermeticEnv());
  assert.strictEqual(cfg.model, 'glm-5.3');
  assert.strictEqual(cfg.immuneTurns, 5);
  // 服务商解析失败不追加来源；插件层来源照旧可见。
  assert.deepStrictEqual(cfg.configSources, ['plugin:advisor.config.json']);
  const cfg2 = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_MODEL: 'glm-4.6', ZCODE_ADVISOR_IMMUNE_TURNS: '1' }));
  assert.strictEqual(cfg2.model, 'glm-4.6');
  assert.strictEqual(cfg2.immuneTurns, 1);
  assert.ok(cfg2.configSources.includes('env'));
});

test('用户级配置覆盖插件目录配置，且跨升级保留（/advisor-setup 的载体）', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ model: 'glm-5.3-flash', apiKey: 'plugin-key' }));
  const userCfg = path.join(tmpRoot(), 'user-advisor.config.json');
  fs.writeFileSync(userCfg, JSON.stringify({ model: 'glm-5.3', apiKey: 'user-key-abc' }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_USER_CONFIG: userCfg }));
  assert.strictEqual(cfg.model, 'glm-5.3'); // 用户层覆盖插件层
  // 0.2.17：apiKey 不再是可落盘配置键——旧配置里的手动 key 一律不参与解析
  // （否则「手动 key 发往服务商端点」= 密钥交叉）。
  assert.strictEqual(cfg.apiKey, undefined);
  assert.deepStrictEqual(cfg.configSources, ['plugin:advisor.config.json', 'user:~/.zcode/advisor.config.json']);
});

test('损坏的配置文件降级为默认值，且 problems 被记录（可被 status 消费）', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), '{not json');
  const cfg = loadConfig(root, hermeticEnv());
  assert.strictEqual(cfg.model, '');
  assert.ok(cfg.problems.some((p) => p.startsWith('config_invalid')));
});

test('整数范围守卫：0/负数回退默认并挂 problems', () => {
  const root = tmpRoot();
  const env = hermeticEnv({
    ZCODE_ADVISOR_MAX_DELTA_MESSAGES: '0',
    ZCODE_ADVISOR_MAX_NOTE_CHARS: '-5',
    ZCODE_ADVISOR_IMMUNE_TURNS: '0'
  });
  const cfg = loadConfig(root, env);
  assert.strictEqual(cfg.maxDeltaMessages, 60);
  assert.strictEqual(cfg.maxNoteChars, 768);
  assert.strictEqual(cfg.immuneTurns, 0); // 允许 0
  assert.strictEqual(cfg.problems.filter((p) => p.startsWith('config_out_of_range')).length, 2);
});

test('sync 模式下超时被钳制到 Stop hook 硬限以内，async 不钳制', () => {
  const root = tmpRoot();
  const env = hermeticEnv({ ZCODE_ADVISOR_REVIEW_TIMEOUT_MS: '420000' });
  const syncCfg = loadConfig(root, { ...env, ZCODE_ADVISOR_REVIEW_MODE: 'sync' });
  assert.strictEqual(syncCfg.reviewTimeoutMs, SYNC_TIMEOUT_CAP_MS);
  assert.ok(syncCfg.problems.some((p) => p.startsWith('reviewTimeoutMs_clamped')));
  const asyncCfg = loadConfig(root, env);
  assert.strictEqual(asyncCfg.reviewTimeoutMs, 420000);
  // 只断言「没有超时钳制」——隔离环境下必然有 zcode_provider_missing（无服务商可解析）。
  assert.ok(!asyncCfg.problems.some((p) => p.startsWith('reviewTimeoutMs_clamped')));
});

test('占位符 key 识别', () => {
  assert.strictEqual(isPlaceholderKey('REPLACE_YOUR_KEY'), true);
  assert.strictEqual(isPlaceholderKey('your-api-key'), true);
  assert.strictEqual(isPlaceholderKey('xxx'), true);
  assert.strictEqual(isPlaceholderKey(''), true);
  assert.strictEqual(isPlaceholderKey('sk-real-token-123'), false);
});

test('apiKey 解析链：config 优先，其次 env 顺序，占位符跳过', () => {
  assert.deepStrictEqual(resolveApiKey({ apiKey: 'config-key', apiKeyEnv: ['A_KEY', 'B_KEY'] }, { A_KEY: 'env-a', B_KEY: 'env-b' }), { key: 'config-key', source: 'config' });
  assert.deepStrictEqual(resolveApiKey({ apiKey: '', apiKeyEnv: ['A_KEY', 'B_KEY'] }, { A_KEY: 'REPLACE_ME', B_KEY: 'env-b' }), { key: 'env-b', source: 'env:B_KEY' });
  assert.deepStrictEqual(resolveApiKey({ apiKey: '', apiKeyEnv: ['A_KEY'] }, {}), { key: '', source: '' });
});

test('硬门禁：缺 key/模型/端点时给出对应原因', () => {
  assert.deepStrictEqual(gate({ baseUrl: 'u', model: 'm' }, { key: '' }), ['missing:apiKey']);
  assert.deepStrictEqual(gate({ baseUrl: 'u', model: '' }, { key: 'k' }), ['missing:model']);
  assert.deepStrictEqual(gate({ baseUrl: '', model: 'm' }, { key: 'k' }), ['missing:baseUrl']);
  assert.deepStrictEqual(gate({ baseUrl: 'u', model: 'm' }, { key: 'k' }), []);
});

test('配置警告：非本机 http 端点、共享 env key 发往非签发方', () => {
  assert.ok(configWarnings({ baseUrl: 'http://192.168.1.5:8788/v1' }, { key: 'k', source: 'config' }).some((w) => w.startsWith('insecure_http_endpoint')));
  assert.strictEqual(configWarnings({ baseUrl: 'http://localhost:8788/v1' }, { key: 'k', source: 'config' }).length, 0);
  assert.ok(configWarnings(
    { baseUrl: 'http://third-party.example.com/v1' },
    { key: 'k', source: 'env:ZAI_API_KEY' }
  ).some((w) => w.startsWith('key_endpoint_mismatch')));
  assert.strictEqual(configWarnings(
    { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
    { key: 'k', source: 'env:ZAI_API_KEY' }
  ).length, 0);
});

// —— ZCode 服务商：0.2.17 起唯一审查来源（端点/key/模型都从这里解析） ——

// 造一个 ZCode v2 config 形状的 fixture（provider.<id> = { name, kind, options, models }）
function zcodeFixtureFile(dir) {
  const file = path.join(dir, 'v2-config.json');
  fs.writeFileSync(file, JSON.stringify({
    provider: {
      'prov-3p': {
        name: '第三方网关',
        kind: 'openai-compatible',
        options: { baseURL: 'http://192.168.50.139:8088/v1', apiKey: 'sk-3p-key' },
        models: { 'glm-5.3-flash': {}, 'kimi-k3': {} }
      },
      'prov-anthropic': {
        name: 'Anthropic 中转',
        kind: 'anthropic',
        options: { baseURL: 'https://relay.example.com', apiKey: 'sk-ant' },
        models: { 'claude-opus-5': {} }
      },
      // 协议不受支持（既非 OpenAI 兼容、也非 Anthropic）：必须判 ineligible、不产出凭据。
      'prov-unknown': {
        name: '未知协议网关',
        kind: 'bedrock',
        options: { baseURL: 'https://bedrock.example.com', apiKey: 'sk-unknown' },
        models: { 'some-model': {} }
      },
      'builtin:bigmodel': {
        name: 'BigModel 官方',
        kind: 'openai',
        options: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-official' },
        models: { 'glm-5.3': {} }
      }
    }
  }));
  return file;
}

test('服务商解析：显式 zcodeProvider 覆盖端点/key，模型留空取清单首项', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ zcodeProvider: 'prov-3p' }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.baseUrl, 'http://192.168.50.139:8088/v1');
  assert.strictEqual(cfg.apiKey, 'sk-3p-key');
  assert.strictEqual(cfg.model, 'glm-5.3-flash'); // model 留空 → 清单首项
  assert.strictEqual(cfg.providerId, 'prov-3p');
  assert.strictEqual(cfg.providerName, '第三方网关');
  assert.strictEqual(cfg.providerAuto, false);
  assert.match(cfg.providerLabel, /ZCode 第三方服务商（第三方网关）/);
  assert.ok(cfg.configSources.includes('zcode-provider:第三方网关'));
  const keyInfo = resolveApiKey(cfg, {});
  assert.strictEqual(keyInfo.key, 'sk-3p-key');
  assert.strictEqual(keyInfo.source, 'config');
});

test('服务商解析：未指定服务商 → 自动选择可用第三方（登记官方内置被排除）', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  // prov-anthropic 协议不兼容、builtin: 是官方内置 → 只剩 prov-3p 可用
  assert.strictEqual(cfg.providerId, 'prov-3p');
  assert.strictEqual(cfg.providerAuto, true);
  assert.ok(cfg.notices.some((n) => n.startsWith('zcode_provider_auto')));
});

test('服务商解析：显式模型不在清单里也尊重（清单可能滞后），但登记 notice', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    zcodeProvider: 'prov-3p', model: 'deepseek-v4-pro-0813'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.model, 'deepseek-v4-pro-0813');
  assert.ok(cfg.notices.some((n) => n.startsWith('zcode_model_unlisted')));
});

test('服务商解析：环境变量仍优先于服务商解析（env 是显式逃生舱）', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ zcodeProvider: 'prov-3p' }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file, ZCODE_ADVISOR_MODEL: 'env-model' }));
  assert.strictEqual(cfg.model, 'env-model');
  assert.strictEqual(cfg.baseUrl, 'http://192.168.50.139:8088/v1');
});

test('服务商解析：协议不受支持/官方内置/找不到时都不产出凭据（防密钥交叉）', () => {
  const file = zcodeFixtureFile(tmpRoot());
  const root = tmpRoot();
  // 不受支持的协议（kind=bedrock）→ 不产出 baseUrl/apiKey（旧版会回退手动值 = 密钥交叉面）
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    zcodeProvider: 'prov-unknown', model: 'manual-model'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.baseUrl, undefined);
  assert.strictEqual(cfg.apiKey, undefined);
  assert.ok(cfg.problems.some((p) => p.startsWith('zcode_provider_ineligible')));

  // anthropic 协议：自 0.2.20 起受支持（reviewer.js 走 /v1/messages）——必须产出凭据与协议标记
  const rootAnt = tmpRoot();
  fs.writeFileSync(path.join(rootAnt, 'advisor.config.json'), JSON.stringify({
    zcodeProvider: 'prov-anthropic', model: 'claude-opus-5'
  }));
  const cfgAnt = loadConfig(rootAnt, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfgAnt.baseUrl, 'https://relay.example.com');
  assert.strictEqual(cfgAnt.apiKey, 'sk-ant');
  assert.strictEqual(cfgAnt.model, 'claude-opus-5');
  assert.strictEqual(cfgAnt.protocol, 'anthropic');
  assert.strictEqual(cfgAnt.problems.some((p) => p.startsWith('zcode_provider_ineligible')), false);

  // 官方内置通道：明确拒绝
  const root2 = tmpRoot();
  fs.writeFileSync(path.join(root2, 'advisor.config.json'), JSON.stringify({ zcodeProvider: 'builtin:bigmodel' }));
  const cfg2 = loadConfig(root2, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg2.baseUrl, undefined);
  assert.ok(cfg2.problems.some((p) => p.startsWith('zcode_provider_official')));

  // 显式指定但不存在：登记 not_found（面板点刷新后重选）
  const root3 = tmpRoot();
  fs.writeFileSync(path.join(root3, 'advisor.config.json'), JSON.stringify({ zcodeProvider: 'no-such-prov' }));
  const cfg3 = loadConfig(root3, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.ok(cfg3.problems.some((p) => p.startsWith('zcode_provider_not_found')));

  // 完全没有服务商：登记 missing
  const cfg4 = loadConfig(tmpRoot(), hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(tmpRoot(), 'empty.json')
  }));
  assert.ok(cfg4.problems.some((p) => p.startsWith('zcode_provider_missing')));
});

test('旧版手动残留（apiSource/baseUrl/apiKey/zcodeModel）不再参与解析', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    apiSource: 'manual',
    baseUrl: 'http://manual.example/v1',
    apiKey: 'manual-key-should-be-ignored',
    zcodeModel: 'legacy-model',
    zcodeProvider: 'prov-3p'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.apiSource, undefined);
  assert.strictEqual(cfg.zcodeModel, undefined);
  assert.strictEqual(cfg.baseUrl, 'http://192.168.50.139:8088/v1');
  assert.strictEqual(cfg.apiKey, 'sk-3p-key');
  assert.strictEqual(cfg.model, 'glm-5.3-flash');
});

test('listZcodeProviders：剔除 apiKey 明文并给出 eligible/official/protocol/hasApiKey 标记', () => {
  const file = zcodeFixtureFile(tmpRoot());
  const list = listZcodeProviders({ ZCODE_ADVISOR_ZCODE_CONFIG: file, ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(os.tmpdir(), 'zcadv-no-zpc-lp.json') });
  assert.strictEqual(list.length, 4);
  const p3p = list.find((p) => p.id === 'prov-3p');
  assert.strictEqual(p3p.eligible, true);
  assert.strictEqual(p3p.protocol, 'openai');
  assert.strictEqual(p3p.official, false);
  assert.strictEqual(p3p.hasApiKey, true);
  assert.strictEqual('apiKey' in p3p, false, '列表不得携带 apiKey 明文');
  assert.deepStrictEqual(p3p.models, ['glm-5.3-flash', 'kimi-k3']);
  const pant = list.find((p) => p.id === 'prov-anthropic');
  assert.strictEqual(pant.eligible, true, 'anthropic 自 0.2.20 起可用（走 /v1/messages）');
  assert.strictEqual(pant.protocol, 'anthropic');
  const punknown = list.find((p) => p.id === 'prov-unknown');
  assert.strictEqual(punknown.eligible, false, '既非 OpenAI 兼容也非 Anthropic → 不可用');
  assert.strictEqual(punknown.protocol, '');
  const pbuiltin = list.find((p) => p.id === 'builtin:bigmodel');
  assert.strictEqual(pbuiltin.official, true, 'builtin: 前缀 = ZCode 官方内置通道');
});

test('占位符 key：ZCode 服务商里粘了模板占位符 → 视为未配置（防误导性 401）', () => {
  // 用户在 ZCode 里把 apiKey 留成 your-api-key/test-* 这类模板值时，
  // 若当真实 key 发出去会得到"key 无效"的 401——其实是压根没填。必须视为未配置。
  const dir = tmpRoot();
  const file = path.join(dir, 'v2-placeholder.json');
  fs.writeFileSync(file, JSON.stringify({
    provider: {
      'prov-ph': {
        name: '占位符网关', kind: 'openai-compatible',
        options: { baseURL: 'http://10.0.0.1:8080/v1', apiKey: 'your-api-key' },
        models: { 'm-1': {} }
      }
    }
  }));
  const list = listZcodeProviders({ ZCODE_ADVISOR_ZCODE_CONFIG: file, ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(os.tmpdir(), 'zcadv-no-zpc-lp.json') });
  const p = list.find((x) => x.id === 'prov-ph');
  assert.strictEqual(p.hasApiKey, false, '占位符 key 不得算作"已配置"');

  // 全局解析时同样不产出凭据（门禁拦下并给出可操作原因）
  const cfg = loadConfig(tmpRoot(), hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: file,
    ZCODE_ADVISOR_ZCODE_PROVIDER: 'prov-ph'
  }));
  assert.strictEqual(cfg.apiKey, undefined, '占位符 key 不得进入 cfg.apiKey');
  assert.ok(cfg.problems.some((x) => x.startsWith('zcode_provider_incomplete')),
    `应报服务商不完整：${JSON.stringify(cfg.problems)}`);
});

test('env 逃生舱：端点与 key 必须成对（与 hook 侧 resolveTarget 同一纪律）', () => {
  const env = hermeticEnv({ ZCODE_ADVISOR_BASE_URL: 'http://evil.example/v1' });
  const cfg = loadConfig(tmpRoot(), env);
  assert.strictEqual(cfg.baseUrl, undefined, '只给端点时不得生效（否则服务商 key 会发往该端点）');
  assert.ok(cfg.problems.some((p) => p.startsWith('env_override_incomplete')));

  const ok = loadConfig(tmpRoot(), hermeticEnv({
    ZCODE_ADVISOR_BASE_URL: 'http://ok.example/v1',
    ZCODE_ADVISOR_API_KEY: 'sk-real-key-123456'
  }));
  assert.strictEqual(ok.baseUrl, 'http://ok.example/v1');
  assert.strictEqual(ok.apiKey, 'sk-real-key-123456');

  // 占位符 key 不算成对
  const ph = loadConfig(tmpRoot(), hermeticEnv({
    ZCODE_ADVISOR_BASE_URL: 'http://ok.example/v1',
    ZCODE_ADVISOR_API_KEY: 'your-api-key'
  }));
  assert.strictEqual(ph.baseUrl, undefined);
  assert.ok(ph.problems.some((p) => p.startsWith('env_override_incomplete')));
});

test('env 逃生舱：协议随端点一起切（不得沿用服务商侧旧协议）', () => {
  // 复审实测的缺陷：服务商 kind=anthropic + env 端点指向 OpenAI 端点时，
  // cfg.baseUrl 已切换而 cfg.protocol 仍停在 anthropic → key 会以 x-api-key
  // 发到 OpenAI 端点（与"端点/key 交叉"同类）。协议必须一起切。
  const file = zcodeFixtureFile(tmpRoot());
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ zcodeProvider: 'prov-anthropic' }));
  const cfg = loadConfig(root, hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: file,
    ZCODE_ADVISOR_BASE_URL: 'https://openai.example/v1',
    ZCODE_ADVISOR_API_KEY: 'sk-openai-env-key'
  }));
  assert.strictEqual(cfg.baseUrl, 'https://openai.example/v1');
  assert.strictEqual(cfg.protocol, 'openai', 'env 端点非 /messages 结尾 → 协议必须切回 openai');

  // env 端点以 /messages 结尾 → 推断为 anthropic
  const ant = loadConfig(root, hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: file,
    ZCODE_ADVISOR_BASE_URL: 'https://anthropic.example/v1/messages',
    ZCODE_ADVISOR_API_KEY: 'sk-ant-env-key'
  }));
  assert.strictEqual(ant.protocol, 'anthropic');

  // 显式 ZCODE_ADVISOR_PROTOCOL 优先
  const explicit = loadConfig(root, hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: file,
    ZCODE_ADVISOR_BASE_URL: 'https://weird.example/v1',
    ZCODE_ADVISOR_API_KEY: 'sk-weird-env-key',
    ZCODE_ADVISOR_PROTOCOL: 'anthropic'
  }));
  assert.strictEqual(explicit.protocol, 'anthropic', '显式 protocol 应生效');
});

// —— 回归：provider_config.json 是第二个数据源，漏读会看不到「界面新建的服务商」 ——
// 用户实测报障「抓不到我 zcode 里所有第三方 api」：内网 workbuddy 只存在于
// provider_config.json（providerId='new-provider'），config.json 里没有它。
test('readZcodeProviders：合并 provider_config.json（界面新建的服务商只写在那里）', () => {
  const dir = tmpRoot();
  const cfgFile = path.join(dir, 'config.json');
  const pcFile = path.join(dir, 'provider_config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    provider: {
      'uuid-old': {
        name: '老服务商', kind: 'openai-compatible',
        options: { baseURL: 'http://old/v1', apiKey: 'sk-old-key-1234' },
        models: { 'm-old': {} }
      }
    }
  }));
  fs.writeFileSync(pcFile, JSON.stringify({
    config: { providerConfigRules: { providerRules: [
      // 新数据源独有：config.json 里完全没有
      { providerId: 'new-provider', providerName: 'workbuddy',
        config: { group: 'standard-personal',
          access: { type: 'api-key', apiKey: 'sk-wb-key-5678' },
          api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:18787/v1' },
          personalModelIds: ['deepseek-v4.1-flash', 'glm-5.3-flash'] } },
      // 与 config.json 重叠：模型清单更全，应补全而非丢弃
      { providerId: 'uuid-old', providerName: '老服务商',
        config: { access: { type: 'api-key', apiKey: 'sk-old-key-1234' },
          api: { type: 'openai-chat-completions', baseUrl: 'http://old/v1' },
          personalModelIds: ['m-old', 'm-new-extra'] } },
      // anthropic-messages：0.2.20 起受支持（protocol 归一化为 anthropic）
      { providerId: 'new-provider-2', providerName: 'AIPM',
        config: { access: { type: 'api-key', apiKey: 'sk-ant-999' },
          api: { type: 'anthropic-messages', baseUrl: 'https://aipm.example' },
          personalModelIds: ['claude-x'] } }
    ] } }
  }));

  const list = listZcodeProviders({
    ZCODE_ADVISOR_ZCODE_CONFIG: cfgFile,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: pcFile
  });
  const wb = list.find((p) => p.name === 'workbuddy');
  assert.ok(wb, '必须能发现只存在于 provider_config.json 的服务商');
  assert.strictEqual(wb.baseURL, 'http://127.0.0.1:18787/v1');
  assert.strictEqual(wb.eligible, true, 'openai-chat-completions 必须判为可用（= 界面的 openai-compatible）');
  assert.strictEqual(wb.hasApiKey, true);
  assert.deepStrictEqual(wb.models, ['deepseek-v4.1-flash', 'glm-5.3-flash']);

  const old = list.find((p) => p.id === 'uuid-old');
  assert.deepStrictEqual(old.models, ['m-old', 'm-new-extra'],
    '重叠项的模型清单应取并集（provider_config 侧更全）');

  const aipm = list.find((p) => p.name === 'AIPM');
  assert.strictEqual(aipm.eligible, true, 'anthropic-messages 自 0.2.20 起可用（走 /v1/messages）');
  assert.strictEqual(aipm.protocol, 'anthropic');

  assert.strictEqual(list.length, 3, '不应重复列出重叠项');
  assert.strictEqual(JSON.stringify(list).includes('sk-wb-key'), false, '列表不得携带 key 明文');
});

test('readZcodeProviders：provider_config.json 缺失/损坏时只返回 config.json 的结果', () => {
  const dir = tmpRoot();
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    provider: { 'p1': { name: 'A', kind: 'openai', options: { baseURL: 'http://a/v1', apiKey: 'sk-a-1234' }, models: { m: {} } } }
  }));
  const list = listZcodeProviders({
    ZCODE_ADVISOR_ZCODE_CONFIG: cfgFile,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(dir, 'does-not-exist.json')
  });
  assert.strictEqual(list.length, 1, '第二个源不可用时应正常降级，不抛错、不挂空条目');
});
