'use strict';

// 角标链路探测与自愈兜底（hooks/lib/badge.js）行为测试。
//
// 这套测试守的是**角标状态不能说谎**：
// 锁文件缺失/心跳过期/pid 已死必须判 down，绝不把「取不到状态」当成「链路健康」；
// 自愈只在 macOS + plist 在位时动手，失败必须如实返回而不是抛异常拖垮审查。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BADGE = require('../hooks/lib/badge');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'zca-badge-'));
}

// 起一个短命但可确定存活的子进程：返回 { pid, killAndWait }。
// 必须跨平台（CI 含 Windows）：不用 sleep，用 node 自身。
function livePid() {
  const cp = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  return {
    pid: cp.pid,
    killAndWait: () => {
      try { cp.kill(); } catch (_) {}
      return new Promise((r) => cp.on('exit', r));
    }
  };
}

function writeLock(dir, { pid, started, cdp, cdpSince }) {
  fs.writeFileSync(
    path.join(dir, BADGE.LOCK_FILE_NAME),
    `pid=${pid}\nstarted=${started}\ncdp=${cdp}\ncdpSince=${cdpSince}\n`,
    'utf8'
  );
}

// ---------------- resolveLockFile ----------------

test('resolveLockFile：默认系统 tmp，env 可重定向（测试隔离用）', () => {
  assert.strictEqual(BADGE.resolveLockFile({}), path.join(os.tmpdir(), BADGE.LOCK_FILE_NAME));
  const custom = tmpDir();
  assert.strictEqual(BADGE.resolveLockFile({ ZCODE_ADVISOR_COMPANION_TMP: custom }),
    path.join(custom, BADGE.LOCK_FILE_NAME));
});

// ---------------- readCompanionLock ----------------

test('readCompanionLock：锁文件不存在 → present:false（宁多提示不误报健康）', () => {
  const lock = BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: tmpDir() });
  assert.strictEqual(lock.present, false);
  assert.strictEqual(lock.fresh, false);
});

test('readCompanionLock：坏内容 → present:false', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, BADGE.LOCK_FILE_NAME), 'not a lock', 'utf8');
  const lock = BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: dir });
  assert.strictEqual(lock.present, false);
});

test('readCompanionLock：心跳新鲜 + pid 存活 → fresh，cdp 正确解析', async () => {
  const dir = tmpDir();
  const lp = livePid();
  try {
    writeLock(dir, { pid: lp.pid, started: Date.now(), cdp: 9223, cdpSince: Date.now() });
    const lock = BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: dir });
    assert.strictEqual(lock.present, true);
    assert.strictEqual(lock.fresh, true);
    assert.strictEqual(lock.cdp, 9223);
  } finally {
    await lp.killAndWait();
  }
});

test('readCompanionLock：心跳超时（>60s）→ fresh:false', () => {
  const dir = tmpDir();
  writeLock(dir, { pid: process.pid, started: Date.now() - BADGE.LOCK_TTL_MS - 1000, cdp: 9223, cdpSince: Date.now() });
  const lock = BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: dir });
  assert.strictEqual(lock.present, true);
  assert.strictEqual(lock.fresh, false);
});

test('readCompanionLock：pid 已死 → fresh:false（心跳新鲜也救不回来）', async () => {
  const dir = tmpDir();
  const lp = livePid();
  writeLock(dir, { pid: lp.pid, started: Date.now(), cdp: 0, cdpSince: Date.now() });
  assert.strictEqual(BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: dir }).fresh, true);
  await lp.killAndWait();
  assert.strictEqual(BADGE.readCompanionLock({ ZCODE_ADVISOR_COMPANION_TMP: dir }).fresh, false,
    'pid 死后即使 started 时间戳还新鲜也必须判不新鲜');
});

// ---------------- deriveBadgeState ----------------

test('deriveBadgeState：三态判定', () => {
  assert.strictEqual(BADGE.deriveBadgeState(null), 'down');
  assert.strictEqual(BADGE.deriveBadgeState({ present: false, fresh: false, cdp: 0 }), 'down');
  assert.strictEqual(BADGE.deriveBadgeState({ present: true, fresh: false, cdp: 9223 }), 'down',
    '心跳过期时即使锁里有 cdp 也必须判 down（那是上一世的端口）');
  assert.strictEqual(BADGE.deriveBadgeState({ present: true, fresh: true, cdp: 9223 }), 'attached');
  assert.strictEqual(BADGE.deriveBadgeState({ present: true, fresh: true, cdp: 0 }), 'waiting');
});

// ---------------- 待命标记（裸 ZCode 场景） ----------------

function writeStandby(dir, { at, reason }) {
  fs.writeFileSync(
    path.join(dir, BADGE.STANDBY_FILE_NAME),
    `reason=${reason || 'bare-zcode'}\nat=${at || Date.now()}\n`,
    'utf8'
  );
}

test('readStandby：缺失/坏内容 → present:false；新鲜 → present:true 且带原因', () => {
  assert.strictEqual(BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: tmpDir() }).present, false);
  const bad = tmpDir();
  fs.writeFileSync(path.join(bad, BADGE.STANDBY_FILE_NAME), 'garbage', 'utf8');
  assert.strictEqual(BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: bad }).present, false);

  const dir = tmpDir();
  writeStandby(dir, { at: Date.now(), reason: 'bare-zcode' });
  const st = BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: dir });
  assert.strictEqual(st.present, true);
  assert.strictEqual(st.reason, 'bare-zcode');
});

test('readStandby：超过保鲜期 → present:false（陈旧标记不得长期冒充等待中）', () => {
  const dir = tmpDir();
  writeStandby(dir, { at: Date.now() - BADGE.STANDBY_TTL_MS - 1000 });
  assert.strictEqual(BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: dir }).present, false);
});

test('deriveBadgeState：锁死了但有待命标记 → waiting（宿主是裸 ZCode，不该 kickstart）', () => {
  const dir = tmpDir();
  writeStandby(dir, { at: Date.now() });
  const deadLock = { present: true, fresh: false, cdp: 0 };
  assert.strictEqual(BADGE.deriveBadgeState(deadLock, BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: dir })),
    'waiting');
  assert.strictEqual(BADGE.deriveBadgeState(deadLock, null), 'down', '无待命证据时必须仍旧判 down');
});

test('deriveBadgeState：健康锁优先于待命标记（附着成功就不能报 waiting）', () => {
  const dir = tmpDir();
  writeStandby(dir, { at: Date.now() });
  const lock = { present: true, fresh: true, cdp: 9223 };
  assert.strictEqual(BADGE.deriveBadgeState(lock, BADGE.readStandby({ ZCODE_ADVISOR_COMPANION_TMP: dir })), 'attached');
});

// ---------------- shouldRevive（节流） ----------------

test('shouldRevive：ISO 时间戳必须真正参与节流（Number(ISO)=NaN 的回归）', () => {
  const now = Date.now();
  const min = 10 * 60 * 1000;
  assert.strictEqual(BADGE.shouldRevive('down', new Date(now - 60 * 1000).toISOString(), now, { minIntervalMs: min }),
    false, '10 分钟内刚拉过就必须压住');
  assert.strictEqual(BADGE.shouldRevive('down', new Date(now - 11 * 60 * 1000).toISOString(), now, { minIntervalMs: min }),
    true, '超过间隔应放行');
  assert.strictEqual(BADGE.shouldRevive('down', '', now, { minIntervalMs: min }), true, '从未拉过 → 立即放行');
  assert.strictEqual(BADGE.shouldRevive('down', 'not-a-date', now, { minIntervalMs: min }), true,
    '坏时间戳按从未拉过处理（宁可多拉一次也不永久沉默）');
  assert.strictEqual(BADGE.shouldRevive('waiting', new Date(0).toISOString(), now, { minIntervalMs: min }), false,
    'waiting 不是自愈对象');
  assert.strictEqual(BADGE.shouldRevive('down', '', now, { minIntervalMs: min, disabled: true }), false,
    'ZCODE_ADVISOR_BADGE_REVIVE=0 必须彻底关闭');
});

// ---------------- revivePlan ----------------

test('revivePlan：非 darwin 平台无从自愈', () => {
  assert.strictEqual(BADGE.revivePlan('linux', '/nonexistent.plist'), null);
  assert.strictEqual(BADGE.revivePlan('win32', '/nonexistent.plist'), null);
});

test('revivePlan：darwin + plist 不在位 → null', () => {
  assert.strictEqual(BADGE.revivePlan('darwin', path.join(tmpDir(), 'no.plist')), null);
  assert.strictEqual(BADGE.revivePlan('darwin', ''), null);
});

test('revivePlan：darwin + plist 在位 → kickstart 命令带 label', () => {
  const dir = tmpDir();
  const plist = path.join(dir, 'local.zcode.advisor.plist');
  fs.writeFileSync(plist, '<plist/>', 'utf8');
  const plan = BADGE.revivePlan('darwin', plist);
  assert.ok(plan, 'plist 在位必须给出自愈方案');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  assert.deepStrictEqual(plan.argv, ['launchctl', 'kickstart', `gui/${uid}/${BADGE.LAUNCHD_LABEL}`]);
});

// ---------------- tryRevive ----------------

// fake spawnSync：记录调用，按脚本决定成败。
function fakeSpawn(script) {
  const calls = [];
  const fn = (cmd, argv) => {
    calls.push({ cmd, argv });
    const outcome = script(calls.length, cmd, argv);
    return outcome === true ? { status: 0 } : { status: 1, error: undefined };
  };
  fn.calls = calls;
  return fn;
}

test('tryRevive：非 darwin → 不动手', () => {
  const r = BADGE.tryRevive({ platform: 'linux', spawnSyncFn: fakeSpawn(() => true) });
  assert.strictEqual(r.attempted, false);
  assert.strictEqual(r.reason, 'unsupported');
});

test('tryRevive：darwin + plist 缺失 → 不动手', () => {
  const r = BADGE.tryRevive({ platform: 'darwin', plistPath: path.join(tmpDir(), 'no.plist'), spawnSyncFn: fakeSpawn(() => true) });
  assert.strictEqual(r.attempted, false);
  assert.strictEqual(r.reason, 'no_plist');
});

test('tryRevive：kickstart 成功 → ok，不退回 bootstrap', () => {
  const dir = tmpDir();
  const plist = path.join(dir, 'local.zcode.advisor.plist');
  fs.writeFileSync(plist, '<plist/>', 'utf8');
  const sp = fakeSpawn(() => true);
  const r = BADGE.tryRevive({ platform: 'darwin', plistPath: plist, spawnSyncFn: sp });
  assert.deepStrictEqual(r, { attempted: true, ok: true, via: 'kickstart' });
  assert.strictEqual(sp.calls.length, 1, 'kickstart 成功就不该再碰 bootstrap');
  assert.strictEqual(sp.calls[0].cmd, 'launchctl');
});

test('tryRevive：kickstart 失败 → 退回 bootstrap 装载', () => {
  const dir = tmpDir();
  const plist = path.join(dir, 'local.zcode.advisor.plist');
  fs.writeFileSync(plist, '<plist/>', 'utf8');
  const sp = fakeSpawn((n) => n === 2); // 第 1 次 kickstart 失败，第 2 次 bootstrap 成功
  const r = BADGE.tryRevive({ platform: 'darwin', plistPath: plist, spawnSyncFn: sp });
  assert.deepStrictEqual(r, { attempted: true, ok: true, via: 'bootstrap' });
  assert.strictEqual(sp.calls.length, 2);
  assert.strictEqual(sp.calls[1].argv[0], 'bootstrap');
});

test('tryRevive：两条路都失败 → ok:false 但不抛异常', () => {
  const dir = tmpDir();
  const plist = path.join(dir, 'local.zcode.advisor.plist');
  fs.writeFileSync(plist, '<plist/>', 'utf8');
  const sp = fakeSpawn(() => { throw new Error('boom'); });
  const r = BADGE.tryRevive({ platform: 'darwin', plistPath: plist, spawnSyncFn: sp });
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.ok, false);
});

// ---------------- 文案 ----------------

test('badgeHintLines：waiting/down 给人话且承诺审查不受影响；attached 沉默', () => {
  const waiting = BADGE.badgeHintLines('waiting', 'darwin');
  assert.strictEqual(waiting.length, 1);
  assert.ok(waiting[0].startsWith('[advisor]'));
  assert.ok(waiting[0].includes('审查不受影响'), '必须写明审查不受影响，防止用户误读成顾问挂了');
  assert.ok(waiting[0].includes('启动器'), '必须给出用户真正能做的一步：用启动器重开');
  assert.ok(!waiting[0].includes('自动以角标模式重新拉起'),
    'attach-only 不会代启，文案不得承诺「退出后自动拉起」（这是旧文案的硬伤）');

  const down = BADGE.badgeHintLines('down', 'darwin');
  assert.strictEqual(down.length, 1);
  assert.ok(down[0].includes('launchctl kickstart'), 'darwin 文案必须给出可操作命令');
  assert.ok(!down[0].includes('已尝试自动拉起'),
    '是否真的拉起由 reviveResultLines 如实报告，静态文案不得预先声称已尝试');

  const downWin = BADGE.badgeHintLines('down', 'win32');
  assert.strictEqual(downWin.length, 1);
  assert.ok(!downWin[0].includes('launchctl'), '非 darwin 不该提 launchctl');

  assert.deepStrictEqual(BADGE.badgeHintLines('attached', 'darwin'), []);
});

test('reviveResultLines：未动手不追加；动手必如实报告成败', () => {
  assert.deepStrictEqual(BADGE.reviveResultLines(null), []);
  assert.deepStrictEqual(BADGE.reviveResultLines({ attempted: false }), []);
  assert.strictEqual(BADGE.reviveResultLines({ attempted: true, ok: true, via: 'kickstart' }).length, 1);
  assert.ok(BADGE.reviveResultLines({ attempted: true, ok: true, via: 'kickstart' })[0].includes('kickstart'));
  assert.ok(BADGE.reviveResultLines({ attempted: true, ok: false })[0].includes('失败'));
});
