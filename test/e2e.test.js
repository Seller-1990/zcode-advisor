'use strict';

// 端到端测试：以子进程方式真实运行 hook 入口（mock 评审模型），覆盖
// session-start / user-prompt-submit / stop（sync+async）/ review-worker / ctl 全链路，
// 以及修复后的关键回归：门禁投递、并发合并、全局 worker 上限、mock 口径。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'advisor-hook.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-basic.jsonl');

function makeEnv(stateDir, extra) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_API_KEY: 'e2e-key-abc123-not-placeholder',
    ZCODE_ADVISOR_NO_SPAWN: '1',
    // 隔离用户级配置，避免读本机真实 ~/.zcode/advisor.config.json
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-such-user-config.json')
  }, extra || {});
}

function runHook(args, stdinObj, env) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: stdinObj ? JSON.stringify(stdinObj) : '',
    env,
    encoding: 'utf8',
    timeout: 60000
  });
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-e2e-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.copyFileSync(FIXTURE, transcript);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  // mock 需要显式允许文件（安全设计：防持久环境变量旁路）
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1', 'utf8');
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return { dir, transcript, stateDir };
}

function readState(stateDir, sessionId) {
  const file = path.join(stateDir, `sess-${sessionId}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return fn();
}

test('session-start 创建状态且无输出；resume 后注册标记重置', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  const r = runHook(['session-start'], { session_id: 's1', transcript_path: transcript }, env);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  const state = readState(stateDir, 's1');
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.pendingRegistration, true);

  // 消费掉注册标记后，resume 事件应把它重新置位
  runHook(['user-prompt-submit'], { session_id: 's1', transcript_path: transcript, prompt: 'x' }, env);
  assert.strictEqual(readState(stateDir, 's1').pendingRegistration, false);
  runHook(['session-start'], { session_id: 's1', transcript_path: transcript, source: 'compact' }, env);
  assert.strictEqual(readState(stateDir, 's1').pendingRegistration, true);
});

test('首条用户消息送达注册行（含脚本与状态文件路径）；后续无注入', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 's2', transcript_path: transcript }, env);
  const r1 = runHook(['user-prompt-submit'], { session_id: 's2', transcript_path: transcript, prompt: '开始干活' }, env);
  assert.strictEqual(r1.status, 0);
  const out = JSON.parse(r1.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith('[advisor]'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('状态文件'));
  const r2 = runHook(['user-prompt-submit'], { session_id: 's2', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r2.stdout.trim(), '');
});

test('门禁失败：注册行与门禁提示仍然投递（命令通道不失联）', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, { ZCODE_ADVISOR_API_KEY: '' });
  const r = runHook(['user-prompt-submit'], { session_id: 'sg', transcript_path: transcript, prompt: 'x' }, env);
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('missing:apiKey'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('状态文件'));
});

test('sync 模式：blocker 立即经 Stop block 送达并进入冷却', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"blocker","note":"你在重复上一个失败的方案"}'
  });
  const r = runHook(['stop'], { session_id: 's3', transcript_path: transcript, stop_hook_active: false }, env);
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.decision, 'block');
  assert.ok(out.reason.startsWith('[advisor:blocker] 你在重复上一个失败的方案'));
  const state = readState(stateDir, 's3');
  assert.strictEqual(state.steers, 1);
  assert.strictEqual(state.immuneTurns, 3);
  assert.ok(state.byteOffset > 0);
});

test('sync 模式：stop_hook_active=true（含字符串变体）时不重审不推进', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"blocker","note":"x"}'
  });
  for (const active of [true, 'true', 1]) {
    const r = runHook(['stop'], { session_id: 's4', transcript_path: transcript, stop_hook_active: active }, env);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  }
  const state = readState(stateDir, 's4');
  assert.strictEqual(state.reviews, 0);
  assert.strictEqual(state.byteOffset, 0);
});

test('sync 模式：冷却期内的 concern 降级为顺延，下条消息送达', (t) => {
  const { transcript, stateDir } = setup(t);
  const envBase = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"blocker","note":"先冷却触发"}'
  });
  runHook(['stop'], { session_id: 's5', transcript_path: transcript }, envBase);
  fs.appendFileSync(transcript, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第二轮回复"}]}}\n');

  const envConcern = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"concern","note":"这里有个实质风险"}'
  });
  const r2 = runHook(['stop'], { session_id: 's5', transcript_path: transcript }, envConcern);
  assert.strictEqual(r2.stdout.trim(), '');
  let state = readState(stateDir, 's5');
  assert.strictEqual(state.pendingNotes.length, 1);
  assert.ok(state.pendingNotes[0].startsWith('[advisor:concern:deferred]'));

  const r3 = runHook(['user-prompt-submit'], { session_id: 's5', transcript_path: transcript, prompt: '下一问' }, envConcern);
  const out = JSON.parse(r3.stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('[advisor:concern:deferred] 这里有个实质风险'));
  state = readState(stateDir, 's5');
  assert.strictEqual(state.pendingNotes.length, 0);
});

test('async 模式：Stop 立即返回，worker 完成审查入队，下条消息送达', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"concern","note":"输入没有做长度校验"}'
  });
  const r1 = runHook(['stop'], { session_id: 's6', transcript_path: transcript }, env);
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r1.stdout.trim(), '');
  assert.ok(fs.existsSync(path.join(stateDir, 'sess-s6.json.lock')));

  const rw = runHook(['review-worker', '--state', path.join(stateDir, 'sess-s6.json')], null, env);
  assert.strictEqual(rw.status, 0);
  const state = readState(stateDir, 's6');
  assert.ok(state.byteOffset > 0);
  assert.strictEqual(state.pendingNotes.length, 1);
  assert.ok(state.pendingNotes[0].startsWith('[advisor:concern] 输入没有做长度校验'));
  assert.strictEqual(state.steers, 1);
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'sess-s6.json.lock')), false);

  const r2 = runHook(['user-prompt-submit'], { session_id: 's6', transcript_path: transcript, prompt: '继续' }, env);
  const out = JSON.parse(r2.stdout);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('[advisor:concern]'));
});

test('async 模式：/advisor-model set 后 worker 使用覆盖模型', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"nit","note":"ok"}'
  });
  runHook(['stop'], { session_id: 'sm', transcript_path: transcript }, env);
  runHook(['review-worker', '--state', path.join(stateDir, 'sess-sm.json')], null, env);
  const setM = runHook(['ctl', 'model', 'set', 'glm-5.3-review', '--state', path.join(stateDir, 'sess-sm.json')], null, env);
  assert.ok(setM.stdout.includes('glm-5.3-review'));
  fs.appendFileSync(transcript, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"新的一轮"}]}}\n');
  runHook(['stop'], { session_id: 'sm', transcript_path: transcript }, env);
  runHook(['review-worker', '--state', path.join(stateDir, 'sess-sm.json')], null, env);
  const st = runHook(['ctl', 'status', '--state', path.join(stateDir, 'sess-sm.json')], null, env);
  assert.ok(st.stdout.includes('glm-5.3-review'));
  assert.ok(st.stdout.includes('本会话覆盖'));
});

test('mock 非法帧与生产同口径：计入 unparsed', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  const r = runHook(['stop'], { session_id: 's7m', transcript_path: transcript }, env);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  const state = readState(stateDir, 's7m');
  assert.strictEqual(state.dropped.unparsed, 1);
  assert.ok(state.byteOffset > 0); // 审查尝试完成即推进
});

test('async 模式：已有新鲜锁时计 busy 不叠加', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 's7', transcript_path: transcript }, env);
  fs.writeFileSync(path.join(stateDir, 'sess-s7.json.lock'), '999999', 'utf8'); // 新鲜锁
  const r = runHook(['stop'], { session_id: 's7', transcript_path: transcript }, env);
  assert.strictEqual(r.stdout.trim(), '');
  const state = readState(stateDir, 's7');
  assert.strictEqual((state.dropped.busy || 0), 1);
});

test('async 模式：全局在飞 worker 达上限时计 global_busy', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, { ZCODE_ADVISOR_MAX_GLOBAL_WORKERS: '1' });
  fs.writeFileSync(path.join(stateDir, 'sess-other.json.lock'), '111', 'utf8'); // 别的会话在飞
  const r = runHook(['stop'], { session_id: 's12', transcript_path: transcript }, env);
  assert.strictEqual(r.stdout.trim(), '');
  const state = readState(stateDir, 's12');
  assert.strictEqual((state.dropped.global_busy || 0), 1);
});

test('P0 回归：审查在飞时 /advisor-off 不被 worker 旧快照回滚', async (t) => {
  const { transcript, stateDir } = setup(t);
  const stateFile = path.join(stateDir, 'sess-s11.json');
  // 本地"只收连接不回包"的 TCP 服务：审查请求确定性地挂起到超时，保证 off 落在在飞窗口内
  const net = require('net');
  const server = net.createServer((sock) => { /* 故意不响应 */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    try { server.close(); } catch (_) {}
  });
  const port = server.address().port;

  const envSpawn = makeEnv(stateDir, {
    ZCODE_ADVISOR_BASE_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    ZCODE_ADVISOR_REVIEW_TIMEOUT_MS: '3000'
  });
  delete envSpawn.ZCODE_ADVISOR_MOCK;
  delete envSpawn.ZCODE_ADVISOR_NO_SPAWN;

  const r = runHook(['stop'], { session_id: 's11', transcript_path: transcript }, envSpawn);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');

  // 审查在飞期间执行 /advisor-off
  const off = runHook(['ctl', 'off', '--state', stateFile], null, envSpawn);
  assert.ok(off.stdout.includes('已停用'));
  assert.strictEqual(readState(stateDir, 's11').enabled, false);

  // worker 落盘后（llm_timeout 计入），enabled 必须保持 false——字段级合并不许回滚
  const settled = waitUntil(() => {
    const s = readState(stateDir, 's11');
    return (s.dropped.llm_timeout || 0) === 1;
  }, 20000);
  assert.ok(settled, 'worker 应在审查超时后落盘');
  assert.strictEqual(readState(stateDir, 's11').enabled, false, '/advisor-off 不得被 worker 回滚');
  assert.strictEqual(fs.existsSync(path.join(stateDir, 'sess-s11.json.lock')), false);
});

test('ctl：status/on/off/model 全链路（--state 精确会话 + --latest 显式回退）', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 's10', transcript_path: transcript }, env);
  const stateFile = path.join(stateDir, 'sess-s10.json');

  const st = runHook(['ctl', 'status', '--state', stateFile], null, env);
  assert.ok(st.stdout.includes('advisor 状态'));
  assert.ok(st.stdout.includes('模式: async'));
  assert.ok(st.stdout.includes('Token 累计'));

  const off = runHook(['ctl', 'off', '--state', stateFile], null, env);
  assert.ok(off.stdout.includes('已停用'));
  assert.strictEqual(readState(stateDir, 's10').enabled, false);

  const on = runHook(['ctl', 'on', '--state', stateFile], null, env);
  assert.ok(on.stdout.includes('已启用'));
  assert.strictEqual(readState(stateDir, 's10').enabled, true);

  const setM = runHook(['ctl', 'model', 'set', 'glm-5.3', '--state', stateFile], null, env);
  assert.ok(setM.stdout.includes('glm-5.3'));
  const st2 = runHook(['ctl', 'status', '--state', stateFile], null, env);
  assert.ok(st2.stdout.includes('本会话覆盖'));

  const resetM = runHook(['ctl', 'model', 'reset', '--state', stateFile], null, env);
  assert.ok(resetM.stdout.includes('全局默认'));

  // --latest 为显式回退标志（单会话时直接可用）
  const latest = runHook(['ctl', 'status', '--latest'], null, env);
  assert.ok(latest.stdout.includes('advisor 状态'));
});

test('ctl：多会话并存时拒绝无 --state 的操作（防误伤）', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 'ma', transcript_path: transcript }, env);
  runHook(['session-start'], { session_id: 'mb', transcript_path: transcript }, env);

  const refused = runHook(['ctl', 'status'], null, env);
  assert.ok(refused.stdout.includes('显式指定目标'));
  assert.ok(refused.stdout.includes('--state'));

  const ok = runHook(['ctl', 'status', '--state', path.join(stateDir, 'sess-ma.json')], null, env);
  assert.ok(ok.stdout.includes('sess-ma') || ok.stdout.includes('ma'));
});

test('ctl doctor：体检输出配置链/门禁（无网络）', (t) => {
  const { stateDir } = setup(t);
  const env = makeEnv(stateDir);
  const r = runHook(['ctl', 'doctor'], null, env);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('advisor 体检'));
  assert.ok(r.stdout.includes('门禁: 满足'));
  // env 提供的 key 会被 loadConfig 收进 cfg.apiKey，来源显示为 config
  assert.ok(r.stdout.includes('key 来源: config'));
  assert.ok(r.stdout.includes('用户级配置'));
});

test('parse_empty：转录有完整行但零解析产率时留信号', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-pe-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, 'not json\n{"also bad"\n', 'utf8');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1', 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  const env = makeEnv(stateDir, { ZCODE_ADVISOR_REVIEW_MODE: 'sync' });
  const r = runHook(['stop'], { session_id: 'pe', transcript_path: transcript }, env);
  assert.strictEqual(r.stdout.trim(), '');
  const state = readState(stateDir, 'pe');
  assert.strictEqual(state.dropped.parse_empty, 1);
  assert.ok(state.byteOffset > 0);
});

// ---------------- ZCode 快照契约（no_transcript 修复） ----------------
// 用户实测：ZCode 给 hook 的 transcript_path 是每轮临时快照（/var/folders/.../T/...），
// Stop 返回即删。async worker 延后读取 → no_transcript，reviews 恒 0。
// 修复：Stop 侧 spawn 前先把转录快照到持久目录，worker 加 --transcript 读快照。

test('ZCode 快照契约：Stop 后临时转录被删，worker 仍能用快照完成审查', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-snap-'));
  t.after(() => { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {} });
  // mock 双要素之二：state 目录下的 .mock-allowed（安全闸，防真实调用）
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '');
  const env = makeEnv(stateDir);

  // 模拟 ZCode 行为：临时目录里的转录（每轮快照）
  const tmpDirZ = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-claude-hook-'));
  const tmpTranscript = path.join(tmpDirZ, 'transcript.jsonl');
  fs.writeFileSync(tmpTranscript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我实现一个功能' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '好的，我来实现' } })
  ].join('\n') + '\n');

  // session-start 记录的是**临时路径**
  runHook(['session-start'], { session_id: 'snap1', transcript_path: tmpTranscript }, env);

  // Stop：spawn 前应把临时转录快照到持久目录
  const r = runHook(['stop'], { session_id: 'snap1', transcript_path: tmpTranscript, stop_hook_active: false }, env);
  assert.strictEqual(r.status, 0);

  // 快照应已生成在 state/snapshots/
  const snapDir = path.join(stateDir, 'snapshots');
  assert.ok(fs.existsSync(snapDir), '应有快照目录');
  const snaps = fs.readdirSync(snapDir).filter((n) => n.endsWith('.jsonl'));
  assert.ok(snaps.length > 0, '应有快照文件');
  const snapContent = fs.readFileSync(path.join(snapDir, snaps[0]), 'utf8');
  assert.ok(snapContent.includes('帮我实现一个功能'), '快照应包含转录内容');

  // **此刻临时转录被宿主删除**（关键时序）
  fs.rmSync(tmpDirZ, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmpTranscript), '临时转录应已消失（模拟宿主清理）');

  // worker 用 --transcript 读快照：应能完成审查（不再 no_transcript）
  const snapPath = path.join(snapDir, snaps[0]);
  const stateFile = path.join(stateDir, 'sess-snap1.json');
  const rw = spawnSync(process.execPath, [HOOK, 'review-worker', '--state', stateFile, '--transcript', snapPath], {
    input: '', env
  });
  assert.strictEqual(rw.status, 0);

  const state = readState(stateDir, 'snap1');
  assert.strictEqual(state.reviews, 1, 'worker 应完成一次审查（不再 no_transcript）');
  assert.ok(state.pendingNotes.length > 0, 'mock 模式应产出意见');
  assert.ok((state.dropped && state.dropped.no_transcript) == null, '不应再有 no_transcript 丢弃');
});
