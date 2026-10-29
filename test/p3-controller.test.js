'use strict';

// P3 审计修复回归：readBody 多字节分块、/panel 带查询串、zcodeProvider 空串复位、
// 信标清单缓存不吞变化、plist 权限 0644、auto-enable 模板/zcodePath、信号/重扫/日志守卫。
// 全部在临时目录内进行：不启动 ZCode、不连 CDP、不读真实 ~/.zcode、不碰真实 launchd。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-p3-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.zcode'), { recursive: true });
const healthDir = path.join(root, 'health');
fs.mkdirSync(healthDir, { recursive: true });
const USER_CFG = path.join(root, 'advisor.config.json');

Object.assign(process.env, {
  HOME: home,
  ZCODE_ADVISOR_USER_CONFIG: USER_CFG,
  ZCODE_ADVISOR_ZCODE_CONFIG: path.join(root, 'zcode-config.json'),
  ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(root, 'provider_config.json'),
  ZCODE_ADVISOR_STATE_DIR: path.join(root, 'state'),
  ZCODE_ADVISOR_HEALTH_DIR: healthDir,
  ZCODE_ADVISOR_COMPANION_CONFIG: path.join(root, 'advisor-companion.json'),
  ZCODE_ADVISOR_COMPANION_LOG: path.join(root, 'companion.log'),
  ZCODE_ADVISOR_HISTORY_FILE: path.join(root, 'history.jsonl')
});
delete process.env.ZCODE_ADVISOR_SUPERVISED;

const controller = require('../tools/companion/controller.cjs');
const L = require('../tools/companion/launchd.cjs');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'), 'utf8');
const AE_SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'companion', 'auto-enable.cjs'), 'utf8');

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

const TOKEN = 'p3-test-token';
async function withServer(fn) {
  const server = controller.startApi(0, 0, TOKEN);
  await once(server, 'listening');
  try { return await fn(server.address().port); } finally { server.close(); }
}

// 原始请求：允许把请求体按任意字节边界拆成多块发送
function rawRequest(port, method, urlPath, chunks, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    (async () => {
      for (const c of chunks || []) { req.write(c); await new Promise((r) => setTimeout(r, 15)); }
      req.end();
    })();
  });
}

test('readBody：多字节 UTF-8 跨块拆分不乱码（Buffer 聚合后一次解码）', async () => {
  fs.writeFileSync(USER_CFG, '{}');
  const buf = Buffer.from(JSON.stringify({ model: '模型-中文' }), 'utf8');
  const cut = buf.indexOf(Buffer.from('模', 'utf8')) + 1; // 切在「模」的 3 字节中间
  await withServer(async (port) => {
    const r = await rawRequest(port, 'POST', '/api/config', [buf.subarray(0, cut), buf.subarray(cut)],
      { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'x-advisor-token': TOKEN });
    assert.strictEqual(r.status, 200, r.body);
  });
  assert.strictEqual(JSON.parse(fs.readFileSync(USER_CFG, 'utf8')).model, '模型-中文');
});

test('readBody：超 1MB（按字节计）的请求体被拒绝', async () => {
  // 40 万个 3 字节汉字 = 1.2MB 字节，但字符数仅 40 万：旧实现按字符计会放行
  const big = Buffer.from(JSON.stringify({ model: '汉'.repeat(400000) }), 'utf8');
  await withServer(async (port) => {
    let status = 0;
    try {
      const r = await rawRequest(port, 'POST', '/api/config', [big],
        { 'Content-Type': 'application/json', 'Content-Length': big.length, 'x-advisor-token': TOKEN });
      status = r.status;
    } catch (_) { status = -1; } // 连接被 destroy
    assert.notStrictEqual(status, 200);
  });
});

test('/panel：带查询串仍返回面板而不是 404', async () => {
  await withServer(async (port) => {
    for (const p of ['/panel', '/panel/', '/panel?x=1', '/panel/?v=2#h']) {
      const r = await rawRequest(port, 'GET', p, [], {});
      assert.strictEqual(r.status, 200, `${p} 应返回 200`);
    }
  });
});

test('saveUserConfig：zcodeProvider 空串 = 删除（恢复自动选择）；其余键空串仍不改', () => {
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p1', model: 'm-a' }));
  controller.saveUserConfig({ zcodeProvider: '', model: '' });
  const saved = JSON.parse(fs.readFileSync(USER_CFG, 'utf8'));
  assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'zcodeProvider'), 'zcodeProvider 应被删除');
  assert.strictEqual(saved.model, 'm-a', 'model 空串仍表示不改');
  // 未传 zcodeProvider 时不动它
  fs.writeFileSync(USER_CFG, JSON.stringify({ zcodeProvider: 'p1' }));
  controller.saveUserConfig({ model: 'm-b' });
  assert.strictEqual(JSON.parse(fs.readFileSync(USER_CFG, 'utf8')).zcodeProvider, 'p1');
});

test('信标清单缓存：rename 落盘的新信标立即可见（缓存不吞变化）', () => {
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const put = (id, at) => {
    const file = path.join(healthDir, `advisor-health-${id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessionId: id, state: 'ok', lastAttemptAt: at, lastSuccessAt: at }));
    fs.renameSync(tmp, file);
  };
  put('a', new Date(Date.now() - 1000).toISOString());
  assert.strictEqual(controller.readHealth(480000).beacon.sessionId, 'a');
  put('b', new Date().toISOString());
  assert.strictEqual(controller.readHealth(480000).beacon.sessionId, 'b', '缓存期内新增信标也必须可见');
  fs.unlinkSync(path.join(healthDir, 'advisor-health-b.json'));
  assert.strictEqual(controller.readHealth(480000).beacon.sessionId, 'a', '删除也必须可见');
});

test('launchd.writePlist：宽松 umask 下 plist 仍为 0644（launchd 拒绝组/他人可写）', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(root, 'LaunchAgents');
  const prev = process.umask(0);
  try {
    const r = L.install({ dir, nodeBin: '/x/node', controllerPath: '/x/controller.cjs' });
    const p = (r && (r.plistPath || r.path)) || L.plistPath(dir);
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);
  } finally { process.umask(prev); }
});

test('auto-enable：首次模板为空对象，不再写 baseUrl/apiKey 旧键；findZcodeCli 读 companion 配置', () => {
  assert.ok(!/baseUrl:\s*'https:\/\/open\.bigmodel/.test(AE_SRC), '模板不应再含 baseUrl');
  assert.ok(/writeFileSync\(cfg, '\{\}\\n'/.test(AE_SRC), '模板应为空对象');
  assert.ok(/advisor-companion\.json/.test(AE_SRC) && /ZCODE_ADVISOR_COMPANION_CONFIG/.test(AE_SRC),
    'findZcodeCli 应与 controller 同源读取 advisor-companion.json');
  assert.ok(!/config:\s*\{\}\s*,/.test(AE_SRC), '不应再传空 config');
});

test('controller 静态守卫：信号处理、重扫闸门、心跳复查日志、死代码移除', () => {
  assert.match(SRC, /for \(const sig of Object\.keys\(SIGNAL_EXIT_CODES\)\)/);
  assert.match(SRC, /SIGTERM: 143/);
  assert.match(SRC, /installSignalHandlers\(\);/);
  assert.match(SRC, /setInterval\(guardedRescan, POLL_INTERVAL_MS\)/);
  assert.match(SRC, /if \(rescanInFlight\) return false;/);
  const hb = SRC.slice(SRC.indexOf('function startLockHeartbeat'), SRC.indexOf('const STEAL_GUARD_FILE'));
  assert.match(hb, /rotateLogIfLarge\(\)/, '心跳内应周期复查日志体积');
  assert.ok(!/const maskKey\b/.test(SRC), 'maskKey 无调用方，应删除');
  assert.ok(!/\bscriptIds\b/.test(SRC), 'scriptIds 只写不读，应删除');
});
