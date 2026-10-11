'use strict';

// R04 跨进程闭环：全局在飞 worker 上限（cfg.maxGlobalWorkers）必须在跨进程并发下真实生效。
//
// 为什么必须跨进程：这门禁是「先数后取」（countLocks → createLock），而每个会话的锁文件
// 各不相同（sess-<id>.json.lock）——两个 hook 进程只要都在对方建锁之前完成计数，就会各自
// 看到 max-1 而同时放行、各持一把锁并行开工，全局上限形同虚设。单进程单测覆盖不到：
// count 与 create 在同一轮事件循环里不可能被自己打断。
//
// 窗口放大（可复现性）：stateDir 里预置 1500 个无关文件，把 countLocks 的 readdir 拉长到
// 几十毫秒，使「数-取」窗口稳定重叠。实测 pre-fix（先数后取）：
//   · 自然窗口（无放大）：4 轮里 3 轮超限，limit=1 时最多 6/8 个进程同时开工；
//   · 放大窗口：3 轮里 3 轮 8/8 全部放行。
// 探针与原始输出：.audit-evidence/r04-probe.cjs、.audit-evidence/r04-probe-prefix{,-natural,-2k}.log。
//
// 红灯：ZCA_HOOK_PATH=<repo>/plugins/zcode-advisor/hooks/advisor-hook.js
//       （镜像快照：批次一~三已修、R04 未修；红灯日志 .audit-evidence/r04-red.log）
// 绿灯：默认走仓库 tree（.audit-evidence/r04-green.log）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOOK = process.env.ZCA_HOOK_PATH || path.join(__dirname, '..', 'hooks', 'advisor-hook.js');
const JUNK = 1500;
const N = 8;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-r04-test-'));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });
// 无关文件不进 lock 统计（countLocks 只认 sess-*.json.lock），只用来拉长 readdir。
for (let i = 0; i < JUNK; i++) fs.writeFileSync(path.join(stateDir, `junk-${i}`), '');

const zcodeCfg = path.join(root, 'zcode-v2.json');
fs.writeFileSync(zcodeCfg, JSON.stringify({
  provider: {
    'prov-r04': {
      name: 'R04 网关',
      kind: 'openai-compatible',
      options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'r04-key-abc123-not-placeholder' },
      models: { 'r04-model': {} }
    }
  }
}));
const userCfgFor = (limit) => {
  const p = path.join(root, `user-${limit}.json`);
  fs.writeFileSync(p, JSON.stringify({ maxGlobalWorkers: limit }));
  return p;
};

function hookEnv(limit) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_REVIEW_MODE: 'async',
    ZCODE_ADVISOR_NO_SPAWN: '1',
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_USER_CONFIG: userCfgFor(limit),
    ZCODE_ADVISOR_ZCODE_CONFIG: zcodeCfg,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(root, 'no-such-provider-config.json'),
    ZCODE_ADVISOR_HEALTH_DIR: path.join(root, 'health'),
    ZCODE_ADVISOR_HISTORY: path.join(root, 'history.jsonl'),
    ZCODE_ADVISOR_COMPANION_LOG: path.join(root, 'companion.log')
  });
}

function clearState() {
  for (const f of fs.readdirSync(stateDir)) {
    if (f.startsWith('junk-')) continue;
    try { fs.unlinkSync(path.join(stateDir, f)); } catch (_) {}
  }
}

function waitClose(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch (_) {}
      resolve('timeout');
    }, ms);
    p.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve('closed');
    });
  });
}

// 一轮：同时拉起 N 个 Stop hook（各自不同会话、同一 stateDir），全部释放后统计
// 「通过名额门禁并开工」的个数（lastAction === 'spawned-review'）。
async function trial(tag, limit) {
  const env = hookEnv(limit);
  const procs = [];
  for (let i = 0; i < N; i++) {
    const sid = `${tag}-s${i}`;
    const p = spawn(process.execPath, [HOOK, 'stop'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    procs.push({ p, sid });
  }
  // 先让 N 个进程都启动完，再一起投喂 stdin：让名额门禁尽量同时刻发生。
  await new Promise((r) => setTimeout(r, 400));
  for (const r of procs) {
    try {
      r.p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: r.sid }));
      r.p.stdin.end();
    } catch (_) {}
  }
  const closed = await Promise.all(procs.map((r) => waitClose(r.p, 20000)));
  const admitted = [];
  const rejected = [];
  for (const r of procs) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(stateDir, `sess-${r.sid}.json`), 'utf8')); } catch (_) {}
    if (st && st.lastAction === 'spawned-review') admitted.push(r.sid);
    else rejected.push(`${r.sid}:${st ? JSON.stringify(st.dropped || {}) : 'NO-STATE'}`);
  }
  clearState();
  assert.ok(!closed.includes('timeout'), `[${tag}] 有 hook 子进程 20s 未退出（未投喂 stdin 或实现挂起）`);
  return { admitted, rejected };
}

test('R04：全局上限=1 时并发 8 个 Stop 只能有 1 个开工', async () => {
  for (let t = 1; t <= 3; t++) {
    const { admitted, rejected } = await trial(`lim1-r${t}`, 1);
    assert.strictEqual(
      admitted.length, 1,
      `第 ${t} 轮：maxGlobalWorkers=1，却放行了 ${admitted.length} 个 worker（${admitted.join(',')}）——` +
      `先数后取的窗口里多个进程各自看到 0 把锁而同时开工；其余进程的丢弃原因：${rejected.join(' ')}`
    );
    assert.strictEqual(admitted.length + rejected.length, N, '进程数与统计不一致（有子进程没写状态）');
  }
});

test('R04：全局上限=2 时并发 8 个 Stop 只能有 2 个开工', async () => {
  for (let t = 1; t <= 2; t++) {
    const { admitted, rejected } = await trial(`lim2-r${t}`, 2);
    assert.strictEqual(
      admitted.length, 2,
      `第 ${t} 轮：maxGlobalWorkers=2，却放行了 ${admitted.length} 个 worker（${admitted.join(',')}）；` +
      `其余进程的丢弃原因：${rejected.join(' ')}`
    );
    assert.strictEqual(admitted.length + rejected.length, N, '进程数与统计不一致（有子进程没写状态）');
  }
});

test.after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});
