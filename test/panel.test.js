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

test('mergeUserConfig：只覆盖 GUI 提供的字段，其余保留', () => {
  const merged = mergeUserConfig(
    { apiKey: 'old', maxTokens: 4096, systemPrompt: 'keep me' },
    { apiKey: 'new', model: 'glm-5.3' }
  );
  assert.strictEqual(merged.apiKey, 'new');
  assert.strictEqual(merged.model, 'glm-5.3');
  assert.strictEqual(merged.maxTokens, 4096);
  assert.strictEqual(merged.systemPrompt, 'keep me');
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
