// R24 探针：写锁（${file}.wrlock）被「崩溃残留」占住时，状态写会怎样？
//
// 现场机制（hooks/lib/state.js withExclusiveLock）：
//   取锁失败 → 只在 mtime 超过 staleMs(默认 10000) 时才 unlink 陈旧锁 → sleep 25ms 重试
//   重试预算 retries(默认 40) × 25ms ≈ 1s ⇒ **1s 预算 vs 10s 陈旧判定**
//   ⇒ 任何崩溃/被 KILL 的持锁者留下的锁，会让随后约 10 秒内**所有**状态写静默返回 null。
// 调用方（如 worker 最终落盘 hooks/advisor-hook.js:1062）忽略 null ⇒ 本次结果彻底消失
// （连健康信标也丢：beaconPayload 在临界区内赋值，锁没拿到就一直是 null）。
//
// 用法：node .audit-evidence/r24-probe.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const state = require(path.join(ROOT, 'hooks', 'lib', 'state.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-probe-'));
const file = path.join(dir, 'sess-r24.json');
state.saveState(file, Object.assign(state.freshState('r24', '', true), { lastAction: 'initial' }));

function deadPid() {
  // 真派一个子进程并让它退出，拿到一个「刚刚死掉」的 pid（比魔数更贴近真实现场）
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  void r;
  const p = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const pid = Number(String(p.stdout).trim());
  // 它已退出；再确认一次
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
  return { pid, alive };
}

console.log('stateDir =', dir);
console.log('stateFile =', file);

// —— 场景 A：残留锁（内容 = 已死 pid，mtime = 现在）——
const { pid, alive } = deadPid();
const lockFile = `${file}.wrlock`;
fs.writeFileSync(lockFile, String(pid), { flag: 'wx' });
console.log(`A) 残留锁 pid=${pid} 仍活着=${alive} mtime 年龄=${Math.round(Date.now() - fs.statSync(lockFile).mtimeMs)}ms`);

const t0 = Date.now();
const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'A-written'; });
const ms = Date.now() - t0;
const after = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`A) mutateStateExclusive 返回 ${ret === null ? 'null（静默丢弃）' : 'state'}，耗时 ${ms}ms`);
console.log(`A) 状态文件 lastAction = ${JSON.stringify(after.lastAction)} ⇒ ${after.lastAction === 'A-written' ? '写入成功' : '写入丢失'}`);
console.log(`A) 锁是否残留 = ${fs.existsSync(lockFile)}`);

// —— 场景 B：活着的持锁者（内容 = 活 pid，mtime = 现在）——
// 期望：不得被抢（否则会双写者）。用当前进程自己的 pid 冒充一个「活着的持有者」。
try { fs.unlinkSync(lockFile); } catch (_) {}
fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
const t1 = Date.now();
const ret2 = state.mutateStateExclusive(file, (s) => { s.lastAction = 'B-written'; });
const ms2 = Date.now() - t1;
console.log(`B) 活持锁者（自己 pid）→ 返回 ${ret2 === null ? 'null（放弃写入）' : 'state'}，耗时 ${ms2}ms，锁仍在=${fs.existsSync(lockFile)}`);

// —— 场景 C：陈旧（mtime 超过 staleMs）——
fs.unlinkSync(lockFile);
fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
const old = Date.now() / 1000 - 30;
fs.utimesSync(lockFile, old, old);
const t2 = Date.now();
const ret3 = state.mutateStateExclusive(file, (s) => { s.lastAction = 'C-written'; });
const ms3 = Date.now() - t2;
const after3 = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`C) 陈旧 30s 的锁 → 返回 ${ret3 === null ? 'null' : 'state'}，耗时 ${ms3}ms，lastAction=${JSON.stringify(after3.lastAction)}`);

fs.rmSync(dir, { recursive: true, force: true });
