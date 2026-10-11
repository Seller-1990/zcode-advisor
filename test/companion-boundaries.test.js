'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');
const tmpRoot = os.tmpdir();
const fixture = fs.mkdtempSync(path.join(tmpRoot, 'zca-boundaries-'));
const config = path.join(fixture, 'advisor.json');
const history = path.join(fixture, 'history.jsonl');
// Isolate captured host paths before loading either server.
Object.assign(process.env, {
  HOME: fixture, USERPROFILE: fixture, TMPDIR: fixture, TMP: fixture, TEMP: fixture,
  NODE_ENV: 'test', ZCODE_ADVISOR_PANEL_NO_OPEN: '1',
  ZCODE_ADVISOR_USER_CONFIG: config, ZCODE_ADVISOR_HISTORY: history,
  ZCODE_ADVISOR_STATE_DIR: fixture, ZCODE_ADVISOR_HEALTH_DIR: fixture,
  ZCODE_ADVISOR_COMPANION_LOG: path.join(fixture, 'companion.log'),
  ZCODE_ADVISOR_COMPANION_CONFIG: path.join(fixture, 'companion.json'),
  ZCODE_ADVISOR_ZCODE_CONFIG: path.join(fixture, 'zcode.json'),
  ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(fixture, 'providers.json')
});
const controller = require('../tools/companion/controller.cjs');
const { writeUserConfig } = require('../tools/config-bridge.js');
let setup, companion;
const token = 'fixture-only-token';
const close = async (server) => {
  if (!server || !server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const request = (server, url, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url,
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  req.end(body);
});

test.before(async () => {
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  process.env.ZCODE_ADVISOR_PANEL_PORT = String(reserve.address().port);
  await close(reserve);
  setup = require('../tools/setup-server.js'); await once(setup, 'listening');
  companion = controller.startApi(0, 0, token); await once(companion, 'listening');
});
test.after(async () => {
  await close(setup); await close(companion);
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tmpRoot) + path.sep + 'zca-boundaries-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('controller / config bridge refuse corrupt and non-object files without overwriting', () => {
  for (const raw of ['{"model":"prior",BROKEN', '[]', 'null', '42', '"text"']) {
    for (const save of [patch => controller.saveUserConfig(patch), patch => writeUserConfig(patch)]) {
      fs.writeFileSync(config, raw);
      assert.ok(save({ reviewMode: 'sync' }).error, `must reject ${raw}`);
      assert.equal(fs.readFileSync(config, 'utf8'), raw);
    }
  }
});

test('setup and companion HTTP save expose corrupt-file errors, not false success', async () => {
  for (const [server, url, headers] of [[setup, '/api/save', {}], [companion, '/api/config', { 'X-Advisor-Token': token }]]) {
    for (const raw of ['{"model":"prior",BROKEN', '[]', 'null']) {
      fs.writeFileSync(config, raw);
      const r = await request(server, url, '{"model":"new"}', headers);
      assert.equal(r.status, 400, r.text);
      assert.equal(JSON.parse(r.text).ok, false);
      assert.equal(fs.readFileSync(config, 'utf8'), raw);
    }
  }
});

test('save requires JSON object request bodies before any configuration mutation', async () => {
  for (const [server, url, headers] of [[setup, '/api/save', {}], [companion, '/api/config', { 'X-Advisor-Token': token }]]) {
    for (const raw of ['{broken', '[]', 'null', '42']) {
      const before = '{"model":"keep","apiKey":"legacy-preserve-on-invalid-request"}';
      fs.writeFileSync(config, before);
      const r = await request(server, url, raw, headers);
      assert.equal(r.status, 400, r.text);
      assert.equal(fs.readFileSync(config, 'utf8'), before);
    }
  }
});

test('setup guards private HTML and history against foreign Host and Origin', async () => {
  fs.writeFileSync(config, '{"model":"PRIVATE_MODEL"}');
  fs.writeFileSync(history, JSON.stringify({ event: 'review', note: 'PRIVATE_NOTE' }) + '\n');
  for (const url of ['/', '/?settings', '/api/history']) {
    for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }, { Origin: 'null' }]) {
      const r = await request(setup, url, undefined, headers);
      assert.equal(r.status, 403, `${url}: ${r.status}`);
      assert.ok(!r.text.includes('PRIVATE_'));
    }
    assert.equal((await request(setup, url)).status, 200);
  }
});

test('provider merge preserves complete connection tuples and never splices incomplete sources', () => {
  const first = (baseURL, apiKey, kind = 'openai') => ({ kind, name: 'Primary', options: { baseURL, apiKey }, models: { 'first-model': {} } });
  const second = (baseUrl, apiKey, type = 'anthropic') => ({ providerId: 'p', config: { api: { baseUrl, type }, access: { apiKey }, personalModelIds: ['second-model'] } });
  const read = (a, b) => {
    fs.writeFileSync(process.env.ZCODE_ADVISOR_ZCODE_CONFIG, JSON.stringify({ provider: { p: a } }));
    fs.writeFileSync(process.env.ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG, JSON.stringify({ config: { providerConfigRules: { providerRules: [b] } } }));
    return controller.readZcodeProviders().find(p => p.id === 'p');
  };
  let p = read(first('https://primary.invalid', ''), second('https://secondary.invalid', 'SECOND'));
  assert.equal(p.baseURL, 'https://secondary.invalid'); assert.equal(p.apiKey, 'SECOND');
  assert.equal(p.protocol, 'anthropic'); assert.equal(p.source, 'provider_config');
  assert.equal(p.name, 'Primary'); assert.deepEqual(p.models, ['first-model', 'second-model']);
  p = read(first('https://primary.invalid', 'FIRST'), second('https://secondary.invalid', 'SECOND'));
  assert.equal(p.baseURL, 'https://primary.invalid'); assert.equal(p.apiKey, 'FIRST'); assert.equal(p.protocol, 'openai');
  p = read(first('https://primary.invalid', ''), second('', 'SECOND'));
  assert.equal(Boolean(p.eligible && p.baseURL && p.apiKey), false);
  p = read(first('https://primary.invalid', 'FIRST', 'unsupported'), second('https://secondary.invalid', 'SECOND'));
  assert.equal(p.protocol, 'anthropic'); assert.equal(p.eligible, true);
  fs.writeFileSync(process.env.ZCODE_ADVISOR_ZCODE_CONFIG, '{broken');
  p = controller.readZcodeProviders().find(p => p.id === 'p');
  assert.equal(p.apiKey, 'SECOND'); assert.equal(p.baseURL, 'https://secondary.invalid');
});

test('models normalizes pre-header fetch rejection into structured result', async () => {
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(process.env.ZCODE_ADVISOR_ZCODE_CONFIG, JSON.stringify({ provider: {
    p: { kind: 'openai', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, models: {} }
  } }));
  const fetchBefore = global.fetch;
  try {
    global.fetch = async () => { throw new Error('fixture offline'); };
    const r = await controller.fetchModels({ zcodeProvider: 'p', zcodeFetch: true });
    assert.equal(r.error, 'models_error');
    global.fetch = async () => { throw new DOMException('fixture abort', 'AbortError'); };
    assert.equal((await controller.fetchModels({ zcodeProvider: 'p', zcodeFetch: true })).error, 'models_timeout');
  } finally { global.fetch = fetchBefore; }
});

test('models deadline includes stalled response body', { timeout: 16000 }, async () => {
  fs.writeFileSync(config, '{}');
  const slow = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); });
  slow.listen(0, '127.0.0.1'); await once(slow, 'listening');
  fs.writeFileSync(process.env.ZCODE_ADVISOR_ZCODE_CONFIG, JSON.stringify({ provider: {
    p: { kind: 'openai', options: { baseURL: `http://127.0.0.1:${slow.address().port}/v1`, apiKey: 'fixture' }, models: {} }
  } }));
  let watchdog;
  try {
    const result = await Promise.race([
      controller.fetchModels({ zcodeProvider: 'p', zcodeFetch: true }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('body exceeded 12s deadline')), 13500); })
    ]);
    assert.equal(result.error, 'models_timeout');
  } finally { clearTimeout(watchdog); await close(slow); }
});
