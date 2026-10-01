'use strict';

// auto-enable 单飞锁的行为测试。
//
// 背景：两个调用点（.app 启动器、controller 启动）会先后/并发跑到 auto-enable，
// 需要保证 CLI 序列不被重复或并发执行。锁本身出错的后果是**功能完全失效**：
//   - 误判"持锁者仍在"（如 pid 复用/errno 处理错）→ 每次启动都跳过
//     → 干净机器上插件永远装不上且无重试；
//   - 误判"锁已陈旧"（非原子接管）→ 两个进程并发跑 CLI。
//
// 这里用真实子进程 + 真实锁文件验证，不 mock（锁的原子性只有真跑才能验证）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'tools', 'companion', 'auto-enable.cjs');
const LOCK = path.join(os.homedir(), '.zcode', 'advisor-auto-enable.lock');
const INFO = path.join(LOCK, 'info');

function resetLock() {
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) {}
}

function writeLock(pid, started) {
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(INFO, `pid=${pid}\nstarted=${started}\n`, 'utf8');
}

// 跑一次 auto-enable，返回它写入的日志（不含 stdout，因为日志只写文件）。
//
// **隔离宿主 CLI**：把 ZCODE_ADVISOR_ZCODE_PATH 指向临时目录里的一个假 ZCode 可执行文件，
// 其旁边没有 zcode.cjs → 探测链在「未找到 ZCode CLI」处终止，于是**不会真的调用宿主 CLI**。
// 不隔离时实测一次 npm test 会真实执行
//   plugins marketplace add/update + install + enable
// 改动本机 ZCode 的插件安装（审计报告 A4），测试必须不产生这种副作用。
function runAutoEnable() {
  const logFile = path.join(os.tmpdir(), `zca-ae-${process.pid}-${Date.now()}.log`);
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-ae-bin-'));
  const fakeZcode = path.join(binDir, process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');
  fs.writeFileSync(fakeZcode, '');
  try {
    execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: Object.assign({}, process.env, {
        ZCODE_ADVISOR_COMPANION_LOG: logFile,
        ZCODE_ADVISOR_ZCODE_PATH: fakeZcode
      })
    });
  } catch (_) { /* 非 0 退出也算，看日志判断 */ }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  try { fs.rmSync(logFile, { force: true }); } catch (_) {}
  try { fs.rmSync(binDir, { recursive: true, force: true }); } catch (_) {}
  return log;
}

// 一个「在当前平台上确实存活」的 pid：测试进程自身（它是 auto-enable 子进程的父进程）。
// 早期用例用 pid 1，依赖「类 Unix 上 init/launchd 必然存在且 kill 返回 EPERM」——
// Windows 没有 pid 1，kill(1,0) 直接 ESRCH，会被判陈旧而接管 → 用例假失败（审计报告 A3）。
const LIVE_PID = process.pid;

test('存活 pid 且未超 TTL：跳过（不误接管）', () => {
  resetLock();
  writeLock(LIVE_PID, Date.now());
  const log = runAutoEnable();
  assert.match(log, /已有自动启用实例在运行/, '应识别为有效锁并跳过');
  resetLock();
});

test('存活 pid 但超 TTL：接管（防 pid 复用永久阻塞）', () => {
  resetLock();
  writeLock(LIVE_PID, Date.now() - 6 * 60 * 1000);   // 超过 5 分钟 TTL
  const log = runAutoEnable();
  assert.match(log, /陈旧自动启用锁/, '超 TTL 应判定陈旧并接管');
  assert.ok(!/已有自动启用实例在运行/.test(log), '不应仍被阻塞');
  resetLock();
});

test('不存在的 pid：判定陈旧并接管', () => {
  resetLock();
  writeLock(999999, Date.now());
  const log = runAutoEnable();
  assert.match(log, /陈旧自动启用锁/, '死 pid 应接管');
  resetLock();
});

test('无锁：正常获取（不跳过）', () => {
  resetLock();
  const log = runAutoEnable();
  assert.ok(!/已有自动启用实例在运行/.test(log), '无锁时不应跳过');
  assert.match(log, /幂等快路径|插件市场|未找到 ZCode CLI/, '应有实际执行痕迹');
  resetLock();
});

test('锁在进程退出后被释放（不留下永久锁）', () => {
  resetLock();
  runAutoEnable();
  assert.ok(!fs.existsSync(INFO) || !fs.existsSync(LOCK),
    '进程退出后应释放锁，否则下次启动会被自己卡住');
  resetLock();
});

// 回归（审计报告 A4）：本用例组曾真实执行 plugins marketplace add/update/install/enable，
// 改动本机 ZCode 的插件安装。现在必须停在「未找到 ZCode CLI」且日志里没有任何 CLI 调用痕迹。
test('隔离：测试不真实调用宿主 CLI（不改动本机插件安装）', () => {
  resetLock();
  const log = runAutoEnable();
  assert.match(log, /未找到 ZCode CLI/, '应停在探测链末端（隔离生效的证据）');
  assert.ok(!/✓ plugins /.test(log), `不应出现真实 CLI 调用痕迹：\n${log}`);
  resetLock();
});
