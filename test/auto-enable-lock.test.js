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

// 跑一次 auto-enable，返回它写入的日志（不含 stdout，因为日志只写文件）
function runAutoEnable() {
  const logFile = path.join(os.tmpdir(), `zca-ae-${process.pid}-${Date.now()}.log`);
  try {
    execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: Object.assign({}, process.env, { ZCODE_ADVISOR_COMPANION_LOG: logFile })
    });
  } catch (_) { /* 非 0 退出也算，看日志判断 */ }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  try { fs.rmSync(logFile, { force: true }); } catch (_) {}
  return log;
}

test('存活 pid 且未超 TTL：跳过（不误接管）', () => {
  resetLock();
  // pid 1 在类 Unix 上必然存在（launchd/init）；用 kill(pid,0) 会得到 EPERM
  writeLock(1, Date.now());
  const log = runAutoEnable();
  assert.match(log, /已有自动启用实例在运行/, '应识别为有效锁并跳过');
  resetLock();
});

test('存活 pid 但超 TTL：接管（防 pid 复用永久阻塞）', () => {
  resetLock();
  writeLock(1, Date.now() - 6 * 60 * 1000);   // 超过 5 分钟 TTL
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
