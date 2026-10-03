'use strict';

// 会话级开关（0.2.15 角标瘦身）：controller 跨进程读写 hook 侧状态文件。
// readSessionSnapshot / toggleSessionEnabled 经信标里的 stateDir 定位 sess-<id>.json，
// 与 hook 的 mutateStateExclusive 用同款 <file>.wrlock 锁协议互斥（wx 抢建/陈旧接管）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// controller require 时解析 HEALTH_DIR，必须先设 env 再 require
const healthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-health-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-state-'));
process.env.ZCODE_ADVISOR_HEALTH_DIR = healthDir;
const controller = require('../tools/companion/controller.cjs');

const SESSION_ID = 'sess_test0001';

function writeBeacon() {
  const beacon = {
    sessionId: SESSION_ID,
    stateDir,
    state: 'ok',
    lastAttemptAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(healthDir, `advisor-health-${SESSION_ID}.json`), JSON.stringify(beacon));
}

function writeState(patch) {
  const file = path.join(stateDir, `sess-${SESSION_ID}.json`);
  const st = Object.assign({
    schema: 1, sessionId: SESSION_ID, enabled: true, sessionModel: '', reviews: 3
  }, patch || {});
  fs.writeFileSync(file, JSON.stringify(st, null, 2));
  return file;
}

test('readSessionSnapshot：经信标 stateDir 定位状态文件，返回 enabled/sessionModel', () => {
  writeBeacon();
  writeState({ enabled: true, sessionModel: 'kimi-k3' });
  const snap = controller.readSessionSnapshot();
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.hasSession, true);
  assert.strictEqual(snap.enabled, true);
  assert.strictEqual(snap.sessionModel, 'kimi-k3');
  assert.match(snap.stateFile, /sess-sess_test0001\.json$/, '状态文件名应与 hook 的 stateFilePath 规则一致');
});

test('readSessionSnapshot：无信标/无状态文件时 hasSession=false 而非报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-empty-'));
  const prev = process.env.ZCODE_ADVISOR_HEALTH_DIR;
  process.env.ZCODE_ADVISOR_HEALTH_DIR = empty;
  try {
    // HEALTH_DIR 是 require 期常量，直接清空目录内容来模拟无信标
    for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
    const snap = controller.readSessionSnapshot();
    assert.strictEqual(snap.hasSession, false);
  } finally {
    process.env.ZCODE_ADVISOR_HEALTH_DIR = prev;
    for (const f of fs.readdirSync(empty)) fs.unlinkSync(path.join(empty, f));
    fs.rmdirSync(empty);
  }
  // 状态文件缺失（有信标无状态）同样视为无会话
  assert.strictEqual(controller.readSessionSnapshot().hasSession, false);
});

test('toggleSessionEnabled：切换落盘且 wrlock 释放', () => {
  writeBeacon();
  const file = writeState({ enabled: true });
  const r1 = controller.toggleSessionEnabled(false);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.enabled, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false, 'enabled=false 应落盘');
  assert.ok(!fs.existsSync(`${file}.wrlock`), '临界区结束后锁应清除');
  assert.ok(!fs.existsSync(`${file}.tmp-${process.pid}`), '不应残留 tmp 文件');

  const r2 = controller.toggleSessionEnabled(true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, true);
});

test('toggleSessionEnabled：状态文件不存在 → no_session（不静默成功）', () => {
  writeBeacon(); // 有信标但无状态文件
  const file = path.join(stateDir, `sess-${SESSION_ID}.json`);
  try { fs.unlinkSync(file); } catch (_) {} // 前序用例可能写过状态文件
  const r = controller.toggleSessionEnabled(false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'state_unreadable');
});

test('toggleSessionEnabled：无信标 → no_session', () => {
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const r = controller.toggleSessionEnabled(true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_session');
});

test('toggleSessionEnabled：与 hook 侧活锁并发 → lock_timeout（互斥而非互相覆盖）', () => {
  writeBeacon();
  writeState({ enabled: true });
  // 模拟 hook 正持锁：wrlock 内容为存活 pid（pid 1 恒存在）、mtime 新鲜
  const file = path.join(stateDir, `sess-${SESSION_ID}.json`);
  fs.writeFileSync(`${file}.wrlock`, '1');
  try {
    const r = controller.toggleSessionEnabled(false);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'lock_timeout');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, true, '未抢到锁时不得改写状态');
  } finally {
    try { fs.unlinkSync(`${file}.wrlock`); } catch (_) {}
  }
});

test('toggleSessionEnabled：陈旧锁接管（持锁者已死）', () => {
  writeBeacon();
  const file = writeState({ enabled: true });
  const lock = `${file}.wrlock`;
  fs.writeFileSync(lock, '999999999'); // 不存在的 pid
  const old = Date.now() - 20000;
  fs.utimesSync(lock, new Date(old), new Date(old)); // mtime 拨老 → 陈旧锁
  const r = controller.toggleSessionEnabled(false);
  assert.strictEqual(r.ok, true, '陈旧锁应被接管');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false);
});
