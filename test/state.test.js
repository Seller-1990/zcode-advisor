'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureState, mutateStateExclusive, loadState, saveState, createLock, countLocks, lockPathFor, freshState, bumpDrop
} = require('../hooks/lib/state');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-st-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return dir;
}

test('mutateStateExclusive：顺序合并，后写保留先写的字段', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sess-x.json');
  saveState(file, freshState('x', '', true));
  mutateStateExclusive(file, (s) => {
    s.pendingNotes = ['[advisor:nit] A'];
    s.lastActivity = 'T1';
  });
  mutateStateExclusive(file, (s) => {
    s.pendingNotes = []; // UPS 清队列
  });
  mutateStateExclusive(file, (s) => {
    s.pendingNotes.push('[advisor:blocker] B'); // worker 基于最新状态追加
    s.reviews = 1;
  });
  const s = loadState(file);
  assert.deepStrictEqual(s.pendingNotes, ['[advisor:blocker] B']);
  assert.strictEqual(s.lastActivity, 'T1'); // 未被 worker 覆盖
  assert.strictEqual(s.reviews, 1);
});

test('mutateStateExclusive：拿不到锁返回 null，状态不被破坏', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sess-y.json');
  saveState(file, freshState('y', '', true));
  // 人为制造新鲜写锁并保持持有
  const wrlock = `${file}.wrlock`;
  fs.writeFileSync(wrlock, '999', 'utf8');
  // 把 mtime 设为当前，确保不被陈旧回收
  const r = mutateStateExclusive(file, () => { throw new Error('不应执行'); }, { retries: 2 });
  assert.strictEqual(r, null);
  assert.ok(fs.existsSync(wrlock));
  try { fs.unlinkSync(wrlock); } catch (_) {}
});

test('损坏的状态文件：留 .corrupt-* 尸体并重建', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sess-z.json');
  fs.writeFileSync(file, '{broken json', 'utf8');
  const { state, created } = ensureState(dir, 'z', '', true);
  assert.strictEqual(created, true);
  assert.strictEqual(state.schema, 1);
  const corpses = fs.readdirSync(dir).filter((f) => f.startsWith('sess-z.json.corrupt-'));
  assert.strictEqual(corpses.length, 1);
});

test('createLock / countLocks：wx 互斥与全局计数', (t) => {
  const dir = tmpDir(t);
  const f1 = path.join(dir, 'sess-a.json');
  const f2 = path.join(dir, 'sess-b.json');
  assert.strictEqual(createLock(f1, 600000), true);
  assert.strictEqual(createLock(f1, 600000), false); // 新鲜锁
  assert.strictEqual(createLock(f2, 600000), true);
  assert.strictEqual(countLocks(dir), 2);
});

test('陈旧锁可被抢占', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'sess-c.json');
  assert.strictEqual(createLock(f, 1000), true);
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lockPathFor(f), old, old);
  assert.strictEqual(createLock(f, 1000), true); // 陈旧 → 抢占成功
});

// ---------------- KD-I3：丢弃分类的最近时间戳（对齐上游 v0.5.4） ----------------
// 上游 dsh-advisor v0.5.4 为 EMPTY/UNPARSED 两类各维护 lastXxxTimestamp，
// 用于回答"最后一次空回复/解析失败是多久前"，使"在跑但不产出"可被发现。

test('bumpDrop：记录计数与最近一次时间戳（droppedAt）', () => {
  const s = {};
  bumpDrop(s, 'llm_empty_response');
  assert.strictEqual(s.dropped.llm_empty_response, 1);
  assert.ok(s.droppedAt.llm_empty_response, '应记录时间戳');
  // 是合法 ISO 时间
  assert.ok(!Number.isNaN(Date.parse(s.droppedAt.llm_empty_response)));

  // 再次发生：计数累加、时间戳更新
  const first = s.droppedAt.llm_empty_response;
  bumpDrop(s, 'llm_empty_response');
  assert.strictEqual(s.dropped.llm_empty_response, 2);
  assert.ok(s.droppedAt.llm_empty_response >= first, '时间戳应更新为最新');

  // 不同类别互不影响
  bumpDrop(s, 'unparsed');
  assert.strictEqual(s.dropped.unparsed, 1);
  assert.ok(s.droppedAt.unparsed);
  assert.strictEqual(s.dropped.llm_empty_response, 2, '其他类别不应被改动');
});

test('bumpDrop：空 reason 归为 unknown（保持既有行为）', () => {
  const s = {};
  bumpDrop(s, '');
  assert.strictEqual(s.dropped.unknown, 1);
  assert.ok(s.droppedAt.unknown);
});

// ---------------- 4a 心跳健康告警：failStreak 连击语义 ----------------
// 监督器静默死亡问题：审查连续失败只进 dropped 计数，用户无感知。
// failStreak 让"连续失败"成为可检测状态，UPS 侧据此注入健康告警。

test('4a failStreak：freshState 初始化为 null / healthNotifiedAt 为空', () => {
  const s = freshState('x', '', true);
  assert.strictEqual(s.failStreak, null);
  assert.strictEqual(s.healthNotifiedAt, '');
});

test('4a failStreak：同因累加到 3', () => {
  const s = freshState('x', '', true);
  bumpDrop(s, 'llm_http_401');
  bumpDrop(s, 'llm_http_401');
  bumpDrop(s, 'llm_http_401');
  assert.deepStrictEqual(s.failStreak, { reason: 'llm_http_401', count: 3 });
  // 既有 dropped/droppedAt 行为不变
  assert.strictEqual(s.dropped.llm_http_401, 3);
  assert.ok(s.droppedAt.llm_http_401);
});

test('4a failStreak：白名单异因切换重置为 1', () => {
  const s = freshState('x', '', true);
  bumpDrop(s, 'llm_http_401');
  bumpDrop(s, 'llm_http_401');
  bumpDrop(s, 'unparsed');
  assert.deepStrictEqual(s.failStreak, { reason: 'unparsed', count: 1 });
  // llm_* 家族内部切换同样重置
  bumpDrop(s, 'llm_empty_response');
  bumpDrop(s, 'llm_timeout');
  assert.deepStrictEqual(s.failStreak, { reason: 'llm_timeout', count: 1 });
});

test('4a failStreak：非白名单原因冻结不改写', () => {
  const s = freshState('x', '', true);
  bumpDrop(s, 'llm_http_401');
  bumpDrop(s, 'llm_http_401');
  // 审查没跑成 ≠ 审查失败：busy/global_busy/worker_error/spawn_failed/queue_overflow 冻结
  bumpDrop(s, 'busy');
  bumpDrop(s, 'global_busy');
  bumpDrop(s, 'worker_error');
  bumpDrop(s, 'spawn_failed');
  bumpDrop(s, 'queue_overflow');
  assert.deepStrictEqual(s.failStreak, { reason: 'llm_http_401', count: 2 });
  // 非 llm_ 前缀的相近名不得误匹配（startsWith('llm_') 要求下划线）
  bumpDrop(s, 'llmfoo');
  assert.deepStrictEqual(s.failStreak, { reason: 'llm_http_401', count: 2 });
  // dropped 计数照常累加（既有行为不变）
  assert.strictEqual(s.dropped.busy, 1);
});

test('4a failStreak：白名单精确项逐项计入', () => {
  for (const reason of ['unparsed', 'parse_empty', 'no_transcript', 'ledger_write_failed']) {
    const s = freshState('x', '', true);
    bumpDrop(s, reason);
    assert.deepStrictEqual(s.failStreak, { reason, count: 1 }, reason);
  }
  // 空 reason 归为 unknown：非白名单，冻结（不产生 failStreak）
  const s = freshState('x', '', true);
  bumpDrop(s, '');
  assert.strictEqual(s.failStreak, null);
});
