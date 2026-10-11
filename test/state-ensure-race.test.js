'use strict';
// R03：ensureState 的「先检查存在、再写入」窗口。
// 场景：A 判定 state 不存在 → 对手 B 在同一窗口内创建了 state（enabled=false + 一条待处理笔记）
//       → A 继续落盘自己的 freshState，覆盖掉 B 的决定与笔记（enabled 复活成开启、笔记清零）。
// 复现方式（确定性、不需要真并发）：只让 hooks/lib/state.js 拿到的 fs 在那一刻对目标文件
// 谎报一次 existsSync=false，其余一律走真实 fs —— 盘上文件确实已由「B」写好。
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const realFs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = 'race-session';
const fixture = realFs.mkdtempSync(path.join(os.tmpdir(), 'zca-state-ensure-'));
const stateDir = path.join(fixture, 'state');

let lieFor = null; // 只对这个绝对路径谎报一次「不存在」
const patchedFs = Object.create(realFs);
patchedFs.existsSync = (p) => {
  if (lieFor && p === lieFor) { lieFor = null; return false; }
  return realFs.existsSync(p);
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === 'fs' && /hooks[\\/]lib[\\/]state\.js$/.test(from)) return patchedFs;
  return origLoad.apply(this, arguments);
};
let state;
try {
  state = require('../hooks/lib/state.js');
} finally {
  Module._load = origLoad;
}

test('ensureState 不得覆盖窗口内对手已写入的状态（enabled/笔记）', () => {
  realFs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = state.stateFilePath(stateDir, SESSION);
  try { realFs.rmSync(file, { force: true }); } catch (_) {}

  // 「B」：在 A 的 existsSync 与落盘之间创建 state —— 用户关闭审查并留下一条笔记。
  const b = state.freshState(SESSION, '/tmp/transcript-B.jsonl', true);
  b.enabled = false;
  b.disabledReason = '用户显式关闭';
  b.pendingNotes = ['B 写入的笔记'];
  realFs.writeFileSync(file, JSON.stringify(b, null, 2), { encoding: 'utf8', mode: 0o600 });

  // 「A」：刚才读到的是「不存在」，于是继续走创建路径。
  lieFor = file;
  const res = state.ensureState(stateDir, SESSION, '/tmp/transcript-A.jsonl', true);

  assert.equal(res.created, false, '窗口内对手已创建 → 本次不得自认 created');
  assert.equal(res.state.enabled, false, 'A 不得把 B 的「关闭」复活成开启');
  assert.deepEqual(res.state.pendingNotes, ['B 写入的笔记'], 'A 不得清空 B 的待处理笔记');

  const onDisk = JSON.parse(realFs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.enabled, false, '盘上 enabled 必须仍是 B 的决定');
  assert.deepEqual(onDisk.pendingNotes, ['B 写入的笔记'], '盘上笔记必须保留');
});

test.after(() => {
  assert.ok(fixture.startsWith(os.tmpdir()), 'fixture 必须位于系统临时目录内');
  realFs.rmSync(fixture, { recursive: true, force: true });
});
