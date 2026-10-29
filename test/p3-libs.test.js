'use strict';

// P3 审计修复回归：旁文件回收、sanitize 防碰撞、本机端点判定、占位符整值匹配、样本/历史裁剪。
// 所有路径指向临时目录，绝不读真实 ~/.zcode。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE = require('../hooks/lib/state');
const HEALTH = require('../hooks/lib/health');
const { isPlaceholderKey, configWarnings } = require('../hooks/lib/config');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-p3-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return dir;
}

function age(file, ms) {
  const d = new Date(Date.now() - ms);
  fs.utimesSync(file, d, d);
}

function isolatedEnv(dir, extra) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: dir,
    ZCODE_ADVISOR_HEALTH_DIR: dir,
    ZCODE_ADVISOR_HISTORY: path.join(dir, 'h.jsonl'),
    ZCODE_ADVISOR_SAMPLES: path.join(dir, 's.jsonl'),
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(dir, 'zcode.json'),
    ZCODE_ADVISOR_USER_CONFIG: path.join(dir, 'user.json'),
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(dir, 'provider.json')
  }, extra || {});
}

const DAY = 24 * 3600 * 1000;

test('sanitizeSessionId：干净 id 原样（无需迁移），改写/截断时追加 8 位 hash 防碰撞', () => {
  assert.strictEqual(STATE.sanitizeSessionId('sess_abc-123'), 'sess_abc-123');
  assert.strictEqual(STATE.sanitizeSessionId(''), 'default');
  const ids = ['a/b', 'a.b', 'a b'].map(STATE.sanitizeSessionId);
  assert.strictEqual(new Set(ids).size, 3, `不同 id 不得碰撞：${ids}`);
  for (const id of ids) assert.match(id, /^a-b-[0-9a-f]{8}$/);
  const long1 = STATE.sanitizeSessionId('x'.repeat(100));
  const long2 = STATE.sanitizeSessionId('x'.repeat(101));
  assert.notStrictEqual(long1, long2);
  assert.ok(long1.length <= 80);
  const exact80 = 'y'.repeat(80);
  assert.strictEqual(STATE.sanitizeSessionId(exact80), exact80);
  const trav = STATE.sanitizeSessionId('../../etc/passwd');
  assert.ok(!trav.includes('.') && !trav.includes('/'));
  // health 与 state 同规则
  const dir = os.tmpdir();
  assert.strictEqual(HEALTH.beaconPath(dir, 'a/b'), path.join(dir, `advisor-health-${STATE.sanitizeSessionId('a/b')}.json`));
});

test('pruneStates：回收超龄旁文件，保留新鲜旁文件与持有新鲜 wrlock 的状态', (t) => {
  const dir = tmpDir(t);
  const mk = (name, ms) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); if (ms) age(f, ms); return f; };
  const oldCorrupt = mk('sess-a.json.corrupt-123', 2 * DAY);
  const oldTmp = mk('sess-a.json.tmp-1-2-3', 2 * DAY);
  const oldWr = mk('sess-a.json.wrlock', 2 * DAY);
  const oldLock = mk('sess-a.json.lock', 2 * DAY);
  const freshCorrupt = mk('sess-b.json.corrupt-456', 60000);
  const unrelated = mk('other.txt', 30 * DAY);
  // 超龄状态但正被写者持有新鲜 wrlock：不删
  const held = path.join(dir, 'sess-held.json');
  STATE.saveState(held, STATE.freshState('held', '', true));
  age(held, 30 * DAY);
  mk('sess-held.json.wrlock', 0);
  const stale = path.join(dir, 'sess-stale.json');
  STATE.saveState(stale, STATE.freshState('stale', '', true));
  age(stale, 30 * DAY);

  STATE.pruneStates(dir, 7, 50);

  for (const f of [oldCorrupt, oldTmp, oldWr, oldLock, stale]) assert.ok(!fs.existsSync(f), `${path.basename(f)} 应被回收`);
  for (const f of [freshCorrupt, unrelated, held]) assert.ok(fs.existsSync(f), `${path.basename(f)} 应保留`);
});

test('pruneBeacons：回收超龄 tmp 旁文件，保留新鲜 tmp', (t) => {
  const dir = tmpDir(t);
  const oldTmp = path.join(dir, 'advisor-health-x.json.tmp-1-2');
  const freshTmp = path.join(dir, 'advisor-health-y.json.tmp-3-4');
  fs.writeFileSync(oldTmp, '{}');
  fs.writeFileSync(freshTmp, '{}');
  age(oldTmp, 2 * DAY);
  HEALTH.pruneBeacons(dir, 7, 50);
  assert.ok(!fs.existsSync(oldTmp));
  assert.ok(fs.existsSync(freshTmp));
});

test('mergeBeacon：信标文件 0600，不留 tmp', { skip: process.platform === 'win32' }, (t) => {
  const dir = tmpDir(t);
  HEALTH.writeAttempt(dir, 's1', { model: 'm' }, dir);
  HEALTH.writeResult(dir, 's1', { ok: true }, dir);
  const f = HEALTH.beaconPath(dir, 's1');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

test('configWarnings：本机判定按 hostname 精确比较', () => {
  const warned = (url) => configWarnings({ baseUrl: url }, { key: 'k', source: 'config' })
    .some((w) => w.startsWith('insecure_http_endpoint'));
  for (const url of ['http://127.evil.com/v1', 'http://localhost.attacker.com/v1', 'http://192.168.1.5:8788/v1', 'http://::1x/v1']) {
    assert.strictEqual(warned(url), true, `${url} 应告警`);
  }
  for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:1/v1', 'http://127.1.2.3/v1', 'http://[::1]:8788/v1', 'HTTP://LOCALHOST/v1']) {
    assert.strictEqual(warned(url), false, `${url} 不应告警`);
  }
  assert.strictEqual(warned('https://api.example.com/v1'), false);
});

test('isPlaceholderKey：整值匹配占位符，真实 key 不因前缀误判', () => {
  for (const v of ['REPLACE_YOUR_KEY', 'REPLACE_ME', 'your-api-key', 'your_key_here', 'xxx', 'sk-xxxxxxxx',
    'test', 'test-key', 'test_api_key', 'placeholder', 'changeme', 'none', 'null', '', '  ', '<your key>', '填入你的key']) {
    assert.strictEqual(isPlaceholderKey(v), true, `${JSON.stringify(v)} 应视为占位符`);
  }
  for (const v of ['test-abc123realkey', 'your-co-gw-77aa', 'none-9f8e', 'sk-real-token-123', 'e2e-key-abc123-not-placeholder', 'xxx-9f8e7d']) {
    assert.strictEqual(isPlaceholderKey(v), false, `${v} 不应被误判为占位符`);
  }
  assert.strictEqual(isPlaceholderKey(undefined), true);
});

test('samples：超限原子裁剪到一半、文件 0600、不留 trim tmp', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 's.jsonl');
  const out = execFileSync(process.execPath, ['-e', `
    const S = require(${JSON.stringify(path.join(ROOT, 'hooks/lib/samples.js'))});
    for (let i = 0; i < S.SAMPLES_MAX_LINES + 5; i++) S.appendSample({ error: 'unparsed', textHead: 'n' + i });
    process.stdout.write(String(S.SAMPLES_MAX_LINES));
  `], { env: isolatedEnv(dir), encoding: 'utf8' });
  const max = Number(out);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= max && lines.length >= max / 2, `裁剪后行数 ${lines.length}`);
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).textHead, `n${max + 4}`, '最新样本保留');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.trim-')), []);
});

test('history：小文件不触发裁剪读；超限仍裁剪；遗留 0644 文件被收紧', { skip: process.platform === 'win32' }, (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'h.jsonl');
  fs.writeFileSync(file, '', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const out = execFileSync(process.execPath, ['-e', `
    const H = require(${JSON.stringify(path.join(ROOT, 'hooks/lib/history.js'))});
    for (let i = 0; i < H.HISTORY_MAX_LINES + 20; i++) H.appendHistory({ event: 'queued', note: 'n' + i });
    process.stdout.write(JSON.stringify({ max: H.HISTORY_MAX_LINES, first: H.readHistory(1)[0].note }));
  `], { env: isolatedEnv(dir), encoding: 'utf8' });
  const got = JSON.parse(out);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= got.max, `裁剪后 ${lines.length} 行`);
  assert.strictEqual(got.first, `n${got.max + 19}`);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('ensureState：已存在的宽权限目录被收紧到 0700', { skip: process.platform === 'win32' }, (t) => {
  const dir = tmpDir(t);
  const sd = path.join(dir, 'st');
  fs.mkdirSync(sd, { mode: 0o755 });
  fs.chmodSync(sd, 0o755);
  const { file } = STATE.ensureState(sd, 'perm-1', '', true);
  assert.strictEqual(fs.statSync(sd).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});
