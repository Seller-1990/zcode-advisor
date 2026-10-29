'use strict';

// 回归：state.js ensureState/mutateStateExclusive/withExclusiveLock 与 config.js applyLayer 的修复。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../hooks/lib/state');
const { loadConfig } = require('../hooks/lib/config');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-fix-'));
  t.after(() => {
    try { fs.chmodSync(d, 0o700); } catch (_) {}
    // 只恢复文件权限：目录去掉执行位后 rmSync 无法遍历（ENOTEMPTY）。
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600); } catch (_) {}
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}

// loadConfig 隔离：所有外部配置路径指向临时目录，绝不读真实 ~/.zcode。
function isolatedEnv(dir) {
  return {
    ZCODE_ADVISOR_USER_CONFIG: path.join(dir, 'user.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(dir, 'zcode.json'),
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(dir, 'provider.json'),
    ZCODE_ADVISOR_STATE_DIR: path.join(dir, 'state')
  };
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('ensureState: 读错误（chmod 000）不覆盖盘上状态', { skip: process.platform === 'win32' || isRoot }, (t) => {
  const dir = tmpDir(t);
  const { file } = state.ensureState(dir, 's1', '/t.jsonl', true);
  state.mutateStateExclusive(file, (s) => { s.enabled = false; s.reviews = 7; });
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o000);
  const r = state.ensureState(dir, 's1', '/t.jsonl', true);
  fs.chmodSync(file, 0o600);
  assert.strictEqual(r.created, false);
  assert.ok(r.readError, '应标记 readError');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '盘上内容不得被改写');
  const disk = JSON.parse(before);
  assert.strictEqual(disk.enabled, false);
  assert.strictEqual(disk.reviews, 7);
});

test('ensureState: 损坏文件留尸后排他重建', (t) => {
  const dir = tmpDir(t);
  const file = state.stateFilePath(dir, 's2');
  fs.writeFileSync(file, '{not json');
  const r = state.ensureState(dir, 's2', '/t.jsonl', false);
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.state.enabled, false);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
  assert.strictEqual(state.loadState(file).sessionId, 's2');
});

test('mutateStateExclusive: 缺失时按 opts 重建，不强制 enabled=true', (t) => {
  const dir = tmpDir(t);
  const file = state.stateFilePath(dir, 'abc-123');
  const s = state.mutateStateExclusive(file, (x) => { x.reviews = 1; }, { startEnabled: false });
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.sessionId, 'abc-123', '未给 sessionId 时从文件名反推');
  assert.strictEqual(state.loadState(file).enabled, false);
});

test('mutateStateExclusive: 不传 opts 时保持旧默认（启用）且 sessionId 来自文件名', (t) => {
  const dir = tmpDir(t);
  const file = state.stateFilePath(dir, 'xyz');
  const s = state.mutateStateExclusive(file, () => {});
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.sessionId, 'xyz');
});

test('withExclusiveLock: 目录不存在时快速失败（不空转重试）', (t) => {
  const dir = tmpDir(t);
  const t0 = Date.now();
  const r = state.withExclusiveLock(path.join(dir, 'nope', 'x.lock'), () => 'ran');
  assert.strictEqual(r, null);
  assert.ok(Date.now() - t0 < 200, `应立即返回，实际 ${Date.now() - t0}ms`);
});

test('applyLayer: 字符串布尔/数字强转，原型键被忽略', (t) => {
  const dir = tmpDir(t);
  const root = path.join(dir, 'plugin');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'advisor.config.json'),
    '{"startEnabled":"false","proseFallback":"off","immuneTurns":"5","temperature":"0.7","__proto__":{"polluted":1},"constructor":"x"}');
  const cfg = loadConfig(root, isolatedEnv(dir));
  assert.strictEqual(cfg.startEnabled, false);
  assert.strictEqual(cfg.proseFallback, false);
  assert.strictEqual(cfg.immuneTurns, 5);
  assert.strictEqual(cfg.temperature, 0.7);
  assert.strictEqual(cfg.polluted, undefined);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(cfg.constructor, Object);
});

test('applyLayer: 非法布尔串忽略并登记，非数字整数串回退默认并登记', (t) => {
  const dir = tmpDir(t);
  const root = path.join(dir, 'plugin');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'advisor.config.json'), JSON.stringify({ startEnabled: 'maybe', maxNoteChars: 'abc' }));
  const cfg = loadConfig(root, isolatedEnv(dir));
  assert.strictEqual(cfg.startEnabled, true);
  assert.ok(cfg.problems.some((p) => p.includes('startEnabled')));
  assert.strictEqual(cfg.maxNoteChars, 768);
  assert.ok(cfg.problems.some((p) => p.includes('maxNoteChars')));
});

test('setRebuildDefaults：未透传 opts 时，被 prune 的会话按进程级 startEnabled=false 重建', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const st = require('../hooks/lib/state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-rebuild-'));
  try {
    st.setRebuildDefaults({ startEnabled: false });
    const r = st.mutateStateExclusive(path.join(dir, 'sess-abc.json'), () => {});
    assert.equal(r.enabled, false);
    assert.equal(r.sessionId, 'abc');
  } finally {
    st.setRebuildDefaults({});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
