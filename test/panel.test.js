'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.ZCODE_ADVISOR_PANEL_NO_OPEN = '1';
process.env.ZCODE_ADVISOR_PANEL_PORT = '8799';
process.env.ZCODE_ADVISOR_USER_CONFIG = path.join(os.tmpdir(), `zcadv-panel-${Date.now()}`, 'advisor.config.json');

const { guiValuesFromEnv, mergeUserConfig, writeUserConfig, USER_CONFIG } = require('../tools/config-bridge');
const panelServer = require('../tools/setup-server.js');

test.after(() => {
  try {
    panelServer.close();
    if (panelServer.closeAllConnections) panelServer.closeAllConnections();
  } catch (_) {}
});

test('guiValuesFromEnv：跳过空值与字面模板串', () => {
  const v = guiValuesFromEnv({
    ZCODE_ADVISOR_CFG_API_KEY: '  real-key-123  ',
    ZCODE_ADVISOR_CFG_MODEL: '',
    ZCODE_ADVISOR_CFG_ZCODE_PROVIDER: '${user_config.zcode_provider}',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: 'sync'
  });
  assert.deepStrictEqual(v, { reviewMode: 'sync' });
});

test('guiValuesFromEnv：0.2.17 起不再收集端点/key（插件不维护凭据）', () => {
  const v = guiValuesFromEnv({
    ZCODE_ADVISOR_CFG_API_KEY: 'sk-should-be-ignored',
    ZCODE_ADVISOR_CFG_BASE_URL: 'http://manual.example/v1',
    ZCODE_ADVISOR_CFG_API_SOURCE: 'manual',
    ZCODE_ADVISOR_CFG_ZCODE_PROVIDER: 'prov-3p',
    ZCODE_ADVISOR_CFG_MODEL: 'glm-5.3'
  });
  assert.deepStrictEqual(v, { zcodeProvider: 'prov-3p', model: 'glm-5.3' });
});

test('mergeUserConfig：默认覆盖语义（显式保存路径），GUI 提供的字段生效、其余保留', () => {
  const merged = mergeUserConfig(
    { model: 'old', maxTokens: 4096, systemPrompt: 'keep me' },
    { model: 'glm-5.3', zcodeProvider: 'prov-3p' }
  );
  assert.strictEqual(merged.model, 'glm-5.3');
  assert.strictEqual(merged.zcodeProvider, 'prov-3p');
  assert.strictEqual(merged.maxTokens, 4096);
  assert.strictEqual(merged.systemPrompt, 'keep me');
});

// 回归：真机实测中 config-bridge 每次会话启动都把用户级配置静默改回表单默认值。
// 0.2.17 起表单只剩服务商/模型/模式——只兜底纪律同样适用。
test('mergeUserConfig：fillMissingOnly 只填补缺失键，绝不覆盖已有非空值', () => {
  const merged = mergeUserConfig(
    {
      zcodeProvider: 'prov-user',
      model: 'kimi-k3',
      maxTokens: 4096
    },
    {
      zcodeProvider: 'prov-form-default',
      model: 'glm-5.3-flash',
      reviewMode: 'async'
    },
    { fillMissingOnly: true }
  );
  assert.strictEqual(merged.zcodeProvider, 'prov-user');
  assert.strictEqual(merged.model, 'kimi-k3');
  assert.strictEqual(merged.maxTokens, 4096);
  assert.strictEqual(merged.reviewMode, 'async');
});

test('mergeUserConfig：fillMissingOnly 把空串/null 视为缺失键', () => {
  const merged = mergeUserConfig(
    { zcodeProvider: '   ', model: null },
    { zcodeProvider: 'prov-3p', model: 'glm-5.3' },
    { fillMissingOnly: true }
  );
  assert.strictEqual(merged.zcodeProvider, 'prov-3p');
  assert.strictEqual(merged.model, 'glm-5.3');
});

test('writeUserConfig：fillMissingOnly 下无可填补键时不写盘（不污染配置 mtime）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-bridge-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  fs.writeFileSync(file, JSON.stringify({ zcodeProvider: 'prov-user' }), 'utf8');
  const gui = { zcodeProvider: 'prov-form-default', model: 'glm-5.3-flash' };
  const opts = { fillMissingOnly: true };

  const r1 = writeUserConfig(gui, file, opts);
  assert.strictEqual(r1.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.zcodeProvider, 'prov-user');
  assert.strictEqual(saved.model, 'glm-5.3-flash');

  const r2 = writeUserConfig(gui, file, opts);
  assert.strictEqual(r2.changed, false);
});

test('writeUserConfig：原子合并写入，空 GUI 值不产生写动作', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-panel-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  fs.writeFileSync(file, JSON.stringify({ maxTokens: 4096 }), 'utf8');
  const r1 = writeUserConfig({ zcodeProvider: 'prov-3p', model: 'glm-5.3' }, file);
  assert.strictEqual(r1.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.zcodeProvider, 'prov-3p');
  assert.strictEqual(saved.maxTokens, 4096);

  const r2 = writeUserConfig({}, file);
  assert.strictEqual(r2.changed, false);
});

test('writeUserConfig：写入时清除旧版手动端点/key 残留（防密钥交叉 + 明文留盘）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-legacy-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  fs.writeFileSync(file, JSON.stringify({
    apiKey: 'sk-legacy-plaintext', baseUrl: 'http://manual.example/v1',
    apiSource: 'manual', zcodeModel: 'legacy-model', model: 'glm-5.3'
  }), 'utf8');
  const r = writeUserConfig({ zcodeProvider: 'prov-3p' }, file);
  assert.strictEqual(r.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['apiKey', 'baseUrl', 'apiSource', 'zcodeModel']) {
    assert.strictEqual(saved[k], undefined, `旧版残留 ${k} 应被清除`);
  }
  assert.strictEqual(saved.model, 'glm-5.3');
  assert.strictEqual(saved.zcodeProvider, 'prov-3p');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-legacy-plaintext'), '明文 key 不得留在盘上');
});

test('配置面板 HTTP：页面与保存接口', async (t) => {
  // 先清掉可能存在的用户级配置，保证断言确定性
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}

  const baseUrl = 'http://127.0.0.1:8799';
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      const r = await fetch(baseUrl + '/');
      up = r.status === 200;
    } catch (_) {
      await new Promise((r2) => setTimeout(r2, 100));
    }
  }
  assert.ok(up, '面板应在 8799 端口就绪');

  const html = await (await fetch(baseUrl + '/')).text();
  assert.ok(html.includes('zcode-advisor 配置面板'));
  // 0.2.17：本面板不再收集端点/key（一律来自 ZCode 服务商）
  assert.ok(html.includes('服务商'), '页面应有服务商选择');
  assert.ok(!html.includes('id="apiKey"'), '页面不应再有 API key 输入框');

  const saveRes = await (await fetch(baseUrl + '/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zcodeProvider: 'prov-3p', model: 'glm-5.3', maxTokens: 4096 })
  })).json();
  assert.strictEqual(saveRes.ok, true);

  const saved = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved.zcodeProvider, 'prov-3p');
  assert.strictEqual(saved.model, 'glm-5.3');
  assert.strictEqual(saved.maxTokens, 4096);
});

test('配置面板 HTTP：一次保存恰好一次原子落盘（单次 RMW，锁/重试不产生额外写）', async () => {
  // 审计 A1：maxTokens 曾在保存后再读一次再写一次（两次独立 RMW）。修正后必须恰好一次；
  // 本轮加的跨进程锁只增删 .lock 文件（不 rename），rename 重试也只对同一次落盘生效。
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  const origRename = fs.renameSync;
  let configRenames = 0;
  fs.renameSync = function (a, b) {
    if (String(a).includes('.tmp-')) configRenames++;
    return origRename.call(fs, a, b);
  };
  try {
    const saveRes = await (await fetch('http://127.0.0.1:8799/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', maxTokens: 4096 })
    })).json();
    assert.strictEqual(saveRes.ok, true, `保存应成功：${JSON.stringify(saveRes)}`);
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(configRenames, 1, '一次 /api/save 应恰好一次 tmp→目标 rename');
});

test('guiValuesFromEnv：旧版端点/来源环境变量一律忽略（0.2.17 不再有这些键）', () => {
  // 回归：≤0.2.7 的 plugin.json 把官方端点写成 userConfig default，宿主展开进 env 后
  // 桥接落盘，覆盖用户的第三方端点。0.2.17 起这些键在 map 里已不存在 → 直接忽略。
  const v = guiValuesFromEnv({
    ZCODE_ADVISOR_CFG_API_KEY: 'sk-old-key',
    ZCODE_ADVISOR_CFG_MODEL: 'glm-5.3-flash',
    ZCODE_ADVISOR_CFG_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ZCODE_ADVISOR_CFG_API_SOURCE: 'zcode',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: ''
  });
  assert.deepStrictEqual(v, { model: 'glm-5.3-flash' });
});

test('配置面板 HTTP：只接受白名单键，旧版 apiSource/zcodeModel 被丢弃', async () => {
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  const res = await (await fetch('http://127.0.0.1:8799/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiSource: 'zcode', zcodeProvider: 'prov-1', zcodeModel: 'm-1', apiSourceBad: 'x' })
  })).json();
  assert.strictEqual(res.ok, true);
  const saved = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved.zcodeProvider, 'prov-1');
  // 旧键不再是可保存键：即便 POST 里带了也不落盘（防旧前端/旧缓存写回）
  assert.strictEqual(saved.apiSource, undefined);
  assert.strictEqual(saved.zcodeModel, undefined);
  assert.strictEqual(saved.apiSourceBad, undefined);
});

test('配置面板 HTTP：/api/zcode-models 返回服务商模型清单（不含 apiKey）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-panel-v2-'));
  const v2file = path.join(dir, 'v2-config.json');
  fs.writeFileSync(v2file, JSON.stringify({ provider: {
    prov1: { name: '网关', kind: 'openai-compatible', options: { baseURL: 'http://10.0.0.8:8088/v1', apiKey: 'sk-secret' }, models: { 'm-a': {}, 'm-b': {} } }
  } }));
  const origEnv = process.env.ZCODE_ADVISOR_ZCODE_CONFIG;
  process.env.ZCODE_ADVISOR_ZCODE_CONFIG = v2file;
  try {
    const r = await (await fetch('http://127.0.0.1:8799/api/zcode-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'prov1' })
    })).json();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.models, ['m-a', 'm-b']);
    assert.strictEqual(r.baseURL, 'http://10.0.0.8:8088/v1');
    assert.strictEqual(JSON.stringify(r).includes('sk-secret'), false, '响应不得携带 apiKey 明文');
  } finally {
    if (origEnv === undefined) delete process.env.ZCODE_ADVISOR_ZCODE_CONFIG;
    else process.env.ZCODE_ADVISOR_ZCODE_CONFIG = origEnv;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('配置面板页面：只有服务商/模型区，没有 API 来源分段', async () => {
  const html = await (await fetch('http://127.0.0.1:8799/')).text();
  for (const marker of ['zcodeProvider', 'zcodeModel', '启用', '审查模式']) {
    assert.ok(html.includes(marker), `页面应包含 ${marker}`);
  }
  // 取消第三方 API 适配：手动端点/来源分段必须消失
  for (const gone of ['src-zcode', 'src-manual', 'API 来源', 'id="baseUrl"', 'id="apiKey"']) {
    assert.ok(!html.includes(gone), `页面不应再包含 ${gone}（0.2.17 取消手动 API 维护）`);
  }
});

// —— 延期项 D1：/api/clear-key ——

async function postJson(url, body) {
  return fetch('http://127.0.0.1:8799' + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

test('配置面板 HTTP：clear-key 端点保留（清理旧版残留 key，幂等）', async () => {
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  const post = (url, body, origin) => fetch('http://127.0.0.1:8799' + url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? { Origin: origin } : {}),
    body: JSON.stringify(body || {})
  });

  // 0.2.17：本插件不再维护 key，页面上没有「清除 key」按钮；
  // 端点保留只为清理历史遗留残留（升级用户的旧配置里可能还有明文 key）。
  const html = await (await fetch('http://127.0.0.1:8799/')).text();
  assert.ok(!html.includes('id="apiKey"'), '页面不应再有 key 输入框');

  const r1 = await (await post('/api/clear-key', {})).json();
  assert.strictEqual(r1.ok, true, '配置不存在时也应 ok（幂等）');

  // 直接造一份含旧 key 的配置，验证端点确实能清掉
  fs.writeFileSync(USER_CONFIG, JSON.stringify({ apiKey: 'to-be-cleared', model: 'glm-5.3' }), 'utf8');
  const r2 = await (await post('/api/clear-key', {})).json();
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(r2.removed, ['apiKey']);
  const saved = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved.apiKey, undefined);
  assert.strictEqual(saved.model, 'glm-5.3', '兄弟键必须保留');
});

test('配置面板 HTTP：clear-key 拒绝非本机来源（403 JSON）', async () => {
  const r = await fetch('http://127.0.0.1:8799/api/clear-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}'
  });
  assert.strictEqual(r.status, 403);
  const body = await r.json();
  assert.strictEqual(body.ok, false);
  assert.ok(body.error, '错误必须是 JSON（前端按 ok 分红绿条）');
});

test('配置面板 HTTP：clear-key 拒绝非 JSON body（400，不执行删除）', async () => {
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  fs.writeFileSync(USER_CONFIG, JSON.stringify({ apiKey: 'keep-me' }), 'utf8');
  const r = await fetch('http://127.0.0.1:8799/api/clear-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json{{'
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).ok, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8')).apiKey, 'keep-me',
    '非法 body 不得触发删除');
});

test('writeUserConfig：空 GUI 值 + 只含旧 apiKey 的配置 → 仍会清理（升级用户不再长期留明文）', () => {
  // 回归（独立模型评审 high）：早退守卫曾让 `values` 为空时直接 return，
  // 而桥接在没收到 CFG_* 环境变量时 values 就是空——0.2.16 升级用户的配置里
  // 只剩 {apiKey}，于是 legacy 清理永不执行、明文 key 长期留盘。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-legacy-empty-'));
  const file = path.join(dir, 'advisor.config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'sk-LEGACY-PLAINTEXT' }), 'utf8');
    const r = writeUserConfig({}, file);
    assert.strictEqual(r.changed, true, '清理应产生写动作');
    const saved = fs.readFileSync(file, 'utf8');
    assert.ok(!saved.includes('sk-LEGACY-PLAINTEXT'), '明文 key 必须被清除');
    assert.strictEqual(JSON.parse(saved).apiKey, undefined);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('配置面板页面：已保存的服务商不可用时显式提示（不静默换成列表第一项）', async () => {
  // 真正触发该分支：配置里写一个「存在但不满足条件」的服务商（缺 key），
  // 页面会把它从下拉里 filter 掉、选中值落到 providers[0]。必须显式告知，
  // 否则用户不动它一保存就把选择改掉了、还以为没动过。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-missing-prov-'));
  const v2file = path.join(dir, 'v2.json');
  fs.writeFileSync(v2file, JSON.stringify({ provider: {
    'no-key': { name: '缺key网', kind: 'openai-compatible',
      options: { baseURL: 'http://10.0.0.9:8080/v1' }, models: { 'm-a': {} } },
    'ok': { name: '可用网', kind: 'openai-compatible',
      options: { baseURL: 'http://10.0.0.8:8088/v1', apiKey: 'sk-ok' }, models: { 'm-b': {} } }
  } }), 'utf8');
  const prevZ = process.env.ZCODE_ADVISOR_ZCODE_CONFIG;
  const prevCfg = fs.existsSync(USER_CONFIG) ? fs.readFileSync(USER_CONFIG, 'utf8') : null;
  process.env.ZCODE_ADVISOR_ZCODE_CONFIG = v2file;
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify({ zcodeProvider: 'no-key' }), 'utf8');
    const html = await (await fetch('http://127.0.0.1:8799/')).text();
    assert.ok(html.includes('no-key'), `应点名那个不可用的服务商：\n${html.slice(0, 500)}`);
    assert.ok(/缺 key|不可用/.test(html), '应说明原因（缺 key / 不可用）');
    assert.ok(/保存.*换|换成列表/.test(html), '应警示"不改动就保存会替换选择"');
  } finally {
    if (prevZ === undefined) delete process.env.ZCODE_ADVISOR_ZCODE_CONFIG;
    else process.env.ZCODE_ADVISOR_ZCODE_CONFIG = prevZ;
    if (prevCfg === null) { try { fs.unlinkSync(USER_CONFIG); } catch (_) {} }
    else fs.writeFileSync(USER_CONFIG, prevCfg, 'utf8');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
