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
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(os.tmpdir(), `zcadv-no-zcode-${Date.now()}.json`)
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

test('服务商解析：协议不兼容/官方内置/找不到时都不产出凭据（防密钥交叉）', () => {
  const file = zcodeFixtureFile(tmpRoot());
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    zcodeProvider: 'prov-anthropic', model: 'manual-model'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  // 不兼容 → 不产出 baseUrl/apiKey（旧版会回退手动值 = 密钥交叉面）
  assert.strictEqual(cfg.baseUrl, undefined);
  assert.strictEqual(cfg.apiKey, undefined);
  assert.ok(cfg.problems.some((p) => p.startsWith('zcode_provider_ineligible')));

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

test('listZcodeProviders：剔除 apiKey 明文并给出 eligible/official/hasApiKey 标记', () => {
  const file = zcodeFixtureFile(tmpRoot());
  const list = listZcodeProviders({ ZCODE_ADVISOR_ZCODE_CONFIG: file });
  assert.strictEqual(list.length, 3);
  const p3p = list.find((p) => p.id === 'prov-3p');
  assert.strictEqual(p3p.eligible, true);
  assert.strictEqual(p3p.official, false);
  assert.strictEqual(p3p.hasApiKey, true);
  assert.strictEqual('apiKey' in p3p, false, '列表不得携带 apiKey 明文');
  assert.deepStrictEqual(p3p.models, ['glm-5.3-flash', 'kimi-k3']);
  const pant = list.find((p) => p.id === 'prov-anthropic');
  assert.strictEqual(pant.eligible, false);
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
  const list = listZcodeProviders({ ZCODE_ADVISOR_ZCODE_CONFIG: file });
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
