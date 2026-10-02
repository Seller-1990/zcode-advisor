'use strict';

// controller.cjs 的 zcode 数据源与 effectiveTarget 行为测试。
// controller 在 require 时固化 USER_CONFIG（模块常量），必须先设 env 再 require；
// node --test 每个文件独立进程，env 污染不会跨文件扩散。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-companion-'));
const USER_CFG = path.join(dir, 'advisor.config.json');
const V2_CFG = path.join(dir, 'v2-config.json');
process.env.ZCODE_ADVISOR_USER_CONFIG = USER_CFG;
process.env.ZCODE_ADVISOR_ZCODE_CONFIG = V2_CFG;
fs.writeFileSync(V2_CFG, JSON.stringify({
  provider: {
    p1: {
      name: '内网网关', kind: 'openai-compatible',
      options: { baseURL: 'http://10.0.0.8:8088/v1', apiKey: 'sk-gw' },
      models: { 'm-a': {}, 'm-b': {} }
    },
    p2: {
      name: 'Anthropic 中转', kind: 'anthropic',
      options: { baseURL: 'https://r.example', apiKey: 'sk-a' },
      models: { claude: {} }
    }
  }
}));

const controller = require('../tools/companion/controller.cjs');

test('readZcodeProviders：解析 provider 字段并标记协议合格性', () => {
  const list = controller.readZcodeProviders();
  assert.strictEqual(list.length, 2);
  const p1 = list.find((p) => p.id === 'p1');
  assert.strictEqual(p1.eligible, true);
  assert.strictEqual(p1.baseURL, 'http://10.0.0.8:8088/v1');
  assert.deepStrictEqual(p1.models, ['m-a', 'm-b']);
  assert.strictEqual(list.find((p) => p.id === 'p2').eligible, false);
});

test('effectiveTarget：manual 沿用 body > 已存配置覆盖链', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ baseUrl: 'http://manual.example/v1', apiKey: 'k-manual', model: 'm-manual' }));
  const fromCfg = controller.effectiveTarget({});
  assert.deepStrictEqual(
    [fromCfg.apiSource, fromCfg.baseUrl, fromCfg.apiKey, fromCfg.model],
    ['manual', 'http://manual.example/v1', 'k-manual', 'm-manual']
  );
  const fromBody = controller.effectiveTarget({ baseUrl: 'http://form.example/v1', model: 'm-form' });
  assert.strictEqual(fromBody.baseUrl, 'http://form.example/v1');
  assert.strictEqual(fromBody.model, 'm-form');
});

test('effectiveTarget：zcode 从 provider 现读端点/key/模型（key 只在本进程内使用）', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ apiSource: 'zcode', zcodeProvider: '内网网关', zcodeModel: 'm-b' }));
  const zc = controller.effectiveTarget({});
  assert.strictEqual(zc.apiSource, 'zcode');
  assert.strictEqual(zc.providerFound, true);
  assert.strictEqual(zc.providerName, '内网网关'); // 容忍写名称
  assert.strictEqual(zc.baseUrl, 'http://10.0.0.8:8088/v1');
  assert.strictEqual(zc.apiKey, 'sk-gw');
  assert.strictEqual(zc.model, 'm-b');

  // 模型留空 → 取 provider 列表首项
  fs.writeFileSync(USER_CFG, JSON.stringify({ apiSource: 'zcode', zcodeProvider: 'p1' }));
  assert.strictEqual(controller.effectiveTarget({}).model, 'm-a');

  // 找不到 provider：providerFound=false，ping 侧据此给可操作错误
  fs.writeFileSync(USER_CFG, JSON.stringify({ apiSource: 'zcode', zcodeProvider: 'nope' }));
  const miss = controller.effectiveTarget({});
  assert.strictEqual(miss.providerFound, false);
  assert.strictEqual(miss.baseUrl, '');
});

test('saveUserConfig：apiSource 只认 manual/zcode，zcode 键照常落盘', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({}));
  const merged = controller.saveUserConfig({ apiSource: 'zcode', zcodeProvider: 'p1', zcodeModel: 'm-a', startEnabled: false });
  assert.strictEqual(merged.apiSource, 'zcode');
  assert.strictEqual(merged.zcodeProvider, 'p1');
  assert.strictEqual(merged.zcodeModel, 'm-a');
  assert.strictEqual(merged.startEnabled, false);
  const bad = controller.saveUserConfig({ apiSource: 'BOTH' });
  assert.strictEqual(bad.apiSource, 'zcode', '非法 apiSource 应被丢弃，不影响既有值');
});
