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

// 隔离用户级配置：测试不得读本机真实 ~/.zcode/advisor.config.json
function hermeticEnv(extra) {
  return Object.assign({ ZCODE_ADVISOR_USER_CONFIG: path.join(os.tmpdir(), `zcadv-no-user-${Date.now()}.json`) }, extra);
}

test('无配置文件时返回内置默认值', () => {
  const cfg = loadConfig(tmpRoot(), hermeticEnv());
  assert.strictEqual(cfg.model, 'glm-5.3-flash');
  assert.strictEqual(cfg.immuneTurns, 3);
  assert.strictEqual(cfg.proseFallback, true);
  assert.deepStrictEqual(cfg.problems, []);
  assert.deepStrictEqual(cfg.configSources, []);
});

test('配置文件覆盖默认值，环境变量再覆盖配置文件', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ model: 'glm-5.3', immuneTurns: 5 }));
  const cfg = loadConfig(root, hermeticEnv());
  assert.strictEqual(cfg.model, 'glm-5.3');
  assert.strictEqual(cfg.immuneTurns, 5);
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
  assert.strictEqual(cfg.apiKey, 'user-key-abc');
  assert.deepStrictEqual(cfg.configSources, ['plugin:advisor.config.json', 'user:~/.zcode/advisor.config.json']);
});

test('损坏的配置文件降级为默认值，且 problems 被记录（可被 status 消费）', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), '{not json');
  const cfg = loadConfig(root, hermeticEnv());
  assert.strictEqual(cfg.model, 'glm-5.3-flash');
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
  assert.strictEqual(asyncCfg.problems.length, 0);
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

// —— apiSource=zcode：读取 ZCode 已维护的第三方 API ——

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
      }
    }
  }));
  return file;
}

test('apiSource=zcode：provider 解析覆盖 baseUrl/apiKey/model，模型留空取列表首项', () => {
  const root = tmpRoot();
  const dir = tmpRoot();
  const file = zcodeFixtureFile(dir);
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    apiSource: 'zcode',
    zcodeProvider: 'prov-3p',
    baseUrl: 'http://manual.example/v1',
    apiKey: 'manual-key'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.baseUrl, 'http://192.168.50.139:8088/v1');
  assert.strictEqual(cfg.apiKey, 'sk-3p-key');
  assert.strictEqual(cfg.model, 'glm-5.3-flash'); // zcodeModel 留空 → 列表首项
  assert.strictEqual(cfg.apiSource, 'zcode');
  assert.match(cfg.apiSourceLabel, /ZCode 已维护（第三方网关）/);
  assert.ok(cfg.configSources.includes('zcode-provider:第三方网关'));
  const keyInfo = resolveApiKey(cfg, {});
  assert.strictEqual(keyInfo.key, 'sk-3p-key');
  assert.strictEqual(keyInfo.source, 'config');
});

test('apiSource=zcode：显式 zcodeModel 即使不在列表也尊重（列表可能滞后）', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    apiSource: 'zcode', zcodeProvider: 'prov-3p', zcodeModel: 'deepseek-v4-pro-0813'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.model, 'deepseek-v4-pro-0813');
});

test('apiSource=zcode：环境变量仍优先于 zcode 解析（env 是显式覆盖）', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    apiSource: 'zcode', zcodeProvider: 'prov-3p'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file, ZCODE_ADVISOR_MODEL: 'env-model' }));
  assert.strictEqual(cfg.model, 'env-model');
  assert.strictEqual(cfg.baseUrl, 'http://192.168.50.139:8088/v1');
});

test('apiSource=zcode：provider 缺失/协议不兼容时沿用手动值并挂 problems（降级不静默）', () => {
  const root = tmpRoot();
  const file = zcodeFixtureFile(tmpRoot());
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({
    apiSource: 'zcode', zcodeProvider: 'prov-anthropic',
    baseUrl: 'http://manual.example/v1', model: 'manual-model', apiKey: 'manual-key'
  }));
  const cfg = loadConfig(root, hermeticEnv({ ZCODE_ADVISOR_ZCODE_CONFIG: file }));
  assert.strictEqual(cfg.baseUrl, 'http://manual.example/v1');
  assert.strictEqual(cfg.model, 'manual-model');
  assert.ok(cfg.problems.some((p) => p.startsWith('zcode_provider_ineligible')));

  // zcodeProvider 未指定：找不到 → 登记 missing（换干净的插件目录，避免上层配置残留 provider）
  const userCfg = path.join(tmpRoot(), 'user-zcode.json');
  fs.writeFileSync(userCfg, JSON.stringify({ apiSource: 'zcode' }));
  const cfg2 = loadConfig(tmpRoot(), hermeticEnv({
    ZCODE_ADVISOR_ZCODE_CONFIG: file,
    ZCODE_ADVISOR_USER_CONFIG: userCfg
  }));
  assert.ok(cfg2.problems.some((p) => p.startsWith('zcode_provider_missing')));
});

test('apiSource 脏值归一为 manual 并登记', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ apiSource: 'ZCODE2' }));
  const cfg = loadConfig(root, hermeticEnv());
  assert.strictEqual(cfg.apiSource, 'manual');
  assert.strictEqual(cfg.apiSourceLabel, '手动维护');
  assert.ok(cfg.problems.some((p) => p.startsWith('config_normalized')));
});

test('listZcodeProviders：剔除 apiKey 明文并给出 eligible/hasApiKey 标记', () => {
  const file = zcodeFixtureFile(tmpRoot());
  const list = listZcodeProviders({ ZCODE_ADVISOR_ZCODE_CONFIG: file });
  assert.strictEqual(list.length, 2);
  const p3p = list.find((p) => p.id === 'prov-3p');
  assert.strictEqual(p3p.eligible, true);
  assert.strictEqual(p3p.hasApiKey, true);
  assert.strictEqual('apiKey' in p3p, false, '列表不得携带 apiKey 明文');
  assert.deepStrictEqual(p3p.models, ['glm-5.3-flash', 'kimi-k3']);
  const pant = list.find((p) => p.id === 'prov-anthropic');
  assert.strictEqual(pant.eligible, false);
});
