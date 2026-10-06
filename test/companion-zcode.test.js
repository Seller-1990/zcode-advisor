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
// 隔离第二个数据源（provider_config.json）：否则会读到开发机真实配置，断言随环境漂移。
process.env.ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG = path.join(dir, 'no-such-provider-config.json');
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
    },
    // 协议不受支持（既非 OpenAI 兼容、也非 Anthropic）
    p3: {
      name: '未知协议网关', kind: 'bedrock',
      options: { baseURL: 'https://b.example', apiKey: 'sk-b' },
      models: { 'some-model': {} }
    }
  }
}));

const controller = require('../tools/companion/controller.cjs');

test('readZcodeProviders：解析 provider 字段、标记协议合格性与官方内置', () => {
  const list = controller.readZcodeProviders();
  assert.strictEqual(list.length, 3);
  const p1 = list.find((p) => p.id === 'p1');
  assert.strictEqual(p1.eligible, true);
  assert.strictEqual(p1.protocol, 'openai');
  assert.strictEqual(p1.official, false);
  assert.strictEqual(p1.baseURL, 'http://10.0.0.8:8088/v1');
  assert.deepStrictEqual(p1.models, ['m-a', 'm-b']);
  // anthropic 自 0.2.20 起可用，协议标记决定 ping/审查走 /v1/messages
  const p2 = list.find((p) => p.id === 'p2');
  assert.strictEqual(p2.eligible, true);
  assert.strictEqual(p2.protocol, 'anthropic');
  // 未知协议仍不可用
  const p3 = list.find((p) => p.id === 'p3');
  assert.strictEqual(p3.eligible, false);
  assert.strictEqual(p3.protocol, '');
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

test('effectiveTarget：协议不受支持/官方内置服务商不产出凭据（防密钥交叉）', () => {
  // 协议不受支持（p3 = bedrock）
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p3', model: 'some-model' }));
  const ineligible = controller.effectiveTarget({});
  assert.strictEqual(ineligible.providerUsable, false);
  assert.strictEqual(ineligible.baseUrl, '');
  assert.strictEqual(ineligible.providerError, 'provider_ineligible');

  // anthropic 协议：自 0.2.20 起可用，凭据随 protocol='anthropic' 一起给出
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p2', model: 'claude' }));
  const ant = controller.effectiveTarget({});
  assert.strictEqual(ant.providerUsable, true);
  assert.strictEqual(ant.baseUrl, 'https://r.example');
  assert.strictEqual(ant.protocol, 'anthropic');

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

// ---------------- Anthropic 协议：端点推导与 Ping 鉴权头 ----------------
// 真机实测（2026-10-05）：ZCode 里 anthropic 服务商的 baseURL 都不含 /v1，
// 真实路径是 baseURL + /v1/messages（探测：+ /v1/messages → 401 鉴权层；+ /messages → 404）。
// 曾只补 /messages，导致所有 anthropic 服务商 404（真机复现后修正）。

test('normalizeMessagesEndpoint：裸主机补 /v1/messages，已含 /v1 只补 /messages', () => {
  assert.strictEqual(controller.normalizeMessagesEndpoint('http://192.168.50.139:8088'), 'http://192.168.50.139:8088/v1/messages');
  assert.strictEqual(controller.normalizeMessagesEndpoint('https://api.z.ai/api/anthropic'), 'https://api.z.ai/api/anthropic/v1/messages');
  assert.strictEqual(controller.normalizeMessagesEndpoint('https://aipm9527.ccwu.cc'), 'https://aipm9527.ccwu.cc/v1/messages');
  assert.strictEqual(controller.normalizeMessagesEndpoint('https://x/v1'), 'https://x/v1/messages');
  assert.strictEqual(controller.normalizeMessagesEndpoint('https://x/v1/messages'), 'https://x/v1/messages');
  assert.strictEqual(controller.normalizeMessagesEndpoint(''), '');
});

test('ping(anthropic)：走 /v1/messages + x-api-key/anthropic-version，不发 Bearer', async () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p2', model: 'claude' }));
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'pong' }] }) };
  };
  try {
    const r = await controller.ping({});
    assert.strictEqual(r.ok, true, `Ping 应成功，实际 ${JSON.stringify(r)}`);
    assert.strictEqual(seen.url, 'https://r.example/v1/messages');
    assert.strictEqual(seen.opt.headers['x-api-key'], 'sk-a');
    assert.strictEqual(seen.opt.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(seen.opt.headers.Authorization, undefined, 'anthropic 不得带 Bearer 头');
    assert.strictEqual(r.protocol, 'anthropic');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ping(openai)：仍走 /chat/completions + Bearer（协议分支不误伤）', async () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p1', model: 'm-a' }));
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'pong' } }] }) };
  };
  try {
    const r = await controller.ping({});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seen.url, 'http://10.0.0.8:8088/v1/chat/completions');
    assert.strictEqual(seen.opt.headers.Authorization, 'Bearer sk-gw');
    assert.strictEqual(seen.opt.headers['x-api-key'], undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchModels(anthropic)：拉取 /models 时用 x-api-key 头', async () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p2', model: 'claude' }));
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude' }] }) };
  };
  try {
    const r = await controller.fetchModels({ zcodeFetch: true });
    assert.strictEqual(r.ok, true, `拉取应成功，实际 ${JSON.stringify(r)}`);
    assert.strictEqual(seen.url, 'https://r.example/v1/models');
    assert.strictEqual(seen.opt.headers['x-api-key'], 'sk-a');
    assert.strictEqual(seen.opt.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});
