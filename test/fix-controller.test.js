'use strict';

// controller / config-bridge 锁与生命周期修复的回归测试：
//   1. 配置锁：'wx' 建锁到写入 pid 之间的空内容锁不得被判为「死属主」而偷走；
//   2. 服务租约：空/损坏锁超 TTL 必须可接管（否则 acquireLock 永久失败），年轻的不动；
//   3. 心跳：锁被他人接管后必须判 lost（进程退场），不再当幽灵 controller；
//   4. 启动时日志截断；5. auto-enable 异步执行不阻塞事件循环；
//   6. 未受监督 + 用过之后 ZCode 退出 → exit，不再代启。
// 全部在临时目录内完成，不碰真实 ~/.zcode 与 launchd。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostTmp = os.tmpdir();
const fixture = fs.mkdtempSync(path.join(hostTmp, 'zca-fix-ctrl-'));
Object.assign(process.env, {
  HOME: fixture, USERPROFILE: fixture,
  ZCODE_ADVISOR_COMPANION_TMP: fixture,
  ZCODE_ADVISOR_COMPANION_LOG: path.join(fixture, 'companion.log')
});
delete process.env.ZCODE_ADVISOR_SUPERVISED;
delete process.env.ZCODE_ADVISOR_ATTACH_ONLY;
test.after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(hostTmp) + path.sep + 'zca-fix-ctrl-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});

const ctrl = require('../tools/companion/controller.cjs');
const I = ctrl._internal;
const bridge = require('../tools/config-bridge.js');
const LOCK = I.LOCK_FILE;

function setAge(file, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

// —— 1. 配置锁空 pid 空窗 ——
for (const [name, withConfigLock] of [['config-bridge', bridge._internal.withConfigLock], ['controller', I.withConfigLock]]) {
  test(`${name} withConfigLock：年轻的空内容锁按活处理，不被偷走`, () => {
    const target = path.join(fixture, `${name}-young.json`);
    const lock = `${target}.lock`;
    fs.writeFileSync(lock, '');
    let entered = false;
    const r = withConfigLock(target, () => { entered = true; return true; });
    assert.strictEqual(r, false, '应放弃（锁仍属他人）');
    assert.strictEqual(entered, false, '不得进入临界区');
    assert.ok(fs.existsSync(lock), '不得删除活持有者刚建的锁');
    fs.unlinkSync(lock);
  });

  test(`${name} withConfigLock：超 10s 的空内容锁按陈旧接管`, () => {
    const target = path.join(fixture, `${name}-old.json`);
    const lock = `${target}.lock`;
    fs.writeFileSync(lock, '');
    setAge(lock, 20000);
    let entered = false;
    const r = withConfigLock(target, () => { entered = true; return 'ok'; });
    assert.strictEqual(r, 'ok');
    assert.ok(entered);
    assert.ok(!fs.existsSync(lock), '属主退出后应清锁');
  });

  test(`${name} withConfigLock：死 pid 锁仍立即接管（原语义不变）`, () => {
    const target = path.join(fixture, `${name}-dead.json`);
    const lock = `${target}.lock`;
    fs.writeFileSync(lock, '2147483646');
    assert.strictEqual(withConfigLock(target, () => 'ok'), 'ok');
  });
}

// —— 2. 服务租约：空/损坏锁 ——
test('isGarbageLockStale：按 mtime 与 TTL 判定', () => {
  fs.writeFileSync(LOCK, 'garbage');
  assert.strictEqual(I.isGarbageLockStale(LOCK), false);
  setAge(LOCK, I.LOCK_TTL_MS + 5000);
  assert.strictEqual(I.isGarbageLockStale(LOCK), true);
  fs.unlinkSync(LOCK);
  assert.strictEqual(I.isGarbageLockStale(LOCK), false, '不存在不算垃圾锁');
});

test('acquireLock：年轻的空锁不接管（可能是刚建未写完的活锁）', () => {
  fs.writeFileSync(LOCK, '');
  assert.strictEqual(I.acquireLock(), false);
  assert.strictEqual(fs.readFileSync(LOCK, 'utf8'), '', '年轻空锁原样保留');
  fs.unlinkSync(LOCK);
});

test('acquireLock：超 TTL 的空/损坏锁可接管（不再永久失败）', () => {
  for (const body of ['', 'not-a-lock\n']) {
    fs.writeFileSync(LOCK, body);
    setAge(LOCK, I.LOCK_TTL_MS + 5000);
    assert.strictEqual(I.acquireLock(), true, `内容 ${JSON.stringify(body)} 应可接管`);
    assert.strictEqual(I.readLockInfo(LOCK).pid, process.pid);
    fs.unlinkSync(LOCK);
  }
});

// —— 3. 心跳决策 ——
test('heartbeatDecision：自己的锁续租，他人的锁退场，读不到连续两拍才退场', () => {
  assert.strictEqual(I.heartbeatDecision(100, 100, false), 'renew');
  assert.strictEqual(I.heartbeatDecision(200, 100, false), 'lost');
  assert.strictEqual(I.heartbeatDecision(0, 100, false), 'unknown');
  assert.strictEqual(I.heartbeatDecision(0, 100, true), 'lost');
});

// —— 4. 启动时日志截断 ——
test('rotateLogIfLarge：超限原地截断（inode 不变），未超限不动', () => {
  const f = path.join(fixture, 'rot.log');
  fs.writeFileSync(f, 'x'.repeat(100));
  assert.strictEqual(I.rotateLogIfLarge(f, 1000), false);
  assert.strictEqual(fs.statSync(f).size, 100);
  const ino = fs.statSync(f).ino;
  assert.strictEqual(I.rotateLogIfLarge(f, 50), true);
  assert.strictEqual(fs.statSync(f).size, 0);
  assert.strictEqual(fs.statSync(f).ino, ino, '必须原地截断，重定向 fd 才能继续写入');
  assert.strictEqual(I.rotateLogIfLarge(path.join(fixture, 'missing.log'), 1), false);
});

// —— 5. 异步 auto-enable ——
test('runNodeScript：异步执行期间事件循环不被阻塞，收集输出与退出码', async () => {
  const script = path.join(fixture, 'slow.cjs');
  fs.writeFileSync(script, "setTimeout(() => { console.log('✓ done'); process.exit(2); }, 300);");
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 20);
  const r = await I.runNodeScript(script, process.env, 10000);
  clearInterval(iv);
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /✓ done/);
  assert.ok(ticks >= 5, `事件循环应在子进程运行期间持续 tick（实际 ${ticks}）`);
});

test('runNodeScript：超时返回 status=null 并结束子进程', async () => {
  const script = path.join(fixture, 'hang.cjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const r = await I.runNodeScript(script, process.env, 200);
  assert.strictEqual(r.status, null);
});

// —— 6. CDP 消失决策 ——
test('cdpLostDecision：宽限期内等待', () => {
  assert.strictEqual(I.cdpLostDecision({ attachOnly: false, cdpSeen: true, lostForMs: 1000, graceMs: 30000, hostRunning: () => { throw new Error('不应探测'); } }), 'wait');
});

test('cdpLostDecision：未受监督、用过之后宿主已退出 → exit（不代启）', () => {
  assert.strictEqual(I.cdpLostDecision({ attachOnly: false, cdpSeen: true, lostForMs: 31000, graceMs: 30000, hostRunning: () => false }), 'exit');
});

test('cdpLostDecision：宿主仍在 / 从未附着过 → 保留自愈', () => {
  assert.strictEqual(I.cdpLostDecision({ attachOnly: false, cdpSeen: true, lostForMs: 31000, graceMs: 30000, hostRunning: () => true }), 'selfheal');
  assert.strictEqual(I.cdpLostDecision({ attachOnly: false, cdpSeen: false, lostForMs: 31000, graceMs: 30000, hostRunning: () => false }), 'selfheal');
});

test('cdpLostDecision：只附着模式超宽限一律 exit', () => {
  assert.strictEqual(I.cdpLostDecision({ attachOnly: true, cdpSeen: false, lostForMs: 31000, graceMs: 30000, hostRunning: () => true }), 'exit');
});
