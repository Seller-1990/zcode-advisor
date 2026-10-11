// R24：写锁（${file}.wrlock）陈旧判定只看 mtime ⇒ 崩溃残留的锁会让随后约 10s 内**所有**状态写静默丢弃。
//
// hooks/lib/state.js withExclusiveLock：'wx' 失败 → 仅当 mtime 超 staleMs(默认 10000) 才 unlink
// → sleep 25ms 重试，预算 retries(默认 40)×25ms ≈ 1s。
// 于是「1s 重试预算」远小于「10s 陈旧判定」：任何崩溃/被 KILL 的持锁者留下的锁，
// 会让紧接着的写全部返回 null。实测（.audit-evidence/r24-probe.log）：
//   残留锁 pid 已死、mtime 年龄 0ms → mutateStateExclusive 1140ms 后返回 null，状态文件未变。
// 调用方忽略 null（如 worker 最终落盘 hooks/advisor-hook.js:1062）⇒ 本次审查结果彻底消失，
// 连健康信标一起丢（beaconPayload 在临界区内赋值，锁没拿到就一直是 null）。
//
// 本用例固定两条不变量：死属主的锁必须立即回收；活属主的锁绝不能被抢。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const state = require(path.join(__dirname, '..', 'hooks', 'lib', 'state.js'));

function makeState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-wrlock-'));
  const file = path.join(dir, 'sess-wr.json');
  state.saveState(file, Object.assign(state.freshState('wr', '', true), { lastAction: 'initial' }));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, lock: `${file}.wrlock` };
}

function lastAction(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).lastAction;
}

// 真派一个子进程并让它退出：比魔数更贴近「持锁者崩溃」的现场
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(String(r.stdout).trim());
}

function waitAlive(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { process.kill(pid, 0); return true; } catch (_) { /* 还没起来 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return false;
}

test('R24：属主进程已死的残留写锁必须立即回收，写入不得被静默丢弃', (t) => {
  const { file, lock } = makeState(t);
  const pid = deadPid();
  fs.writeFileSync(lock, String(pid), { flag: 'wx' });
  const t0 = Date.now();
  const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'after-dead-owner'; });
  const ms = Date.now() - t0;
  assert.ok(ret, `属主 pid ${pid} 已死的残留锁必须被回收并完成写入，实际返回 null（本次写入被静默丢弃）`);
  assert.strictEqual(lastAction(file), 'after-dead-owner', '写入必须落盘');
  assert.ok(ms < 1000, `死属主的锁应被立即回收，实际耗时 ${ms}ms（旧实现要等重试预算耗尽/ mtime 超 10s）`);
  assert.ok(!fs.existsSync(lock), '写完必须释放锁');
});

test('R24：活属主的写锁绝不能被抢（否则双写者复活）', async (t) => {
  const { file, lock } = makeState(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  assert.ok(waitAlive(child.pid, 5000), '夹具未就绪：冒充持锁者的子进程没起来');
  fs.writeFileSync(lock, String(child.pid), { flag: 'wx' });
  const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'must-not-happen'; }, { retries: 4 });
  assert.strictEqual(ret, null, '活属主的锁不得被抢');
  assert.strictEqual(lastAction(file), 'initial', '被抢时会双写，状态不得被改动');
  assert.strictEqual(fs.readFileSync(lock, 'utf8').trim(), String(child.pid), '活属主的锁内容不得被改动');
});

test('R24：内容为空的锁不得被当成死属主（创建→写入之间的窗口，回收会造成双写者）', (t) => {
  const { file, lock } = makeState(t);
  fs.writeFileSync(lock, '', { flag: 'wx' }); // writeFileSync 先 O_CREAT 再写内容，此刻内容为空
  const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'must-not-happen'; }, { retries: 4 });
  assert.strictEqual(ret, null, '空内容锁不得被回收');
  assert.strictEqual(lastAction(file), 'initial');
  assert.ok(fs.existsSync(lock), '空内容锁必须留在原处，由 mtime 规则接管');
});

test('R24：mtime 超 staleMs 的锁仍按原规则回收（既有行为不得回退）', (t) => {
  const { file, lock } = makeState(t);
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const old = Date.now() / 1000 - 30;
  fs.utimesSync(lock, old, old);
  const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'after-stale-mtime'; });
  assert.ok(ret, '陈旧锁必须按 mtime 规则被回收');
  assert.strictEqual(lastAction(file), 'after-stale-mtime');
});
