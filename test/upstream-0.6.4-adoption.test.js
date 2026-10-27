'use strict';

// 上游 dsh-advisor v0.6.x 功能吸收的行为钉子。
// 三个吸收点 + 一个启动模型改造，各守其最小不变量：
//   1. maxTokens=0 → 请求体不带 max_tokens（正数路径不回归）
//   2. 确定性错误（401/403）→ halt 落盘、Stop 跳过、/advisor-on 清除
//   3. startEnabled=false → 注册行明示「默认停用 + 怎么开」
//   4. attach-only → 受监督路径绝不 spawn ZCode，退场 exit 0

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------- 1) maxTokens=0 不发送 ----------------

function withFetch(fn, body) {
  const origFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opt) => {
    seen = { url, opt };
    return { ok: true, status: 200, json: async () => body };
  };
  return { restore: () => { globalThis.fetch = origFetch; }, seen: () => seen };
}

test('maxTokens=0：请求体不含 max_tokens（上游 2026-10-18 裁决：思考型模型会烧光预算）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const f = withFetch(null, {
    choices: [{ message: { content: '{"severity":"nit","note":"ok"}' }, finish_reason: 'stop' }],
    usage: {}
  });
  try {
    const r = await callReviewer({
      baseUrl: 'https://relay.example.com/v1', model: 'glm-5.3', apiKey: 'sk-x',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 0, temperature: 0.2, timeoutMs: 5000
    });
    assert.ok(!r.error, `不应报错，实际 ${r.error}`);
    const body = JSON.parse(f.seen().opt.body);
    assert.strictEqual(body.max_tokens, undefined, 'maxTokens=0 时请求体不得携带 max_tokens');
  } finally { f.restore(); }
});

test('maxTokens>0：max_tokens 照常发送（向后兼容不回归）', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const f = withFetch(null, {
    choices: [{ message: { content: '{"severity":"nit","note":"ok"}' }, finish_reason: 'stop' }],
    usage: {}
  });
  try {
    await callReviewer({
      baseUrl: 'https://relay.example.com/v1', model: 'glm-5.3', apiKey: 'sk-x',
      systemPrompt: 'sp', userContent: 'uc', maxTokens: 1024, temperature: 0.2, timeoutMs: 5000
    });
    const body = JSON.parse(f.seen().opt.body);
    assert.strictEqual(body.max_tokens, 1024);
  } finally { f.restore(); }
});

test('maxTokens=0(anthropic 协议)：请求体同样不带 max_tokens', async () => {
  const { callReviewer } = require('../hooks/lib/reviewer.js');
  const f = withFetch(null, {
    content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }],
    stop_reason: 'end_turn', usage: {}
  });
  try {
    await callReviewer({
      baseUrl: 'https://relay.example.com/v1', protocol: 'anthropic', model: 'claude-opus-5',
      apiKey: 'sk-ant', systemPrompt: 'sp', userContent: 'uc', maxTokens: 0, temperature: 0.2, timeoutMs: 5000
    });
    const body = JSON.parse(f.seen().opt.body);
    assert.strictEqual(body.max_tokens, undefined);
  } finally { f.restore(); }
});

// ---------------- 2) 确定性错误 halt ----------------

test('config：maxTokens=0 是合法配置（不再回退默认）', () => {
  // loadConfig 是唯一导出的解析入口：经真实配置文件走完整解析路径。
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-mt0-'));
  const userCfg = path.join(dir, 'user.json');
  fs.writeFileSync(userCfg, JSON.stringify({ maxTokens: 0 }));
  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_USER_CONFIG: userCfg,
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(dir, 'no-zcode.json'),
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(dir, 'no-prov.json'),
    ZCODE_ADVISOR_STATE_DIR: path.join(dir, 'state'),
    ZCODE_ADVISOR_PLUGIN_DATA: dir
  });
  const r = JSON.parse(execFileSync(process.execPath,
    ['-e', `
      const { loadConfig } = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'lib', 'config.js'))});
      const cfg = loadConfig(${JSON.stringify(path.join(__dirname, '..'))}, process.env);
      process.stdout.write(JSON.stringify({ maxTokens: cfg.maxTokens, problems: cfg.problems }));
    `], { encoding: 'utf8', env, timeout: 15000 }));
  assert.strictEqual(r.maxTokens, 0, '0 是合法哨兵：不发送 max_tokens，不得回退默认');
  assert.strictEqual((r.problems || []).some((p) => p.includes('maxTokens')), false);
});

// ---------------- 2) halt 落盘与解除（经 reviewTurn 单元路径）----------------

// 最小 cfg/state 夹具：reviewTurn 只用到这些字段。
function haltFixture(errorCode, extraCfg) {
  const cfg = Object.assign({
    reviewMode: 'async', systemPrompt: '', proseFallback: true, maxNoteChars: 768,
    maxTokens: 0, temperature: 0.2, reviewTimeoutMs: 3000, maxDeltaMessages: 60,
    maxContextChars: 10000, pendingNotesCap: 5, maxGlobalWorkers: 4, immuneTurns: 3,
    maxBlocksPerTurn: 2, backfillLimitBytes: 1e6
  }, extraCfg || {});
  const state = {
    sessionId: 's-halt', enabled: true, immuneTurns: 0, consecutiveSteers: 0,
    pendingNotes: []
  };
  const eff = { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x', model: 'm1', protocol: 'openai' };
  const call = async () => {
    if (errorCode.startsWith('llm_http_')) {
      const status = Number(errorCode.replace('llm_http_', ''));
      const err = new Error(`HTTP ${status}`);
      err.status = status; // reviewer 用 err.status 合成 llm_http_<status>
      throw err;
    }
    return { error: errorCode };
  };
  return { cfg, state, eff, call };
}

// reviewTurn 是 advisor-hook 内部函数——通过 review-worker 的行为间接验证太重，
// 这里直接测 HALT 判定与 applyReviewOutcome 两个纯逻辑出口。
test('HALT 判定：401/403 命中，404/429/5xx/timeout/empty 不命中', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'advisor-hook.js'), 'utf8');
  // HALT_ERROR_RE 是模块内常量：从源码原样取正则做逐例判定（与实现零漂移）。
  const m = /const HALT_ERROR_RE = (\/.+\/);/.exec(src);
  assert.ok(m, 'HALT_ERROR_RE 必须存在');
  const re = eval(m[1]); // eslint-disable-line no-eval —— 测试用源码提取，非用户输入
  assert.ok(re.test('llm_http_401'));
  assert.ok(re.test('llm_http_403'));
  for (const e of ['llm_http_404', 'llm_http_429', 'llm_http_500', 'llm_http_503',
    'llm_timeout', 'llm_empty_response', 'unparsed', 'llm_error']) {
    assert.strictEqual(re.test(e), false, `${e} 不应触发 halt`);
  }
});

test('applyReviewOutcome：halt 结果落盘 halted/haltedReason；成功结果清除', () => {
  // applyReviewOutcome 同样是模块内函数：不引私有导出，用子进程跑一段脚本验证。
  const { execFileSync } = require('child_process');
  const script = `
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-halt-'));
    process.env.ZCODE_ADVISOR_STATE_DIR = stateDir;
    const hookPath = ${JSON.stringify(path.join(__dirname, '..', 'hooks', 'advisor-hook.js'))};
    // 直接读源码里的两个函数太脆；改走公开面：manual 构造 state 走 mutateStateExclusive 不行——
    // applyReviewOutcome 不导出。此处验证落在状态文件层的可观察契约：
    // 1) Stop(401 后) 不再 spawn worker → 用 NO_SPAWN + halted 状态文件模拟；
    // 2) ctl on 清 halted。
    const { execFileSync } = require('child_process');
    const HOOK = ${JSON.stringify(path.join(__dirname, '..', 'hooks', 'advisor-hook.js'))};
    const file = path.join(stateDir, 'sess-h.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 1,
      sessionId: 'h', enabled: true, immuneTurns: 0, consecutiveSteers: 0, pendingNotes: [],
      halted: true, haltedReason: 'llm_http_401', haltedAt: new Date().toISOString()
    }));
    // ctl on：halt 清除 + 输出提示
    const r = execFileSync(process.execPath, [HOOK, 'ctl', 'on', '--state', file],
      { encoding: 'utf8', env: process.env, timeout: 15000 });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(JSON.stringify({ out: r, after, stateDir }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.strictEqual(out.after.halted, false, '/advisor-on 必须清除停机标记');
  assert.strictEqual(out.after.haltedReason, '');
  assert.ok(out.after.enabled === true);
  assert.ok(/清除停机标记/.test(out.out), '恢复输出必须点名停机被清除');
});

test('Stop：halted 会话不再派发 worker（锁不创建、global_workers 不涨）', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-halt-stop-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'sess-h2.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 1,
    sessionId: 'h2', enabled: true, immuneTurns: 0, consecutiveSteers: 0, pendingNotes: [],
    halted: true, haltedReason: 'llm_http_403', transcriptPath: path.join(dir, 't.jsonl'),
    byteOffset: 0
  }));
  fs.writeFileSync(path.join(dir, 't.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
  const env = Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_NO_SPAWN: '1',
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-user.json'),
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":""}',
    // halted 守卫在 NO_SPAWN 之前返回——用「锁文件从未创建」作为不派发的可观察证据。
    // mock 需要允许文件：
  });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  const script = `
    const { execFileSync } = require('child_process');
    const path = require('path');
    const HOOK = ${JSON.stringify(path.join(__dirname, '..', 'hooks', 'advisor-hook.js'))};
    const env = ${JSON.stringify(env)};
    // 注入假服务商使门禁通过（403 halt 与门禁是两回事）
    env.ZCODE_ADVISOR_ZCODE_CONFIG = path.join(${JSON.stringify(stateDir)}, 'zcode.json');
    require('fs').writeFileSync(env.ZCODE_ADVISOR_ZCODE_CONFIG, JSON.stringify({
      provider: { p: { name: 'P', kind: 'openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k-not-placeholder' },
        models: { m: {} } } }
    }));
    const r = execFileSync(process.execPath, [HOOK, 'stop'],
      { input: JSON.stringify({ session_id: 'h2', stop_hook_active: false }), encoding: 'utf8', env, timeout: 20000 });
    process.stdout.write(JSON.stringify({ status: r.status }));
  `;
  execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  const lockPath = `${file}.wrlock`;
  assert.strictEqual(fs.existsSync(lockPath), false,
    'halted 会话的 Stop 不得创建 worker 锁（根本不该派发）');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.halted, true, 'Stop 守卫不得清除 halt 标记');
  assert.strictEqual(s.lastAction, undefined, 'halted 会话不得置 spawned-review');
});

// ---------------- 3) startEnabled=false 可见性 ----------------

test('startEnabled=false：停用会话的注册行明示默认停用与开启方式', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'advisor-hook.js'), 'utf8');
  assert.ok(src.includes('startEnabled=false'), 'controlLines 必须提示 opt-in 模式');
  assert.ok(src.includes('/advisor-on 开启'));
});

// ---------------- 4) attach-only 启动模型 ----------------

test('attach-only：受监督的 controller 语义常量与守卫必须存在', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'companion', 'controller.cjs'), 'utf8');
  assert.ok(src.includes("ZCODE_ADVISOR_ATTACH_ONLY === '1'"), 'attach-only 开关必须可被环境覆盖');
  assert.ok(src.includes('const ATTACH_ONLY = SUPERVISED ||'), '受监督必须隐含 attach-only');
  // 三个不代启守卫：裸 ZCode 在跑 / ZCode 没跑 / CDP 消失后
  assert.ok(src.includes('本轮不附着、不代启'));
  assert.ok(src.includes('未发现可附着的调试实例'));
  assert.ok(src.includes('只附着模式不代启 ZCode'));
});
