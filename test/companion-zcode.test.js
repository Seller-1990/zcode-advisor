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

test('readZcodeProviders：解析 provider 字段、标记协议合格性与官方内置', () => {
  const list = controller.readZcodeProviders();
  assert.strictEqual(list.length, 2);
  const p1 = list.find((p) => p.id === 'p1');
  assert.strictEqual(p1.eligible, true);
  assert.strictEqual(p1.official, false);
  assert.strictEqual(p1.baseURL, 'http://10.0.0.8:8088/v1');
  assert.deepStrictEqual(p1.models, ['m-a', 'm-b']);
  assert.strictEqual(list.find((p) => p.id === 'p2').eligible, false);
});

test('effectiveTarget：显式服务商 → 现读端点/key/模型（key 只在本进程内使用）', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: '内网网关', model: 'm-b' }));
  const zc = controller.effectiveTarget({});
  assert.strictEqual(zc.providerFound, true);
  assert.strictEqual(zc.providerName, '内网网关'); // 容忍写名称
  assert.strictEqual(zc.baseUrl, 'http://10.0.0.8:8088/v1');
  assert.strictEqual(zc.apiKey, 'sk-gw');
  assert.strictEqual(zc.model, 'm-b');

  // 模型留空 → 取 provider 列表首项
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p1' }));
  assert.strictEqual(controller.effectiveTarget({}).model, 'm-a');

  // 找不到 provider：providerFound=false，ping 侧据此给可操作错误
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'nope' }));
  const miss = controller.effectiveTarget({});
  assert.strictEqual(miss.providerFound, false);
  assert.strictEqual(miss.baseUrl, '');
  assert.strictEqual(miss.providerError, 'provider_not_found');
});

test('effectiveTarget：不兼容/官方内置服务商不产出凭据（防密钥交叉）', () => {
  // 协议不兼容
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p2', model: 'claude' }));
  const ineligible = controller.effectiveTarget({});
  assert.strictEqual(ineligible.providerUsable, false);
  assert.strictEqual(ineligible.baseUrl, '');
  assert.strictEqual(ineligible.providerError, 'provider_ineligible');

  // 官方内置（builtin: 前缀）
  const v2 = JSON.parse(fs.readFileSync(V2_CFG, 'utf8'));
  v2.provider['builtin:bigmodel'] = {
    name: 'BigModel 官方', kind: 'openai',
    options: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-official' },
    models: { 'glm-5.3': {} }
  };
  fs.writeFileSync(V2_CFG, JSON.stringify(v2));
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'builtin:bigmodel' }));
  const official = controller.effectiveTarget({});
  assert.strictEqual(official.providerUsable, false);
  assert.strictEqual(official.baseUrl, '');
  assert.strictEqual(official.apiKey, '');
  assert.strictEqual(official.providerError, 'provider_official');

  // 复原 fixture，避免影响后续用例
  delete v2.provider['builtin:bigmodel'];
  fs.writeFileSync(V2_CFG, JSON.stringify(v2));
});

test('effectiveTarget：未指定服务商 → 自动选择可用第三方并标记 providerAuto', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({}));
  const auto = controller.effectiveTarget({});
  assert.strictEqual(auto.providerId, 'p1', 'p2 不兼容 → 只剩 p1');
  assert.strictEqual(auto.providerAuto, true);
  assert.strictEqual(auto.baseUrl, 'http://10.0.0.8:8088/v1');
});

test('saveUserConfig：只接受白名单键，旧版 apiSource/zcodeModel 被丢弃并清理残留', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ apiKey: 'sk-legacy', baseUrl: 'http://legacy/v1', apiSource: 'manual', zcodeModel: 'old-m' }));
  const merged = controller.saveUserConfig({ zcodeProvider: 'p1', model: 'm-a', startEnabled: false });
  assert.strictEqual(merged.zcodeProvider, 'p1');
  assert.strictEqual(merged.model, 'm-a');
  assert.strictEqual(merged.startEnabled, false);
  // 旧版手动残留写入时一并清除（0.2.17 起插件配置不参与端点/key 解析）
  for (const k of ['apiKey', 'baseUrl', 'apiSource', 'zcodeModel']) {
    assert.strictEqual(merged[k], undefined, `旧键 ${k} 应被清除`);
  }
  const bad = controller.saveUserConfig({ apiSource: 'BOTH', zcodeModel: 'm-x' });
  assert.strictEqual(bad.apiSource, undefined, '非法/旧 apiSource 不应落盘');
  assert.strictEqual(bad.zcodeModel, undefined);
  assert.strictEqual(bad.zcodeProvider, 'p1', '兄弟键不受影响');
});

test('effectiveTarget：「从端点拉取」场景——模型未定时仍必须给出端点/key（否则拉取永远失败）', () => {
  // 回归（OCR high）：baseUrl/apiKey 曾被 `usable && model` 卡住，而「从端点拉取」
  // 恰恰用于模型还没定下来的时候（登记清单为空/滞后）——端点给不出去就永远拉不到。
  const v2 = JSON.parse(fs.readFileSync(V2_CFG, 'utf8'));
  v2.provider.p3 = {
    name: '空清单网关', kind: 'openai-compatible',
    options: { baseURL: 'http://10.0.0.9:8088/v1', apiKey: 'sk-p3' },
    models: {} // 登记清单为空：用户只能靠「从端点拉取」
  };
  fs.writeFileSync(V2_CFG, JSON.stringify(v2));
  try {
    fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p3' }));
    const t = controller.effectiveTarget({ zcodeProvider: 'p3', zcodeFetch: true });
    assert.strictEqual(t.providerUsable, true, '服务商本身可用');
    assert.strictEqual(t.model, '', '模型未定');
    assert.strictEqual(t.providerError, 'no_model', '原因应精确指向「没有模型」而非服务商不可用');
    assert.strictEqual(t.baseUrl, 'http://10.0.0.9:8088/v1', '端点必须给得出去（拉取模型要用）');
    assert.strictEqual(t.apiKey, 'sk-p3', 'key 必须给得出去（拉取模型要用）');
  } finally {
    delete v2.provider.p3;
    fs.writeFileSync(V2_CFG, JSON.stringify(v2));
  }
});
