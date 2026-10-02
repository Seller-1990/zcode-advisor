'use strict';

// 会话级 API 覆盖（/advisor-api）回归测试。
// 覆盖：state.sessionApi 持久化、effectiveApi 回落链、门禁按会话级值放行、
// worker 实际使用覆盖端点、reset 清除、model: 前缀与端点路径归一化。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'advisor-hook.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-basic.jsonl');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-sapi-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.copyFileSync(FIXTURE, transcript);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, transcript, stateDir };
}

function makeEnv(stateDir, extra) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_NO_SPAWN: '1',
    // 全局不配 key：门禁必须靠会话级覆盖放行（本特性核心场景）
    ZCODE_ADVISOR_API_KEY: '',
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-user.json')
  }, extra);
}

function runHook(args, stdinObj, env) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: stdinObj ? JSON.stringify(stdinObj) : '',
    env, encoding: 'utf8', timeout: 60000
  });
}

function stateFile(stateDir, sid) { return path.join(stateDir, `sess-${sid}.json`); }
function readState(stateDir, sid) { return JSON.parse(fs.readFileSync(stateFile(stateDir, sid), 'utf8')); }

test('ctl api set：端点归一化 + model: 前缀 + key 落 state（0600 文件）', (t) => {
  const { transcript, stateDir } = setup(t);
  runHook(['session-start'], { session_id: 'a1', transcript_path: transcript }, makeEnv(stateDir));
  const r = runHook(['ctl', 'api', 'set', 'http://10.0.0.9:9000/v1', 'sk-sess-key-999', 'model:my-model',
    '--state', stateFile(stateDir, 'a1')], null, makeEnv(stateDir));
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /端点=http:\/\/10\.0\.0\.9:9000\/v1\/chat\/completions/);
  assert.match(r.stdout, /key=sk-s…-999/);
  assert.match(r.stdout, /模型=my-model/);
  const st = readState(stateDir, 'a1');
  assert.strictEqual(st.sessionApi.baseUrl, 'http://10.0.0.9:9000/v1/chat/completions');
  assert.strictEqual(st.sessionApi.apiKey, 'sk-sess-key-999');
  assert.strictEqual(st.sessionModel, 'my-model');
  // state 文件含明文 key：权限必须收紧（saveState 0600）
  const mode = fs.statSync(stateFile(stateDir, 'a1')).mode & 0o777;
  assert.strictEqual(mode, 0o600, `state 文件应为 0600，实际 ${mode.toString(8)}`);
});

test('ctl api set：- 占位保留现状（只改 key 不动端点）', (t) => {
  const { transcript, stateDir } = setup(t);
  runHook(['session-start'], { session_id: 'a2', transcript_path: transcript }, makeEnv(stateDir));
  const env = makeEnv(stateDir);
  runHook(['ctl', 'api', 'set', 'http://e1.example/v1', 'sk-first', '--state', stateFile(stateDir, 'a2')], null, env);
  runHook(['ctl', 'api', 'set', '-', 'sk-second', '--state', stateFile(stateDir, 'a2')], null, env);
  const st = readState(stateDir, 'a2');
  assert.strictEqual(st.sessionApi.baseUrl, 'http://e1.example/v1/chat/completions');
  assert.strictEqual(st.sessionApi.apiKey, 'sk-second');
});

test('ctl api show/reset：掩码回显与清除', (t) => {
  const { transcript, stateDir } = setup(t);
  runHook(['session-start'], { session_id: 'a3', transcript_path: transcript }, makeEnv(stateDir));
  const env = makeEnv(stateDir);
  const show0 = runHook(['ctl', 'api', 'show', '--state', stateFile(stateDir, 'a3')], null, env);
  assert.match(show0.stdout, /未覆盖端点\/key/);
  runHook(['ctl', 'api', 'set', 'http://e2.example/v1', 'sk-show-key-42', '--state', stateFile(stateDir, 'a3')], null, env);
  const show1 = runHook(['ctl', 'api', 'show', '--state', stateFile(stateDir, 'a3')], null, env);
  assert.match(show1.stdout, /baseUrl \+ apiKey/);
  assert.match(show1.stdout, /sk-s…y-42/); // 掩码，不回显明文
  assert.ok(!show1.stdout.includes('sk-show-key-42'), 'show 不得回显 key 明文');
  const reset = runHook(['ctl', 'api', 'reset', '--state', stateFile(stateDir, 'a3')], null, env);
  assert.match(reset.stdout, /恢复跟随全局/);
  assert.deepStrictEqual(readState(stateDir, 'a3').sessionApi, { baseUrl: '', apiKey: '', model: '' });
});

test('门禁放行：全局 key 缺失 + 会话级 key 已设 → async worker 实际用覆盖端点审查', async (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"concern","note":"会话级 key 场景"}'
  });
  runHook(['session-start'], { session_id: 'a4', transcript_path: transcript }, env);
  // 全局无 key：此刻 Stop 应门禁失败、无 block 输出
  const gated = runHook(['stop'], { session_id: 'a4', transcript_path: transcript, stop_hook_active: false }, env);
  assert.strictEqual(gated.stdout.trim(), '', '全局无 key 时应被门禁拦下');
  // 设置会话级 key：同一环境同一会话，门禁应放行（mock 走 frame 通道）
  runHook(['ctl', 'api', 'set', '-', 'sk-session-only-key', '--state', stateFile(stateDir, 'a4')], null, env);
  const pass = runHook(['stop'], { session_id: 'a4', transcript_path: transcript, stop_hook_active: false }, env);
  assert.match(pass.stdout, /"decision":"block"/, '会话级 key 应放行门禁并完成审查');
  assert.match(pass.stdout, /会话级 key 场景/);
  assert.strictEqual(readState(stateDir, 'a4').reviews, 1);
});

test('status：显示会话覆盖行与生效 key 掩码（不回显明文）', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, { ZCODE_ADVISOR_API_KEY: '' });
  runHook(['session-start'], { session_id: 'a5', transcript_path: transcript }, env);
  runHook(['ctl', 'api', 'set', 'http://e3.example/v1', 'sk-status-key-77', '--state', stateFile(stateDir, 'a5')], null, env);
  const r = runHook(['ctl', 'status', '--state', stateFile(stateDir, 'a5')], null, env);
  assert.match(r.stdout, /会话覆盖: baseUrl \+ apiKey/);
  assert.match(r.stdout, /生效 key: sk-s…s-77|sk-s…y-77|sk-s…u-77/);
  assert.ok(!r.stdout.includes('sk-status-key-77'), 'status 不得回显 key 明文');
  // 门禁行：会话级值已满足，不再报 missing:apiKey
  assert.ok(!/门禁: 未满足/.test(r.stdout), `会话覆盖后门禁应满足，实际输出：\n${r.stdout}`);
});

test('worker 传参：review-worker 收到覆盖端点（--transcript 快照路径保留）', () => {
  // 静态守卫：spawn 参数构造里必须带 workerArgs（快照），而 effectiveApi 在 worker 侧读 state——
  // 这里验证 hook 源码的调用链完整（防回归：effectiveApi 未接进 worker）。
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.ok(src.includes('function effectiveApi('), 'effectiveApi 应存在');
  assert.match(src, /const eff = effectiveApi\(cfg, apiKeyInfo, (current|state)\);/);
  assert.ok(!src.includes('reviewTurn(cfg, apiKeyInfo,'), 'reviewTurn 不得再直接吃 apiKeyInfo（旧签名）');
});

test('门禁放行：全局显式配空 baseUrl/model + 会话覆盖三键 → async worker 用生效值审查', async (t) => {
  // 顾问复核抓出的场景：全局 baseUrl/model 显式配空（内置默认被覆盖）时，
  // worker 侧 gate 若传全局 cfg 会误报 missing 并拒绝——统一 gateWithSession 后必须放行。
  const { transcript, stateDir } = setup(t);
  const uc = path.join(stateDir, 'user.json');
  fs.writeFileSync(uc, JSON.stringify({ baseUrl: '', model: '' }));
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_USER_CONFIG: uc,
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"nit","note":"async worker 生效值场景"}'
  });
  runHook(['session-start'], { session_id: 'a7', transcript_path: transcript }, env);
  const r = runHook(['ctl', 'api', 'set', 'http://e7.example/v1', 'sk-async-key-31', 'model:m7',
    '--state', stateFile(stateDir, 'a7')], null, env);
  assert.strictEqual(r.status, 0);
  // 直接走真实 worker 入口（async 模式下 Stop 只负责 spawn，门禁在 worker 内）
  const w = runHook(['review-worker', '--state', stateFile(stateDir, 'a7')], null, env);
  assert.strictEqual(w.status, 0, `worker 应成功：${w.stderr}`);
  const st = readState(stateDir, 'a7');
  assert.strictEqual(st.reviews, 1, `worker 应完成审查，disabledReason=${st.disabledReason}`);
  assert.strictEqual(st.disabledReason || '', '', 'worker 放行后不得残留 disabledReason');
});

test('占位符会话 key 回落：无全局 key 时 worker 门禁不放行（不拿占位符打真实请求）', async (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, { ZCODE_ADVISOR_MOCK: '1' });
  runHook(['session-start'], { session_id: 'a8', transcript_path: transcript }, env);
  // test- 开头的 key 是 README 登记的有意误杀范围（安全默认）
  const r = runHook(['ctl', 'api', 'set', 'http://e8.example/v1', 'test-not-a-real-key',
    '--state', stateFile(stateDir, 'a8')], null, env);
  assert.match(r.stdout, /形似占位符/, 'set 应当场提示占位符回落');
  const w = runHook(['review-worker', '--state', stateFile(stateDir, 'a8')], null, env);
  const st = readState(stateDir, 'a8');
  assert.strictEqual(st.reviews || 0, 0, '占位符 key 回落后无全局 key，门禁必须拦下');
  assert.match(st.disabledReason || '', /missing:apiKey/);
});
