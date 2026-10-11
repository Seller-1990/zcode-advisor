'use strict';
// R24c：lockOwnerAlive 的 errno 完备性（推送前补强）。
//
// 规则必须是「**只有 ESRCH 算已死**，其余 errno 一律保守算活」：
//   误判方向不对称 —— 把死属主当活，最多多等一次 mtime 兜底（staleMs 10s）；
//   把活属主当死，会删掉活持有者的锁 ⇒ 双写者复活 ⇒ 审查结果与信标静默消失，
//   正是 R24 要防的那个丢写方向。
// 背景：libuv 在 Windows 把 access denied 映射成 EACCES（不是 POSIX 的 EPERM），
// 早期「只认 EPERM 算活」的写法在 Windows 上会把「活着但无权 signal」的属主判成已死。
// 本机 macOS 只能覆盖 EPERM 分支，故用注入 errno 把规则本身钉死，并留三平台观测输出。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE = process.env.ZCA_STATE_PATH || path.join(ROOT, 'hooks', 'lib', 'state.js');
const state = require(STATE);

// 我们无权 open 的活进程：POSIX 上是 root 的 pid 1；Windows 上是 pid 4（System）。
const DENIED_PID = process.platform === 'win32' ? 4 : 1;

function rawErrCode(pid) {
  try { process.kill(pid, 0); return null; } catch (err) { return (err && err.code) || 'UNKNOWN'; }
}

async function waitAlive(pid, timeoutMs) {
  const end = Date.now() + (timeoutMs || 3000);
  while (Date.now() < end) {
    if (rawErrCode(pid) === null) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(String(r.stdout).trim());
}

test('R24c：注入各类 errno —— 只有 ESRCH 算已死', () => {
  const orig = process.kill;
  try {
    for (const code of ['EPERM', 'EACCES', 'EINVAL', 'EWHATEVER']) {
      process.kill = () => { throw Object.assign(new Error(code), { code }); };
      assert.strictEqual(state.lockOwnerAlive(424242), true,
        `errno=${code} 必须保守判为「活着」（判成死会删掉活持有者的锁 → 双写者）`);
    }
    process.kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
    assert.strictEqual(state.lockOwnerAlive(424242), false, 'ESRCH = 进程不存在，才算已死');
  } finally {
    process.kill = orig;
  }
});

test('R24c：真·活子进程判为活着；真·已退出 pid 按实测 errno 语义处理', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    assert.ok(await waitAlive(child.pid), '子进程未在预算内起来');
    assert.strictEqual(state.lockOwnerAlive(child.pid), true, '活子进程必须判为活着');
  } finally {
    child.kill('SIGKILL');
  }

  const dead = deadPid();
  const code = rawErrCode(dead);
  console.log(`[R24c 观测] ${process.platform} 已退出 pid=${dead} kill(pid,0) errno=${code}`);
  if (code === 'ESRCH') {
    assert.strictEqual(state.lockOwnerAlive(dead), false, 'ESRCH ⇒ 已死');
  } else {
    // 如实披露：若宿主把「不存在」报成非 ESRCH，死属主回收会退化为 mtime 规则（安全但慢）。
    console.log(`[R24c 披露] ${process.platform} 上已退出的 pid 报 ${code}（非 ESRCH）`
      + ' ⇒ 死属主回收退化为 mtime 规则（安全，但要多等 staleMs）');
  }
});

test('R24c：无权 signal 的活进程必须判为活着，且它持有的新鲜锁不得被回收', () => {
  const code = rawErrCode(DENIED_PID);
  console.log(`[R24c 观测] ${process.platform} pid=${DENIED_PID}（无权 open）kill(pid,0) errno=${code}`);
  assert.strictEqual(state.lockOwnerAlive(DENIED_PID), true,
    `无权 signal 的活进程（errno=${code}）必须判为活着`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24c-'));
  const file = path.join(dir, 'sess-x.json');
  state.saveState(file, state.freshState('x', '', true));
  // 新鲜 mtime 的残留写锁 + 「无权 signal 的活属主」⇒ 只能靠存活判定，不能靠 mtime
  fs.writeFileSync(`${file}.wrlock`, String(DENIED_PID), 'utf8');
  const ret = state.mutateStateExclusive(file, (s) => { s.lastAction = 'should-not-happen'; });
  assert.strictEqual(ret, null, '无权 signal 的活持有者：锁不得被回收，写必须放弃（宁等 mtime，不双写）');
  assert.notStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).lastAction, 'should-not-happen',
    '放弃写入时状态文件不得被改动');
  assert.ok(fs.existsSync(`${file}.wrlock`), '活持有者的锁不得被删');
  fs.rmSync(dir, { recursive: true, force: true });
});
