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
    ZCODE_ADVISOR_CFG_BASE_URL: '${user_config.base_url}',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: 'sync'
  });
  assert.deepStrictEqual(v, { apiKey: 'real-key-123', reviewMode: 'sync' });
});

test('mergeUserConfig：默认覆盖语义（显式保存路径），GUI 提供的字段生效、其余保留', () => {
  const merged = mergeUserConfig(
    { apiKey: 'old', maxTokens: 4096, systemPrompt: 'keep me' },
    { apiKey: 'new', model: 'glm-5.3' }
  );
  assert.strictEqual(merged.apiKey, 'new');
  assert.strictEqual(merged.model, 'glm-5.3');
  assert.strictEqual(merged.maxTokens, 4096);
  assert.strictEqual(merged.systemPrompt, 'keep me');
});

// 回归：真机实测中 config-bridge 每次会话启动都把用户级 baseUrl 静默改回表单默认端点，
// 导致 tokenrhythm 的 key 打到 bigmodel 端点 → llm_http_401。
test('mergeUserConfig：fillMissingOnly 只填补缺失键，绝不覆盖已有非空值', () => {
  const merged = mergeUserConfig(
    {
      apiKey: 'user-key',
      baseUrl: 'https://tokenrhythm.studio/v1/chat/completions',
      maxTokens: 4096
    },
    {
      apiKey: 'user-key',
      model: 'glm-5.3-flash',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      reviewMode: 'async'
    },
    { fillMissingOnly: true }
  );
  assert.strictEqual(merged.baseUrl, 'https://tokenrhythm.studio/v1/chat/completions');
  assert.strictEqual(merged.apiKey, 'user-key');
  assert.strictEqual(merged.maxTokens, 4096);
  assert.strictEqual(merged.model, 'glm-5.3-flash');
  assert.strictEqual(merged.reviewMode, 'async');
});

test('mergeUserConfig：fillMissingOnly 把空串/null 视为缺失键', () => {
  const merged = mergeUserConfig(
    { baseUrl: '   ', model: null },
    { baseUrl: 'https://x.example/v1', model: 'glm-5.3' },
    { fillMissingOnly: true }
  );
  assert.strictEqual(merged.baseUrl, 'https://x.example/v1');
  assert.strictEqual(merged.model, 'glm-5.3');
});

test('writeUserConfig：fillMissingOnly 下无可填补键时不写盘（不污染配置 mtime）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-bridge-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://user.example/v1', apiKey: 'k' }), 'utf8');
  const gui = { baseUrl: 'https://default.example/v1', apiKey: 'k', model: 'glm-5.3-flash' };
  const opts = { fillMissingOnly: true };

  const r1 = writeUserConfig(gui, file, opts);
  assert.strictEqual(r1.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.baseUrl, 'https://user.example/v1');
  assert.strictEqual(saved.model, 'glm-5.3-flash');

  const r2 = writeUserConfig(gui, file, opts);
  assert.strictEqual(r2.changed, false);
});

test('writeUserConfig：原子合并写入，空 GUI 值不产生写动作', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-panel-'));
  const file = path.join(dir, 'advisor.config.json');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  fs.writeFileSync(file, JSON.stringify({ maxTokens: 4096 }), 'utf8');
  const r1 = writeUserConfig({ apiKey: 'panel-key-1', model: 'glm-5.3' }, file);
  assert.strictEqual(r1.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.apiKey, 'panel-key-1');
  assert.strictEqual(saved.maxTokens, 4096);

  const r2 = writeUserConfig({}, file);
  assert.strictEqual(r2.changed, false);
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
  assert.ok(html.includes('API key'));

  const saveRes = await (await fetch(baseUrl + '/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'panel-key-xyz', model: 'glm-5.3', maxTokens: 4096 })
  })).json();
  assert.strictEqual(saveRes.ok, true);

  const saved = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved.apiKey, 'panel-key-xyz');
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

<<<<<<< HEAD
test('guiValuesFromEnv：旧版默认的智谱端点视为未配置（防「第三方端点被改回智谱」复发）', () => {
  // 回归：≤0.2.7 的 plugin.json 把官方端点写成 userConfig default，宿主展开进 env 后
  // 桥接落盘，覆盖用户的第三方端点。默认值已改空串，这里挡住旧宿主/旧缓存展开出的值。
  const v = guiValuesFromEnv({
    ZCODE_ADVISOR_CFG_API_KEY: '',
    ZCODE_ADVISOR_CFG_MODEL: 'glm-5.3-flash',
    ZCODE_ADVISOR_CFG_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ZCODE_ADVISOR_CFG_REVIEW_MODE: ''
  });
  assert.deepStrictEqual(v, { model: 'glm-5.3-flash' });
});

test('配置面板 HTTP：apiSource/zcode 键可保存，非法 apiSource 被丢弃', async () => {
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  const res = await (await fetch('http://127.0.0.1:8799/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiSource: 'zcode', zcodeProvider: 'prov-1', zcodeModel: 'm-1', apiSourceBad: 'x' })
  })).json();
  assert.strictEqual(res.ok, true);
  const saved = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved.apiSource, 'zcode');
  assert.strictEqual(saved.zcodeProvider, 'prov-1');
  assert.strictEqual(saved.zcodeModel, 'm-1');

  const res2 = await (await fetch('http://127.0.0.1:8799/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiSource: 'BOTH' })
  })).json();
  assert.strictEqual(res2.ok, true);
  const saved2 = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
  assert.strictEqual(saved2.apiSource, 'zcode', '非法 apiSource 应被丢弃，保留既有值');
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

test('配置面板页面：API 来源分段与 zcode 服务商区渲染', async () => {
  const html = await (await fetch('http://127.0.0.1:8799/')).text();
  for (const marker of ['src-zcode', 'src-manual', 'zcodeProvider', 'zcodeModel', 'manualSec', 'API 来源', '启用']) {
    assert.ok(html.includes(marker), `页面应包含 ${marker}`);
  }
=======
// —— 延期项 D1：/api/clear-key ——

async function postJson(url, body) {
  return fetch('http://127.0.0.1:8799' + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

test('配置面板 HTTP：清除 API key（成功分支，页面元素齐备）', async () => {
  try { fs.unlinkSync(USER_CONFIG); } catch (_) {}
  const post = (url, body, origin) => fetch('http://127.0.0.1:8799' + url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? { Origin: origin } : {}),
    body: JSON.stringify(body || {})
  });

  const html = await (await fetch('http://127.0.0.1:8799/')).text();
  assert.ok(html.includes('清除 API key'), '页面应有清除按钮');
  assert.ok(html.includes('/api/clear-key'), '页面应接清除接口');
  assert.ok(html.includes('吊销'), '页面应提示清除≠作废');

  const r1 = await (await post('/api/clear-key', {})).json();
  assert.strictEqual(r1.ok, true, '配置不存在时也应 ok（幂等）');

  await (await post('/api/save', { apiKey: 'to-be-cleared', model: 'glm-5.3' })).json();
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
  await (await postJson('/api/save', { apiKey: 'keep-me' })).json();
  const r = await fetch('http://127.0.0.1:8799/api/clear-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json{{'
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).ok, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8')).apiKey, 'keep-me',
    '非法 body 不得触发删除');
>>>>>>> origin/main
});
