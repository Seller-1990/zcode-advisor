'use strict';

// R01 · companion 单实例锁的原子性回归测试。
//
// 原实现：读锁 → 写唯一临时文件 → **rename 覆盖** → 回读「pid 是否是自己」。
// rename 会静默覆盖，因此两个实例同时启动时可能双双通过回读：
//   A rename → A 回读=自己 → true；B rename → B 回读=自己 → true。
// 结果：两个 companion 同时持锁并发注入（重复注入、角标闪烁）。
//
// 本用例不 mock：真起 N 个子进程、用同一时间对齐它们的起跑线，再断言
// **恰好一个**取得锁。修好后这条断言与时序无关（原子创建只有一个赢家）；
// 原实现在同一时序下会出现 ≥2 个赢家。
//
// 起跑线协议（两部分，缺一不可）：
//   ① ZCA_SYNC_AT 绝对时刻：子进程预热 require 后忙等到该时刻一起调 acquireLock；
//   ② 放行文件：赢家**不立刻退出**，等父进程确认所有子进程都已完成尝试再放行。
//      否则被负载推迟的落败方会在赢家 exit（exit 钩子 unlink 锁）之后拿到空锁，
//      被误计成第二个赢家——那是用例 artifact，不是产品缺陷。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const hostTmp = os.tmpdir();
const fixture = fs.mkdtempSync(path.join(hostTmp, 'zca-singleton-'));
// 锁文件落在 os.tmpdir()：给子进程一个隔离的临时目录，绝不碰宿主租约。
const TMP = path.join(fixture, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const CONTROLLER = process.env.ZCA_CONTROLLER_PATH ||
  path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs');
const LOCK = path.join(TMP, 'zcode-advisor-companion.lock');

test.after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(hostTmp) + path.sep + 'zca-singleton-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

const CHILD = `
const fs = require('fs');
const { _internal } = require(process.env.ZCA_CONTROLLER);
const until = Number(process.env.ZCA_SYNC_AT);
while (Date.now() < until) { /* 对齐起跑线 */ }
const ok = _internal.acquireLock();
process.stdout.write('ACQUIRED=' + (ok ? '1' : '0') + '\\n');
if (ok) {
  // 赢家活到父进程放行为止：让落败方读到「持锁者存活」而不是「锁文件已消失」。
  const release = process.env.ZCA_RELEASE_FILE;
  const waitUntil = Date.now() + 20000;
  while (Date.now() < waitUntil) {
    try { if (fs.existsSync(release)) break; } catch (_) {}
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch (_) {}
  }
}
process.exit(0);
`;

function runChild(syncAt, releaseFile, onReported) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD], {
      env: Object.assign({}, process.env, {
        HOME: fixture,
        USERPROFILE: fixture,
        TMPDIR: TMP,
        TMP: TMP,
        TEMP: TMP,
        ZCA_CONTROLLER: CONTROLLER,
        ZCA_SYNC_AT: String(syncAt),
        ZCA_RELEASE_FILE: releaseFile,
        ZCODE_ADVISOR_COMPANION_LOG: path.join(fixture, 'companion.log')
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let reported = false;
    child.stdout.on('data', (d) => {
      out += d;
      if (!reported && /ACQUIRED=[01]/.test(out)) { reported = true; onReported(); }
    });
    const finish = () => resolve(out.includes('ACQUIRED=1') ? 1 : 0);
    child.on('exit', finish);
    child.on('error', finish);
  });
}

// 跑一轮并发争抢，返回赢家个数。setup 负责摆好这一轮的初始锁文件状态。
async function raceOnce(N, setup) {
  setup();
  const release = path.join(fixture, `release-${process.pid}-${Date.now()}-${N}`);
  try { fs.unlinkSync(release); } catch (_) {}
  let reported = 0;
  let reachAll;
  const allReported = new Promise((res) => { reachAll = res; });
  const syncAt = Date.now() + 700;
  const children = Array.from({ length: N }, () => runChild(syncAt, release, () => {
    reported += 1;
    if (reported === N) reachAll();
  }));
  const guard = new Promise((res) => setTimeout(res, 20000)); // 子进程异常时不永久挂住
  await Promise.race([allReported, guard]);
  fs.writeFileSync(release, 'go'); // 放行赢家（赢家 exit 时清掉自己的锁）
  const results = await Promise.all(children);
  return results.reduce((a, b) => a + b, 0);
}

test('R01：并发启动恰好一个实例取得单实例锁', async () => {
  const N = 8;
  for (let trial = 1; trial <= 3; trial++) {
    try { fs.unlinkSync(LOCK); } catch (_) {}
    const wins = await raceOnce(N, () => {});
    assert.strictEqual(wins, 1, `第 ${trial} 轮：应恰好 1 个实例取得锁，实际 ${wins}`);
  }
});

// 同一竞态的另一半：锁路径上已经躺着一把**陈旧**锁（持锁进程已死），N 个实例同时接管。
//
// 残留竞态（R22）：「读陈旧 → rename 移走 → 排他创建」是三段，rename 会把对手
// 在两步之间刚建好的**新鲜**租约一起搬走；若随后的「放回原位」恰好撞上第三方又
// 建好的新锁（EEXIST），被搬走那把租约就永久留在隔离文件名下——原主人仍自认持锁，
// 锁路径却空着留给下一个人：两个实例同时持锁。
// 因此这里用更大的 N 跑多轮：单轮复现率随候选数上升，修好后必须轮轮恰好 1 个赢家。
test('R01：陈旧锁上的并发接管同样只有一个赢家', async () => {
  const N = 12;
  for (let trial = 1; trial <= 4; trial++) {
    const staleTs = Date.now() - 10 * 60 * 1000; // 远超 60s TTL
    const wins = await raceOnce(N, () => {
      // pid 不存在 + started 超 TTL → isStale 必判陈旧（TTL 在 pid 存活探测之前）。
      fs.writeFileSync(LOCK, `pid=2147483646\nstarted=${staleTs}\ncdp=0\ncdpSince=${staleTs}\n`, 'utf8');
    });
    assert.strictEqual(wins, 1, `第 ${trial} 轮：陈旧锁接管应恰好 1 个赢家，实际 ${wins}`);
  }
});
