'use strict';

// R02 · auto-enable 单飞锁的「租约续期」与「认主释放」回归测试。
//
// 两个真实缺陷（冻结报告 R02；`tools/companion/auto-enable.cjs`）：
//   T1 租约不续期：LOCK_TTL_MS = 5 分钟，而单次启用最坏 60s(alreadyEnabled)
//      + 4×120s(CLI 步骤) = 540s ≈ 9 分钟。跑到第 6 分钟，后到的实例（或第二次
//      启动）会把仍在干活的持锁者判成「陈旧」并接管 → 两个实例同时对同一份宿主
//      插件缓存跑 marketplace/install/enable。TTL 本身不能简单调大：现有用例
//      （test/auto-enable-lock.test.js「存活 pid 但超 TTL → 接管」）要求
//      「pid 被复用、没人续租」的锁最终必须能被接管，否则干净机器永久装不上。
//      正解是持锁者在步骤边界续租：真实持锁者永不超时，死锁仍会超时。
//   T2 释放不认主：finally / process.on('exit') 无条件 rmSync 锁目录。租约一旦
//      被接管，先退出的进程会把**接管者的锁**删掉 → 后来者又能拿到锁 → 并发执行。
//
// 两条都真起子进程、真读锁文件，不 mock（锁的时序只有真跑才能验证）。
// 假 ZCode CLI 停在 fixture 内，不会碰本机 ZCode 的插件安装。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const hostTmp = os.tmpdir();
const fixture = fs.mkdtempSync(path.join(hostTmp, 'zca-auto-enable-lease-'));
const HOME = fixture;
const TMP = path.join(fixture, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const SCRIPT = process.env.ZCA_AUTO_ENABLE_PATH ||
  path.join(__dirname, '..', 'tools', 'companion', 'auto-enable.cjs');
const LOCK = path.join(HOME, '.zcode', 'advisor-auto-enable.lock');
const INFO = path.join(LOCK, 'info');
const LOG = path.join(fixture, 'auto-enable.log');

test.after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(hostTmp) + path.sep + 'zca-auto-enable-lease-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resetLock() {
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(LOG, { force: true }); } catch (_) {}
  // 本用例只针对「租约续期 / 认主释放」两条语义，因此先备好 ~/.zcode 父目录。
  // 干净 HOME 上父目录缺失导致 acquireSingleFlight 静默失败（并谎报"已有实例"）
  // 是另一条独立缺陷（R20），由 test/auto-enable-clean-home.test.js 覆盖。
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
}

function readInfo() {
  try {
    const txt = fs.readFileSync(INFO, 'utf8');
    return {
      pid: Number(((/(?:^|\n)pid=(\d+)/.exec(txt) || [])[1]) || 0),
      started: Number(((/(?:^|\n)started=(\d+)/.exec(txt) || [])[1]) || 0)
    };
  } catch (_) {
    return null;
  }
}

// 假 ZCode：<fixture>/zcodebin/ZCode + <fixture>/Resources/glm/zcode.cjs
// （cli 探测链上溯 exeDir/../Resources/glm/zcode.cjs，正是真机 macOS 的布局）。
// `plugins list` 耗时 listMs（让「取得锁」与「首次续租」之间有可观测的间隔），
// `marketplace add` 耗时 addMs（模拟长安装，留出干预窗口），其余步骤立即返回。
function makeFakeZcode(listMs, addMs) {
  const binDir = path.join(fixture, 'zcodebin');
  const resDir = path.join(fixture, 'Resources', 'glm');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  const exe = path.join(binDir, process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');
  fs.writeFileSync(exe, '', { mode: 0o755 });
  fs.writeFileSync(path.join(resDir, 'zcode.cjs'), `
const args = process.argv.slice(2);
const sleep = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* busy */ } };
if (args.includes('list')) { sleep(${listMs}); process.stdout.write('no plugins\\n'); }
else if (args.includes('add')) { sleep(${addMs}); }
process.exit(0);
`, 'utf8');
  return exe;
}

function childEnv(exe) {
  return Object.assign({}, process.env, {
    HOME,
    USERPROFILE: HOME,
    TMPDIR: TMP,
    TMP,
    TEMP: TMP,
    ZCODE_ADVISOR_ZCODE_PATH: exe,
    ZCODE_ADVISOR_COMPANION_LOG: LOG
  });
}

function spawnAutoEnable(exe) {
  const child = spawn(process.execPath, [SCRIPT], { env: childEnv(exe), stdio: 'ignore' });
  const state = { exited: false };
  child.on('exit', () => { state.exited = true; });
  return { child, state };
}

test('R02-T1：启用流程运行期间必须续租（否则长安装会被判陈旧接管）', async () => {
  resetLock();
  const exe = makeFakeZcode(400, 1200);
  const { child, state } = spawnAutoEnable(exe);
  const seen = new Set();
  const deadline = Date.now() + 20000;
  while (!state.exited && Date.now() < deadline) {
    const info = readInfo();
    if (info && info.pid === child.pid) seen.add(info.started);
    await sleep(40);
  }
  assert.ok(seen.size >= 1, `子进程应取得锁（实际观测到 ${seen.size} 个租约快照）`);
  assert.ok(
    seen.size >= 2,
    `持锁期间 started 必须被续租刷新（实际只观测到 ${seen.size} 个不同的 started：${[...seen]}）`
  );
  assert.doesNotMatch(fs.readFileSync(LOG, 'utf8'), /未找到 ZCode CLI/, '假 CLI 应被识别（否则用例没跑到锁流程）');
});

test('R02-T2：失去所有权后退出，不得删除接管者的锁', async () => {
  resetLock();
  const exe = makeFakeZcode(100, 2500);
  const { child, state } = spawnAutoEnable(exe);
  const deadline = Date.now() + 20000;
  let held = false;
  while (!state.exited && Date.now() < deadline) {
    const info = readInfo();
    if (info && info.pid === child.pid) { held = true; break; }
    await sleep(20);
  }
  assert.ok(held, '子进程应先取得锁（否则用例无效）');
  // 模拟「租约被接管」：第三方（本测试进程，存活 pid）写入自己的租约。
  // 子进程随后退出——旧实现会无条件删掉整个锁目录（连接管者的租约一起删）。
  fs.writeFileSync(INFO, `pid=${process.pid}\nstarted=${Date.now()}\n`, 'utf8');
  const exitDeadline = Date.now() + 20000;
  while (!state.exited && Date.now() < exitDeadline) await sleep(20);
  assert.ok(state.exited, '子进程应已退出');
  const after = readInfo();
  assert.ok(after, '接管者的锁不该被「失去所有权」的进程删掉');
  assert.strictEqual(after.pid, process.pid, '退出时不得把接管者的租约改回自己');
});
