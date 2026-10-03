'use strict';

// 健康信标（M1）行为测试。
//
// 这套测试守的是**用户可见的指示灯不能说谎**：
// 指示器失效（无数据/陈旧/worker 崩溃）必须显示 unknown/down，绝不显示 ok。
// 一旦 deriveHealth 的语义被改坏（例如把「取不到数据」当健康），用户会把
// 「灯坏了」误读成「顾问正常」——这是本模块最贵的失败模式。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HEALTH = require('../hooks/lib/health');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'zca-health-'));
}

// 在独立子进程里跑（路径解析读 env，避免同进程缓存串味）
function runInChild(env, body) {
  const envSetup = Object.entries(env)
    .map(([k, v]) => (v === null ? `delete process.env.${k};` : `process.env.${k} = ${JSON.stringify(v)};`))
    .join('\n');
  const runner = `
    ${envSetup}
    const H = require(${JSON.stringify(path.join(__dirname, '../hooks/lib/health'))});
    ${body}
  `;
  const out = execFileSync(process.execPath, ['-e', runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

// ---------------- 路径解析 ----------------

test('resolveHealthDir：优先级 HEALTH_DIR > STATE_DIR > ~/.zcode', () => {
  const a = tmpDir();
  const b = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: a, ZCODE_ADVISOR_STATE_DIR: b },
    `process.stdout.write(JSON.stringify({ withBoth: H.resolveHealthDir(process.env) }));`
  );
  assert.strictEqual(got.withBoth, a, 'HEALTH_DIR 应优先于 STATE_DIR');

  const c = tmpDir();
  const got2 = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: null, ZCODE_ADVISOR_STATE_DIR: c },
    `process.stdout.write(JSON.stringify({ withState: H.resolveHealthDir(process.env) }));`
  );
  assert.strictEqual(got2.withState, c, '无 HEALTH_DIR 时用 STATE_DIR');

  const got3 = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: null, ZCODE_ADVISOR_STATE_DIR: null },
    `process.stdout.write(JSON.stringify({ fallback: H.resolveHealthDir(process.env) }));`
  );
  assert.strictEqual(got3.fallback, path.join(os.homedir(), '.zcode'), '都没有时退回 ~/.zcode');
});

test('beaconPath：会话 id 被清洗（防路径穿越 / 非法文件名）', () => {
  const dir = '/tmp/x';
  assert.strictEqual(HEALTH.beaconPath(dir, 'sess_abc-123'), path.join(dir, 'advisor-health-sess_abc-123.json'));
  const bad = HEALTH.beaconPath(dir, '../../etc/passwd');
  assert.ok(!bad.includes('..'), '不得保留路径穿越片段');
  assert.strictEqual(path.dirname(bad), dir, '结果必须仍落在目标目录内');
  // 空 id 回退 default，不产生 advisor-health-.json 这类怪名
  assert.ok(HEALTH.beaconPath(dir, '').endsWith('advisor-health-default.json'));
});

// ---------------- 写读往返（双时间戳不互相覆盖） ----------------

test('writeAttempt + writeResult：合并写，attempt 不被 result 覆盖', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      H.writeAttempt(H.resolveHealthDir(process.env), 's1', { model: 'm1' });
      H.writeResult(H.resolveHealthDir(process.env), 's1', { ok: true, model: 'm1', reviews: 3 });
      process.stdout.write(JSON.stringify(H.readBeacons(H.resolveHealthDir(process.env))[0]));
    `
  );
  assert.ok(got.lastAttemptAt, 'attempt 时间戳应保留（不能被 result 覆盖丢掉）');
  assert.ok(got.lastSuccessAt, '成功时间戳应写入');
  assert.strictEqual(got.state, 'ok');
  assert.strictEqual(got.reviews, 3);
  // 文件权限：含会话 id / 模型名，应收紧到 0600
  const f = path.join(dir, 'advisor-health-s1.json');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, '信标文件应为 0600');
});

test('writeResult(失败)：不更新 lastSuccessAt（判据：有尝试无新鲜成功 = down）', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      H.writeAttempt(H.resolveHealthDir(process.env), 's1', { model: 'm1' });
      H.writeResult(H.resolveHealthDir(process.env), 's1', { ok: true, model: 'm1' });   // 先成功一次
      const first = H.readBeacons(H.resolveHealthDir(process.env))[0].lastSuccessAt;
      H.writeAttempt(H.resolveHealthDir(process.env), 's1', { model: 'm2' });
      H.writeResult(H.resolveHealthDir(process.env), 's1', { ok: false, model: 'm2', reason: 'llm_http_500' });
      const b = H.readBeacons(H.resolveHealthDir(process.env))[0];
      process.stdout.write(JSON.stringify({ first, after: b.lastSuccessAt, state: b.state, reason: b.reason }));
    `
  );
  assert.strictEqual(got.after, got.first, '失败不得更新 lastSuccessAt');
  assert.strictEqual(got.state, 'down');
  assert.strictEqual(got.reason, 'llm_http_500');
});

test('writeResult(降级成功)：ok+degraded 并存时棋标必须是 degraded 而非 ok（劣化不得被绿色藏起来）', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const d = H.resolveHealthDir(process.env);
      H.writeAttempt(d, 's1', { model: 'primary' });
      // 靠备用模型完成：本次确有产出(ok)且降级(degraded)同时为真
      H.writeResult(d, 's1', { ok: true, degraded: true, model: 'primary', effectiveModel: 'fb', reviews: 1 });
      const b = H.readBeacons(d)[0];
      process.stdout.write(JSON.stringify({ state: b.state, effectiveModel: b.effectiveModel, hasSuccess: Boolean(b.lastSuccessAt) }));
    `
  );
  assert.strictEqual(got.state, 'degraded', 'ok+degraded 并存时必须降级优先，否则黄灯永远不可达');
  assert.strictEqual(got.effectiveModel, 'fb', '生效模型应记实际干活的备用模型');
  assert.ok(got.hasSuccess, '降级成功仍算成功，应更新 lastSuccessAt');
});

test('writeResult(正常成功)：只 ok 时 state=ok', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const d = H.resolveHealthDir(process.env);
      H.writeAttempt(d, 's1', { model: 'm' });
      H.writeResult(d, 's1', { ok: true, model: 'm', reviews: 1 });
      process.stdout.write(JSON.stringify(H.readBeacons(d)[0].state));
    `
  );
  assert.strictEqual(got, 'ok');
});

test('readBeacons：多会话并存，按 lastAttemptAt 倒序（最近活动在前）', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const d = H.resolveHealthDir(process.env);
      // 直接写文件以控制时间戳（writeAttempt 用 now，无法造先后）
      const fsx = require('fs');
      fsx.writeFileSync(d + '/advisor-health-old.json', JSON.stringify({ sessionId: 'old', lastAttemptAt: '2020-01-01T00:00:00.000Z', state: 'ok', lastSuccessAt: '2020-01-01T00:00:00.000Z' }));
      fsx.writeFileSync(d + '/advisor-health-new.json', JSON.stringify({ sessionId: 'new', lastAttemptAt: '2030-01-01T00:00:00.000Z', state: 'ok', lastSuccessAt: '2030-01-01T00:00:00.000Z' }));
      process.stdout.write(JSON.stringify(H.readBeacons(d).map(b => b.sessionId)));
    `
  );
  assert.deepStrictEqual(got, ['new', 'old']);
});

test('readBeacons：坏文件跳过，不抛错；目录不存在返回 []', () => {
  const dir = tmpDir();
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const fsx = require('fs');
      fsx.writeFileSync(${JSON.stringify(path.join(dir, 'advisor-health-bad.json'))}, '{broken');
      fsx.writeFileSync(${JSON.stringify(path.join(dir, 'advisor-health-good.json'))}, JSON.stringify({ sessionId: 'g', lastAttemptAt: '2030-01-01T00:00:00.000Z' }));
      const ok = H.readBeacons(${JSON.stringify(dir)}).map(b => b.sessionId);
      process.stdout.write(JSON.stringify({ ok, missing: H.readBeacons(${JSON.stringify(path.join(dir, 'nope'))}) }));
    `
  );
  assert.deepStrictEqual(got.ok, ['g'], '坏文件应被跳过');
  assert.deepStrictEqual(got.missing, [], '目录不存在应返回空数组');
});

// ---------------- 健康态派生（本模块的核心不变量） ----------------

test('deriveHealth：无信标 / 无 attempt → unknown（绝不 ok）', () => {
  assert.strictEqual(HEALTH.deriveHealth(null), 'unknown');
  assert.strictEqual(HEALTH.deriveHealth({}), 'unknown');
  assert.strictEqual(HEALTH.deriveHealth({ sessionId: 's', state: 'ok' }), 'unknown', '没有 attempt 时间戳时不能信 state');
});

test('deriveHealth：attempt 陈旧 → unknown（不显示绿也不显示红）', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const stale = new Date(now - 60 * 60 * 1000).toISOString(); // 1 小时前
  const r = HEALTH.deriveHealth(
    { lastAttemptAt: stale, lastSuccessAt: stale, state: 'ok' },
    { now, staleMs: 600000 }
  );
  assert.strictEqual(r, 'unknown');
});

test('deriveHealth：attempt 新近 + success 新近 + state ok → ok', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const t = new Date(now - 30 * 1000).toISOString();
  assert.strictEqual(HEALTH.deriveHealth({ lastAttemptAt: t, lastSuccessAt: t, state: 'ok' }, { now }), 'ok');
});

test('deriveHealth：有尝试无新鲜成功 → down（worker 被强杀的场景）', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const attempt = new Date(now - 10 * 1000).toISOString();
  const oldSuccess = new Date(now - 60 * 60 * 1000).toISOString();
  assert.strictEqual(
    HEALTH.deriveHealth({ lastAttemptAt: attempt, lastSuccessAt: oldSuccess, state: 'ok' }, { now, staleMs: 600000 }),
    'down',
    'attempt 更新但 success 陈旧 = 跑了没结果，必须 down'
  );
  // 从未成功过（无 lastSuccessAt）同样是 down
  assert.strictEqual(HEALTH.deriveHealth({ lastAttemptAt: attempt, state: 'down' }, { now }), 'down');
});

test('deriveHealth：degraded 保留降级态（不升级成 ok）', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const t = new Date(now - 10 * 1000).toISOString();
  assert.strictEqual(HEALTH.deriveHealth({ lastAttemptAt: t, lastSuccessAt: t, state: 'degraded' }, { now }), 'degraded');
});

// 回归：degraded 不得绕过新鲜度检查。曾用「先降级成功、随后每轮 spawn 都崩溃」复现：
// 降级成功会置 state='degraded' 并刷新 lastSuccessAt，此后崩溃只刷新 lastAttemptAt，
// 旧实现里 `if (state==='degraded') return 'degraded'` 位于 down 判定之前，黄灯永久常亮，
// 把「连续崩溃、零产出」粉饰成「降级兜住」——正是 M4 要消灭的静默掩盖的镜像。
test('deriveHealth：降级成功后持续崩溃 → down（黄灯不得掩盖连续失败）', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const attempt = new Date(now - 5 * 1000).toISOString();     // 刚尝试过（新鲜）
  const staleSuccess = new Date(now - 60 * 60 * 1000).toISOString(); // 1 小时前降级成功（已陈旧）
  assert.strictEqual(
    HEALTH.deriveHealth({ lastAttemptAt: attempt, lastSuccessAt: staleSuccess, state: 'degraded' }, { now }),
    'down',
    '成功已陈旧且仍在尝试 → 必须 down，不能因 state=degraded 而常亮黄灯'
  );
});

test('staleThresholdMs：下界 10 分钟，且不小于 2×reviewBudgetMs', () => {
  assert.strictEqual(HEALTH.staleThresholdMs(120000), 600000, '小预算取下界 10 分钟');
  assert.strictEqual(HEALTH.staleThresholdMs(480000), 960000, '大预算取 2×');
  assert.strictEqual(HEALTH.staleThresholdMs(undefined), 960000, '缺省 8 分钟预算 → 2× = 16 分钟（高于 10 分钟下界）');
});

// ---------------- STATE_DIR 隔离（防把假数据写进用户真实 ~/.zcode） ----------------

test('STATE_DIR 隔离：信标落在 stateDir，而非用户主目录', () => {
  const stateDir = tmpDir('zca-hstate-');
  const userHome = tmpDir('zca-hhome-');
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: null, ZCODE_ADVISOR_STATE_DIR: stateDir, HOME: userHome },
    `
      const d = H.resolveHealthDir(process.env);
      H.writeAttempt(d, 's1', { model: 'm' });
      H.writeResult(d, 's1', { ok: true, model: 'm' });
      process.stdout.write(JSON.stringify({
        dir: d,
        inState: require('fs').existsSync(${JSON.stringify(path.join(stateDir, 'advisor-health-s1.json'))}),
        inHome: require('fs').existsSync(${JSON.stringify(path.join(userHome, '.zcode', 'advisor-health-s1.json'))})
      }));
    `
  );
  assert.strictEqual(got.dir, stateDir);
  assert.strictEqual(got.inState, true);
  assert.strictEqual(got.inHome, false, '绝不应写进（假）用户主目录');
});

// ---------------- 发行层：controller 内联副本与 hooks 同语义（防两侧漂移） ----------------
// 发行包不含 hooks/，controller 只能内联一份 health 读取+派生逻辑。
// 标记比对只是弱守卫；这里直接**行为比对**：同一批输入下两份实现必须给出完全相同的
// 健康态。任何一侧单独改判定都会在这里现形（角标说谎的根因就是两侧漂移）。

test('deriveHealth：controller 内联副本与 hooks/lib/health 行为逐一一致', () => {
  const ctrl = require('../tools/companion/controller.cjs');
  const hook = require('../hooks/lib/health');

  // 覆盖全部四态 + 边界（无数据 / 无 attempt / 陈旧 / 有尝试无新鲜成功 / 降级）
  const now = Date.parse('2030-01-01T00:00:30.000Z');
  const fresh = '2030-01-01T00:00:00.000Z';
  const old = '2029-01-01T00:00:00.000Z';
  const cases = [
    [null, {}],
    [undefined, {}],
    [{}, {}],
    [{ sessionId: 's', state: 'ok' }, { now }],                                   // 无 attempt
    [{ lastAttemptAt: fresh, lastSuccessAt: fresh, state: 'ok' }, { now }],        // ok
    [{ lastAttemptAt: fresh, lastSuccessAt: fresh, state: 'degraded' }, { now }],  // degraded
    [{ lastAttemptAt: fresh, lastSuccessAt: old, state: 'degraded' }, { now, staleMs: 600000 }], // down（降级成功后持续崩溃，黄灯不得掩盖）
    [{ lastAttemptAt: fresh, lastSuccessAt: old, state: 'ok' }, { now, staleMs: 600000 }], // down（跑了没结果）
    [{ lastAttemptAt: fresh, state: 'down' }, { now }],                            // down（从未成功）
    [{ lastAttemptAt: old, lastSuccessAt: old, state: 'ok' }, { now, staleMs: 600000 }],   // 陈旧 → unknown
  ];
  for (const [beacon, opts] of cases) {
    assert.strictEqual(
      ctrl.deriveHealth(beacon, opts), hook.deriveHealth(beacon, opts),
      `deriveHealth 漂移，输入=${JSON.stringify(beacon)} opts=${JSON.stringify(opts)}`
    );
  }
  // staleThresholdMs 也必须同式
  for (const b of [undefined, 120000, 480000, 0, -1, 600000]) {
    assert.strictEqual(ctrl.staleThresholdMs(b), hook.staleThresholdMs(b), `staleThresholdMs 漂移 @${b}`);
  }
});

test('controller 不得对无信标返回 ok（核心不变量，独立于实现比对）', () => {
  const ctrl = require('../tools/companion/controller.cjs');
  for (const b of [null, undefined, {}, { state: 'ok' }]) {
    assert.strictEqual(ctrl.deriveHealth(b), 'unknown', '无/缺时间戳的信标必须 unknown');
  }
});

test('readHealth：控制器读取侧返回最近活动信标并派生状态', () => {
  const dir = tmpDir('zca-hread-');
  const fsx = require('fs');
  fsx.writeFileSync(path.join(dir, 'advisor-health-a.json'), JSON.stringify({
    sessionId: 'a', lastAttemptAt: '2020-01-01T00:00:00.000Z', state: 'ok', lastSuccessAt: '2020-01-01T00:00:00.000Z'
  }));
  fsx.writeFileSync(path.join(dir, 'advisor-health-b.json'), JSON.stringify({
    sessionId: 'b', lastAttemptAt: new Date().toISOString(), state: 'ok', lastSuccessAt: new Date().toISOString()
  }));
  // 走子进程让 controller 的 HEALTH_DIR 指向隔离目录
  const got = runInChild({ ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null }, `
    const C = require(${JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'))});
    const r = C.readHealth(480000);
    process.stdout.write(JSON.stringify({ state: r.state, sid: r.beacon && r.beacon.sessionId, n: r.candidates }));
  `);
  assert.strictEqual(got.state, 'ok');
  assert.strictEqual(got.sid, 'b', '应取最近活动的会话');
  assert.strictEqual(got.n, 2);
});

// —— 写读往返（这是比 deriveHealth 比对更早失效的一环）——
// 若 hooks/lib/health.js 改了文件前缀/命名，controller 侧的内联 glob 会**静默匹配不到**，
// 角标永远灰而没有任何报错。deriveHealth 比对抓不到这类漂移，必须真写真读。

test('往返一致性：hooks 写入的信标，controller.readHealth 必须能读到（命名/形状不漂移）', () => {
  const dir = tmpDir('zca-rt-');
  const CTRL = JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'));
  const got = runInChild({ ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null }, `
    const C = require(${CTRL});
    // 只经 hooks 的写入口落盘（attempt + result 两次合并写）
    H.writeAttempt(H.resolveHealthDir(process.env), 'sess_rt-1', { model: 'glm-5.3-flash' });
    H.writeResult(H.resolveHealthDir(process.env), 'sess_rt-1', { ok: true, model: 'glm-5.3-flash', reviews: 4 });
    // 再经 controller 的读入口读回
    const r = C.readHealth(480000);
    process.stdout.write(JSON.stringify({ raw: r }));
  `);
  assert.strictEqual(got.raw.candidates, 1, 'controller 若匹配不到 hooks 写的文件 = 静默失败（角标永远灰）');
  assert.strictEqual(got.raw.state, 'ok');
  assert.strictEqual(got.raw.beacon.sessionId, 'sess_rt-1');
  assert.strictEqual(got.raw.beacon.reviews, 4);
  assert.ok(got.raw.beacon.lastSuccessAt, 'lastSuccessAt 应经往返保留');
});

test('往返一致性：controller 与 hooks 的目录解析规则一致（HEALTH_DIR / STATE_DIR / 默认）', () => {
  const a = tmpDir('zca-pa-');
  const b = tmpDir('zca-pb-');
  const CTRL = JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'));
  const cases = [
    { ZCODE_ADVISOR_HEALTH_DIR: a, ZCODE_ADVISOR_STATE_DIR: b, expect: a },
    { ZCODE_ADVISOR_HEALTH_DIR: null, ZCODE_ADVISOR_STATE_DIR: b, expect: b },
    { ZCODE_ADVISOR_HEALTH_DIR: null, ZCODE_ADVISOR_STATE_DIR: null, expect: path.join(os.homedir(), '.zcode') }
  ];
  for (const c of cases) {
    const got = runInChild(c, `
      const C = require(${CTRL});
      process.stdout.write(JSON.stringify({ h: H.resolveHealthDir(process.env), c: C.HEALTH_DIR }));
    `);
    assert.strictEqual(got.c, c.expect, `controller 目录解析漂移（输入=${JSON.stringify(c)}）`);
    assert.strictEqual(got.h, c.expect, `hooks 目录解析漂移（输入=${JSON.stringify(c)}）`);
  }
});

test('往返一致性：多会话排序在两侧一致（都按 lastAttemptAt 倒序）', () => {
  const dir = tmpDir('zca-sort-');
  const fsx = require('fs');
  // 刻意让「文件名序」与「时间序」相反，逼出按内容的正确排序
  fsx.writeFileSync(path.join(dir, 'advisor-health-zzz-old.json'),
    JSON.stringify({ sessionId: 'old', lastAttemptAt: '2020-01-01T00:00:00.000Z', state: 'ok', lastSuccessAt: '2020-01-01T00:00:00.000Z' }));
  fsx.writeFileSync(path.join(dir, 'advisor-health-aaa-new.json'),
    JSON.stringify({ sessionId: 'new', lastAttemptAt: '2030-01-01T00:00:00.000Z', state: 'ok', lastSuccessAt: '2030-01-01T00:00:00.000Z' }));
  const CTRL = JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'));
  const got = runInChild({ ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null }, `
    const C = require(${CTRL});
    process.stdout.write(JSON.stringify({
      hFirst: (H.readBeacons(H.resolveHealthDir(process.env))[0] || {}).sessionId,
      cFirst: ((C.readHealth(480000) || {}).beacon || {}).sessionId
    }));
  `);
  assert.strictEqual(got.hFirst, 'new');
  assert.strictEqual(got.cFirst, 'new', 'controller 排序与 hooks 漂移会导致角标显示错会话');
});


// ---------------- HTTP 端到端：/api/health 的真实形状（含鉴权） ----------------
// 上面的 readHealth 测的是内层逻辑；这里起真实 HTTP server，锁住 route 串接
// （URL 精确匹配、令牌校验继承、JSON 字段形状）——route 写错时内层测试全绿也发现不了。

test('GET /api/health：无令牌 403；有令牌 200 且返回 state/beacon/staleMs', () => {
  const dir = tmpDir('zca-http-');
  fs.writeFileSync(path.join(dir, 'advisor-health-sX.json'), JSON.stringify({
    sessionId: 'sX', lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(),
    state: 'ok', model: 'glm-5.3-flash', reviews: 7
  }));
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const http = require('http');
      const C = require(${JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'))});
      const tok = 'tok-test';
      const srv = C.startApi(1, 0, tok);
      const get = (p, hdr) => new Promise((res) => {
        http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: hdr || {} }, (r) => {
          let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
        });
      });
      srv.on('listening', async () => {
        const noAuth = await get('/api/health');
        const ok = await get('/api/health', { 'x-advisor-token': tok });
        process.stdout.write(JSON.stringify({ noAuth: noAuth.code, code: ok.code, body: JSON.parse(ok.body) }));
        srv.close();
      });
    `
  );
  assert.strictEqual(got.noAuth, 403, '缺令牌必须 403（鉴权对所有路由生效）');
  assert.strictEqual(got.code, 200);
  assert.strictEqual(got.body.ok, true);
  assert.strictEqual(got.body.state, 'ok');
  assert.strictEqual(got.body.beacon.sessionId, 'sX');
  assert.strictEqual(got.body.beacon.reviews, 7);
  assert.ok(got.body.staleMs >= 600000, '应返回 STALE 阈值供 UI 提示');
});

test('GET /api/health：无信标目录 → state=unknown（HTTP 层也不假绿）', () => {
  const dir = tmpDir('zca-http-empty-');   // 空目录
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const http = require('http');
      const C = require(${JSON.stringify(path.join(__dirname, '../tools/companion/controller.cjs'))});
      const tok = 'tok-test';
      const srv = C.startApi(1, 0, tok);
      srv.on('listening', () => {
        http.get({ host: '127.0.0.1', port: srv.address().port, path: '/api/health', headers: { 'x-advisor-token': tok } }, (r) => {
          let b = ''; r.on('data', (c) => b += c); r.on('end', () => {
            process.stdout.write(JSON.stringify({ code: r.statusCode, body: JSON.parse(b) }));
            srv.close();
          });
        });
      });
    `
  );
  assert.strictEqual(got.code, 200);
  assert.strictEqual(got.body.state, 'unknown', '空目录必须 unknown，绝不能 ok');
  assert.strictEqual(got.body.beacon, null);
  assert.strictEqual(got.body.candidates, 0);
});



// ---------------- 信标回收（防无界增长） ----------------

test('pruneBeacons：超龄信标被删；只保留最近 keep 个；非信标文件不受影响', () => {
  const dir = tmpDir('zca-prune-');
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const fsx = require('fs');
      const pathx = require('path');
      const mk = (name, ageDays) => {
        const f = pathx.join(${JSON.stringify(dir)}, name);
        fsx.writeFileSync(f, JSON.stringify({ sessionId: name, lastAttemptAt: new Date().toISOString() }));
        const t = Date.now() - ageDays * 24 * 3600 * 1000;
        fsx.utimesSync(f, t / 1000, t / 1000);
      };
      mk('advisor-health-old1.json', 30);   // 超龄应删
      mk('advisor-health-old2.json', 30);
      mk('advisor-health-fresh1.json', 0.1);  // 较旧的新文件
      mk('advisor-health-fresh2.json', 0);    // 最新，应保留
      fsx.writeFileSync(pathx.join(${JSON.stringify(dir)}, 'keep-me.json'), '{}'); // 非信标
      H.pruneBeacons(${JSON.stringify(dir)}, 7, 1);
      const left = fsx.readdirSync(${JSON.stringify(dir)}).sort();
      process.stdout.write(JSON.stringify(left));
    `
  );
  assert.deepStrictEqual(got, ['advisor-health-fresh2.json', 'keep-me.json'].sort(),
    '超龄删、只留最近 1 个、非信标文件不动');
});

test('readBeacons：maxRead 上限生效（历史信标无界时不做全量解析）', () => {
  const dir = tmpDir('zca-cap-');
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const fsx = require('fs');
      const pathx = require('path');
      for (let i = 0; i < 10; i++) {
        fsx.writeFileSync(pathx.join(${JSON.stringify(dir)}, 'advisor-health-s' + i + '.json'),
          JSON.stringify({ sessionId: 's' + i, lastAttemptAt: new Date(Date.now() - i * 1000).toISOString() }));
      }
      process.stdout.write(JSON.stringify({ capped: H.readBeacons(${JSON.stringify(dir)}, 3).length, all: H.readBeacons(${JSON.stringify(dir)}, 50).length }));
    `
  );
  assert.strictEqual(got.capped, 3, 'maxRead 应限制读取条数');
  assert.strictEqual(got.all, 10, '上限足够时读全部');
});

test('readBeacons：非法时间戳不产生 NaN 排序（与 controller 比较器一致）', () => {
  const dir = tmpDir('zca-nan-');
  const got = runInChild(
    { ZCODE_ADVISOR_HEALTH_DIR: dir, ZCODE_ADVISOR_STATE_DIR: null },
    `
      const fsx = require('fs');
      const pathx = require('path');
      fsx.writeFileSync(pathx.join(${JSON.stringify(dir)}, 'advisor-health-a.json'), JSON.stringify({ sessionId: 'a', lastAttemptAt: 'not-a-date' }));
      fsx.writeFileSync(pathx.join(${JSON.stringify(dir)}, 'advisor-health-b.json'), JSON.stringify({ sessionId: 'b', lastAttemptAt: '' }));
      const out = H.readBeacons(${JSON.stringify(dir)}).map(x => x.sessionId);
      process.stdout.write(JSON.stringify({ sorted: out.slice().sort().join(','), count: out.length }));
    `
  );
  // 关键：不抛错、不丢条目（NaN 比较器会让 sort 结果未定义，但不应崩溃或丢数据）
  assert.strictEqual(got.count, 2, '非法时间戳不得导致条目丢失');
  assert.strictEqual(got.sorted, 'a,b', '两条都应在结果中');
});
