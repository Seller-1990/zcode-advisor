'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decideAction, decideActionAsync, prefixFor, applyDeliveryToState, enqueueNote } = require('../hooks/lib/route');

const CFG = { maxBlocksPerTurn: 2, immuneTurns: 3, pendingNotesCap: 5 };

test('nit 永远进顺延队列，不受冷却与上限影响', () => {
  const state = { immuneTurns: 3, consecutiveSteers: 2 };
  assert.deepStrictEqual(decideAction({ severity: 'nit' }, state, CFG), { deliver: 'queue' });
});

test('concern：无冷却立即 block；冷却期内降级为顺延', () => {
  assert.deepStrictEqual(decideAction({ severity: 'concern' }, { immuneTurns: 0, consecutiveSteers: 0 }, CFG), { deliver: 'block' });
  const r = decideAction({ severity: 'concern' }, { immuneTurns: 2, consecutiveSteers: 0 }, CFG);
  assert.strictEqual(r.deliver, 'queue');
  assert.strictEqual(r.deferred, true);
});

test('blocker：绕过冷却，但仍受单轮 steer 上限约束', () => {
  assert.deepStrictEqual(decideAction({ severity: 'blocker' }, { immuneTurns: 3, consecutiveSteers: 0 }, CFG), { deliver: 'block' });
  const r = decideAction({ severity: 'blocker' }, { immuneTurns: 0, consecutiveSteers: 2 }, CFG);
  assert.strictEqual(r.deliver, 'queue');
  assert.strictEqual(r.deferred, true);
});

test('none 与未知 severity 不产出动作', () => {
  assert.deepStrictEqual(decideAction({ severity: 'none' }, {}, CFG), { deliver: 'none' });
  assert.deepStrictEqual(decideAction({ severity: 'weird' }, {}, CFG), { deliver: 'none' });
});

test('送达后设置冷却并计数 steer；未送达则冷却递减', () => {
  const s1 = { immuneTurns: 0, consecutiveSteers: 0, steers: 0 };
  applyDeliveryToState(s1, true, CFG);
  assert.strictEqual(s1.immuneTurns, 3);
  assert.strictEqual(s1.consecutiveSteers, 1);
  assert.strictEqual(s1.steers, 1);

  const s2 = { immuneTurns: 3, consecutiveSteers: 0 };
  applyDeliveryToState(s2, false, CFG);
  assert.strictEqual(s2.immuneTurns, 2);
  assert.strictEqual(s2.immuneTurns >= 0, true);
});

test('顺延队列：容量上限触发 queue_overflow', () => {
  const state = { pendingNotes: ['a', 'b', 'c', 'd', 'e'] };
  let overflow = '';
  const ok = enqueueNote(state, 'f', CFG, (reason) => { overflow = reason; });
  assert.strictEqual(ok, false);
  assert.strictEqual(overflow, 'queue_overflow');
  assert.strictEqual(state.pendingNotes.length, 5);
});

test('deferred 前缀区分', () => {
  assert.strictEqual(prefixFor('concern', false), '[advisor:concern]');
  assert.strictEqual(prefixFor('concern', true), '[advisor:concern:deferred]');
});

test('异步路由：全部进队列；concern 受冷却标记 deferred，blocker 不受', () => {
  assert.deepStrictEqual(decideActionAsync({ severity: 'nit' }, { immuneTurns: 0 }, CFG), { deliver: 'queue', deferred: false });
  assert.deepStrictEqual(decideActionAsync({ severity: 'blocker' }, { immuneTurns: 3 }, CFG), { deliver: 'queue', deferred: false });
  const cooled = decideActionAsync({ severity: 'concern' }, { immuneTurns: 1 }, CFG);
  assert.strictEqual(cooled.deliver, 'queue');
  assert.strictEqual(cooled.deferred, true);
  const fresh = decideActionAsync({ severity: 'concern' }, { immuneTurns: 0 }, CFG);
  assert.strictEqual(fresh.deferred, false);
  assert.deepStrictEqual(decideActionAsync({ severity: 'none' }, {}, CFG), { deliver: 'none' });
});
