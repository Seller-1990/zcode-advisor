'use strict';

// companion 单实例锁（服务租约）与宿主主实例探测的回归测试。
//
// 背景：真机出过一次故障——controller 附着的 ZCode 被关掉后，它变成僵尸
// （进程活着、占着锁、但 rescan 找不到 CDP 且从不重建通道）。用户再点图标时，
// 新实例在 acquireLock 就静默退出，表现为「点了没反应」，且因为 acquireLock
// 在 ensureCdp 之前，永远走不到「重新拉起 ZCode」那步。
//
// 修复把锁的语义从「进程活着」升级为「服务可用」（TTL + 心跳 + CDP 标记 + 僵尸宽限）。
// 这些判据一旦写错，后果是两个方向都致命：
//   - 判太宽（僵尸不算陈旧）→ 锁被僵尸永久占用，用户永远起不来（原故障）；
//   - 判太严（健康实例被误判陈旧）→ 双实例并发，重复注入、角标闪烁。
// 因此这里对每个分支都用真实文件做行为验证。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离生产日志：controller.cjs:135 在 require 期固化 LOG_FILE。本文件目前不写日志，
// 但「require controller 就必须隔离日志路径」是这里的统一约束——否则将来新增用例
// 一旦走到 startApi/saveUserConfig，噪音会直接落进用户真实日志。
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zca-lock-log-')), 'companion.log');

const { _internal: I } = require('../tools/companion/controller.cjs');
const LOCK = I.LOCK_FILE;

function withLock(content, fn) {
  const bak = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8') : null;
  try {
    if (content === null) { try { fs.unlinkSync(LOCK); } catch (_) {} }
    else fs.writeFileSync(LOCK, content, 'utf8');
    return fn();
  } finally {
    try {
      if (bak === null) fs.unlinkSync(LOCK);
      else fs.writeFileSync(LOCK, bak, 'utf8');
    } catch (_) {}
  }
}

const alivePid = () => process.pid;   // 本进程，保证 kill(pid,0) 成功

test('锁：僵尸（心跳新鲜 + 无 CDP 超宽限）判为陈旧，可被接管', () => {
  const now = Date.now();
  // 关键：started 必须是**新鲜**的（心跳正常），否则会被 TTL 规则先判陈旧，
  // 僵尸规则就永远测不到。僵尸的特征正是「心跳照跳、但服务早已不可用」。
  withLock(`pid=${alivePid()}\nstarted=${now}\ncdp=0\ncdpSince=${now - 4 * 60000}\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), true,
      '心跳正常但长期无 CDP → 必须判僵尸陈旧，否则锁被僵尸永久占用（原故障）');
  });
});

test('锁：心跳超时（started 陈旧）也判陈旧——两道判据都要独立生效', () => {
  const now = Date.now();
  // 这一条专测 TTL 规则（与上一条的僵尸规则互补，避免只覆盖其一）
  withLock(`pid=${alivePid()}\nstarted=${now - 4 * 60000}\ncdp=9333\ncdpSince=${now - 4 * 60000}\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), true, '心跳超时必须判陈旧');
  });
});

test('锁：健康实例（心跳新鲜 + 有 CDP）不判陈旧', () => {
  const now = Date.now();
  withLock(`pid=${alivePid()}\nstarted=${now}\ncdp=9333\ncdpSince=${now}\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), false,
      '健康实例被误判陈旧 → 双实例并发注入');
  });
});

test('锁：刚启动（心跳新鲜、尚未拿到 CDP）不判陈旧——避免启动瞬间被抢锁', () => {
  const now = Date.now();
  withLock(`pid=${alivePid()}\nstarted=${now}\ncdp=0\ncdpSince=${now}\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), false,
      '启动初期 CDP 必然为 0，此时不能判陈旧，否则两个实例互相接管');
  });
});

test('锁：持锁进程已不存在 → 陈旧（pid 复用防护的反面）', () => {
  const now = Date.now();
  // 用一个几乎不可能存在的 pid
  withLock(`pid=999999\nstarted=${now}\ncdp=9333\ncdpSince=${now}\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), true, '进程不存在必须判陈旧，否则干净机器上永远装不上');
  });
});

test('锁：无 started 字段（旧格式/损坏）→ 陈旧', () => {
  withLock(`pid=${alivePid()}\ncdp=9333\n`, () => {
    assert.strictEqual(I.isStale(I.readLockInfo(LOCK)), true, '无 started 无法判断心跳 → 按陈旧处理');
  });
});

test('锁：readLockInfo 正确解析 pid/started/cdp/cdpSince 四个字段', () => {
  withLock('pid=12345\nstarted=1700000000000\ncdp=9334\ncdpSince=1700000001000\n', () => {
    const info = I.readLockInfo(LOCK);
    assert.strictEqual(info.pid, 12345);
    assert.strictEqual(info.started, 1700000000000);
    assert.strictEqual(info.cdp, 9334);
    assert.strictEqual(info.cdpSince, 1700000001000);
  });
});

test('锁：文件不存在时 readLockInfo 返回全 0（不抛错）', () => {
  withLock(null, () => {
    const info = I.readLockInfo(LOCK);
    assert.deepStrictEqual(info, { pid: 0, started: 0, cdp: 0, cdpSince: 0 });
  });
});

test('锁：writeLock 保留「最后一次有 CDP」的时刻（cdpSince 不被 0 覆盖）', () => {
  const now = Date.now();
  const hadCdp = now - 5 * 60000;
  // 先写一个「曾经有 CDP」的锁
  withLock(`pid=${alivePid()}\nstarted=${now}\ncdp=9333\ncdpSince=${hadCdp}\n`, () => {
    // 同一进程再写一次 cdp=0（模拟 CDP 消失）
    I.writeLock(LOCK, 0);
    const info = I.readLockInfo(LOCK);
    assert.strictEqual(info.cdp, 0);
    assert.strictEqual(info.cdpSince, hadCdp,
      'cdpSince 必须保留上次有 CDP 的时刻，否则僵尸宽限永远算不出来');
  });
});

test('锁：acquireLock 在无锁时成功取得（返回 true 并落盘自己的 pid）', () => {
  withLock(null, () => {
    const got = I.acquireLock();
    assert.strictEqual(got, true, '无锁时应取得');
    assert.strictEqual(I.readLockInfo(LOCK).pid, process.pid, '锁文件应记录本进程 pid');
  });
});

test('主实例探测：hostInstanceRunning 对不存在的可执行名返回 false（不误拦启动）', () => {
  // 用一个绝不会存在的名字：探测失败/找不到都应返回 false，宁可照旧尝试
  assert.strictEqual(I.hostInstanceRunning('/nonexistent/DefinitelyNotRunningApp'), false);
});

test('主实例探测：hostInstanceRunning 对本机真实在跑的进程名返回 true', () => {
  // 用当前 shell 的父进程链里必然存在的进程名做正例：直接用本进程的可执行名。
  // process.execPath 的 basename（如 node）在测试期间必然有实例在跑。
  const name = path.basename(process.execPath);
  if (process.platform === 'win32') return;   // tasklist 路径另测
  assert.strictEqual(I.hostInstanceRunning(process.execPath), true,
    `basename=${name} 正在运行（就是本测试进程），探测应为 true`);
});
