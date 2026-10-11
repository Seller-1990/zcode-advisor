'use strict';

// 探针（非产品代码）：测 R04「全局在飞 worker 上限」在跨进程并发下的超限率。
// 用法：node .audit-evidence/r04-probe.cjs [trials] [N] [hookPath] [limit] [junkFiles] [holdMs]
// 判据：每轮同时拉起 N 个 hook CLI（async 模式 + ZCODE_ADVISOR_NO_SPAWN=1，走到名额门禁后
// 立刻返回），读各自 sess-*.json：lastAction==='spawned-review' 即「通过了名额门禁并开工」。
// 超限 = 通过数 > limit。
// 为了让「先数后取」的窗口可观测，stateDir 里先铺大量无关文件：countLocks 的 readdir 被拉长，
// 两个进程的「数」与「取」就能真正重叠（不是靠运气碰微秒窗口）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRIALS = Number(process.argv[2] || 4);
const N = Number(process.argv[3] || 8);
const HOOK = process.argv[4] || path.join(__dirname, '..', 'plugins', 'zcode-advisor', 'hooks', 'advisor-hook.js');
const LIMIT = Number(process.argv[5] || 1);
const JUNK = Number(process.argv[6] || 20000);
const HOLD_MS = Number(process.argv[7] || 400);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-r04-probe-'));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });
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
const userCfg = path.join(root, 'user-config.json');
fs.writeFileSync(userCfg, JSON.stringify({ maxGlobalWorkers: LIMIT }));

const junkStart = Date.now();
for (let i = 0; i < JUNK; i++) fs.writeFileSync(path.join(stateDir, `junk-${i}`), '');
const junkMs = Date.now() - junkStart;

function hookEnv() {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_REVIEW_MODE: 'async',
    ZCODE_ADVISOR_NO_SPAWN: '1',
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_USER_CONFIG: userCfg,
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

function runTrial(t) {
  return new Promise((resolve) => {
    const procs = [];
    for (let i = 0; i < N; i++) {
      const sid = `t${t}-s${i}`;
      const p = spawn(process.execPath, [HOOK, 'stop'], { env: hookEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
      const rec = { p, sid, err: '' };
      p.stderr.on('data', (d) => { rec.err += String(d); });
      procs.push(rec);
    }
    // 先让 N 个进程都完成启动，再一起投喂 stdin：让「名额门禁」尽量同时刻发生。
    setTimeout(() => {
      for (const r of procs) {
        try {
          r.p.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: r.sid }));
          r.p.stdin.end();
        } catch (_) {}
      }
    }, HOLD_MS);
    Promise.all(procs.map((r) => new Promise((res) => r.p.on('close', () => res())))).then(() => {
      const admitted = [];
      const rejected = [];
      for (const r of procs) {
        let st = null;
        try { st = JSON.parse(fs.readFileSync(path.join(stateDir, `sess-${r.sid}.json`), 'utf8')); } catch (_) {}
        if (st && st.lastAction === 'spawned-review') admitted.push(r.sid);
        else rejected.push(`${r.sid}:${st ? JSON.stringify(st.dropped || {}) : 'NO-STATE'}`);
      }
      clearState();
      resolve({ t, admitted, rejected });
    });
  });
}

(async () => {
  console.log(`probe: trials=${TRIALS} N=${N} limit=${LIMIT} junk=${JUNK}(${junkMs}ms) hook=${HOOK}`);
  let over = 0;
  for (let t = 1; t <= TRIALS; t++) {
    const r = await runTrial(t);
    const bad = r.admitted.length > LIMIT;
    if (bad) over++;
    console.log(`trial ${t}: admitted=${r.admitted.length}${bad ? '  <-- 超限' : ''}  [${r.admitted.join(',')}]  rejected=${r.rejected.length}`);
  }
  console.log(`summary: ${over}/${TRIALS} trials over limit (limit=${LIMIT})`);
})();
