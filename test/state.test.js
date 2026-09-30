'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureState, mutateStateExclusive, loadState, saveState, createLock, countLocks, lockPathFor, freshState
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
