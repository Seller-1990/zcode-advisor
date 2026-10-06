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
// 同理隔离生产日志（controller.cjs:135 在 require 期固化 LOG_FILE）：
// 本文件目前不写日志，但 require controller 就一并隔离，避免后续新增用例污染用户真实日志。
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zca-sess-log-')), 'companion.log');
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

test('setSessionTarget：设置/重置会话级服务商+模型，与 hook 的落点一致', () => {
  writeBeacon();
  const file = writeState({ enabled: true, sessionProvider: '', sessionModel: '' });
  // 设置
  const r1 = controller.setSessionTarget('prov-3p', 'kimi-k3');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.sessionModel, 'kimi-k3');
  assert.strictEqual(r1.sessionProvider, 'prov-3p');
  const s1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s1.sessionModel, 'kimi-k3');
  assert.strictEqual(s1.sessionProvider, 'prov-3p');
  // 重置（空 = 恢复跟随全局）
  const r2 = controller.setSessionTarget('', '');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.sessionModel, '');
  assert.strictEqual(r2.sessionProvider, '');
  const s2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s2.sessionModel, '');
  assert.strictEqual(s2.sessionProvider, '');
  assert.ok(!fs.existsSync(`${file}.wrlock`), '锁应释放');
  // 空白字符串等同重置（trim 语义）
  controller.setSessionTarget('  ', '   ');
  const s3 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s3.sessionModel, '');
  assert.strictEqual(s3.sessionProvider, '');
});

test('setSessionTarget：无会话 → no_session（不静默成功）', () => {
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const r = controller.setSessionTarget('', 'm1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_session');
});

test('readSessionSnapshot：经信标 stateDir 定位状态文件，返回 enabled/sessionProvider/sessionModel', () => {
  writeBeacon();
  writeState({ enabled: true, sessionProvider: 'prov-3p', sessionModel: 'kimi-k3' });
  const snap = controller.readSessionSnapshot();
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.hasSession, true);
  assert.strictEqual(snap.enabled, true);
  assert.strictEqual(snap.sessionModel, 'kimi-k3');
  assert.strictEqual(snap.sessionProvider, 'prov-3p');
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
  // 0.2.20 起：stateDir 里没有该会话状态文件的信标**不算有效会话**（locateLatestSessionBeacon
  // 会跳过它，避免旧代码写错 stateDir 的信标让按钮恒灰），因此这里报 no_session
  // 而不是 state_unreadable —— 语义上"找不到会话"比"状态不可读"更准确。
  assert.strictEqual(r.error, 'no_session');
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

test('信标校验：stateDir 指向无效目录的旧信标被跳过（按钮恒灰的根因回归）', () => {
  // 回归（用户实测）：0.2.19 及更早把信标的 stateDir 错写成 healthDir（~/.zcode），
  // controller 拿它去找 sess-*.json 必然失败 → hasSession:false →
  // 角标「使用全局默认 / 固定此模型」恒灰。仅判"字段存在"会让升级用户的旧信标继续被采纳，
  // 表现为「升了版却没修复」。这里要求 stateDir 目录里真的有该会话的状态文件。
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const beacon = {
    sessionId: SESSION_ID,
    stateDir: '/nonexistent/definitely-not-here',   // 旧代码写错的那种值
    state: 'ok',
    lastAttemptAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(healthDir, `advisor-health-${SESSION_ID}.json`), JSON.stringify(beacon));
  try {
    const snap = controller.readSessionSnapshot();
    assert.strictEqual(snap.hasSession, false, 'stateDir 无效的信标不得被当成有效会话');
  } finally {
    for (const f of fs.readdirSync(healthDir)) { try { fs.unlinkSync(path.join(healthDir, f)); } catch (_) {} }
  }
});

test('信标校验：stateDir 有效但状态文件缺失 → 同样不算有效会话', () => {
  for (const f of fs.readdirSync(healthDir)) fs.unlinkSync(path.join(healthDir, f));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-nostate-'));
  const beacon = {
    sessionId: SESSION_ID,
    stateDir: empty,                                // 目录存在但没有 sess-*.json
    state: 'ok',
    lastAttemptAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(healthDir, `advisor-health-${SESSION_ID}.json`), JSON.stringify(beacon));
  try {
    const snap = controller.readSessionSnapshot();
    assert.strictEqual(snap.hasSession, false, '没有状态文件的会话不算有会话');
  } finally {
    // 清掉本用例写的信标：后续用例依赖 healthDir 为空（曾因此污染出失败）。
    for (const f of fs.readdirSync(healthDir)) { try { fs.unlinkSync(path.join(healthDir, f)); } catch (_) {} }
    try { fs.rmSync(empty, { recursive: true, force: true }); } catch (_) {}
  }
});
