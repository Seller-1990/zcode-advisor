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

// ---------------- 快照安全与边界（ocr 评审发现的回归防护） ----------------

test('快照文件名净化：含路径穿越的 sessionId 不会逃出 snapshots 目录', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-snapsec-'));
  t.after(() => { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '');
  const env = makeEnv(stateDir);

  const transcript = path.join(stateDir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');

  // 恶意/异常 sessionId：含 ../ 与分隔符
  const evilId = '../../evil';
  runHook(['session-start'], { session_id: evilId, transcript_path: transcript }, env);
  runHook(['stop'], { session_id: evilId, transcript_path: transcript, stop_hook_active: false }, env);

  const snapDir = path.join(stateDir, 'snapshots');
  assert.ok(fs.existsSync(snapDir), '应有快照目录');
  const names = fs.readdirSync(snapDir);
  assert.ok(names.length > 0, '应生成快照');
  for (const n of names) {
    assert.ok(!n.includes('/') && !n.includes('..'), `快照名应被净化，实际 ${n}`);
  }
  // 不应在 stateDir 之外产生文件
  assert.ok(!fs.existsSync(path.join(stateDir, '..', 'evil.jsonl')), '不得逃出目录');
});

test('快照清理：保留窗口不小于并发 worker 数（不删在飞快照）', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-snapkeep-'));
  t.after(() => { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '');
  const env = makeEnv(stateDir);
  const transcript = path.join(stateDir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');

  // 造 10 个旧快照
  const snapDir = path.join(stateDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  for (let i = 0; i < 10; i++) {
    const f = path.join(snapDir, `old-${i}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    // 让 mtime 明显更旧
    const past = new Date(Date.now() - (i + 1) * 60000);
    fs.utimesSync(f, past, past);
  }

  runHook(['session-start'], { session_id: 'keepme', transcript_path: transcript }, env);
  runHook(['stop'], { session_id: 'keepme', transcript_path: transcript, stop_hook_active: false }, env);

  const nowSnap = path.join(snapDir, 'keepme.jsonl');
  assert.ok(fs.existsSync(nowSnap), '本轮快照必须存在（绝不能被自己触发的清理删掉）');
});

// ---------------- 4a 心跳健康告警：失败连击在对话内喊一声 ----------------
// 监督器静默死亡问题：审查连续失败（如 API key 过期 401）此前只进 dropped 计数，
// 用户完全无感知。failStreak 达阈值后 UPS 注入告警，重复提醒按升级阶梯
// （1h→3h→6h→24h）拉长间隔；恢复成功后下一次 UPS 喊一声"已恢复"（一次性）。

// 每轮审查之间必须追加转录增量：sync 与手动 worker（持续文件路径）都只审增量，
// 无增量则不发起审查、也就不 bumpDrop。
function appendTurn(transcript, text) {
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
}

test('4a 健康告警：升级阶梯——1h 内不重发，1h/3h/6h/24h 档依次放行', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    // severity 非法 → parseFrame 返回 null → unparsed（mock 与生产同口径）
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  const stateFile = path.join(stateDir, 'sess-h1.json');
  // 把 healthNotifiedAt 拨回到 ms 毫秒前（模拟距上次提醒已过 ms），可选补丁改写其他字段
  const backdate = (ms, patch) => {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    raw.healthNotifiedAt = new Date(Date.now() - ms).toISOString();
    if (patch) patch(raw);
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8');
  };
  // 先消费注册行（此时 failStreak 未满，UPS 只发注册行）
  runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '开始' }, env);

  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `第 ${i + 1} 轮失败内容`);
    runHook(['stop'], { session_id: 'h1', transcript_path: transcript }, env);
  }
  let state = readState(stateDir, 'h1');
  assert.strictEqual(state.failStreak.count, 3);
  assert.strictEqual(state.failStreak.reason, 'unparsed');
  assert.ok(state.failStreak.sinceTs, 'failStreak 应带连击起点 sinceTs');

  // 第 1 次提醒：count=3、pendingNotes 为空，仅有告警也必须 emit
  // （回归关键：旧逻辑 parts 为空就 return，告警会被吞掉）
  const r = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r.status, 0);
  const line1 = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line1.includes('健康告警'), '应注入健康告警行');
  assert.ok(line1.includes('第 1 次提醒'), '应标注第 1 次提醒');
  assert.ok(line1.includes('已连续失败 3 次'));
  assert.ok(line1.includes('原因：unparsed'), '应含失败原因');
  assert.ok(line1.includes('停摆约'), '应含停摆时长');
  assert.ok(line1.includes('/advisor-setup'), '应含可操作提示');
  assert.ok(!line1.includes('监督报个数'), '第 1 次提醒不附 24h 节奏说明');
  state = readState(stateDir, 'h1');
  assert.strictEqual(state.healthAlertCount, 1);
  assert.ok(state.healthNotifiedAt, '注入时应写入 healthNotifiedAt');
  assert.ok(!Number.isNaN(Date.parse(state.healthNotifiedAt)), 'healthNotifiedAt 应为合法 ISO 时间');

  // 1h 档拒绝：刚刚提醒过 → 无输出（注册行已消费、无意见、阶梯未到）
  const r2 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r2.stdout.trim(), '');

  // 1h 档通过：距上次 2h ≥ 1h → 第 2 次提醒
  backdate(2 * 3600 * 1000);
  const r3 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.ok(JSON.parse(r3.stdout).hookSpecificOutput.additionalContext.includes('第 2 次提醒'));
  assert.strictEqual(readState(stateDir, 'h1').healthAlertCount, 2);

  // 3h 档拒绝：距上次 2h < 3h → 不重发
  backdate(2 * 3600 * 1000);
  const r4 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r4.stdout.trim(), '');

  // 3h 档通过：距上次 3.5h → 第 3 次提醒；同时把停摆起点拨回 5h 前验证"停摆约 X 小时"
  backdate(3.5 * 3600 * 1000, (raw) => {
    raw.failStreak.sinceTs = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  });
  const r5 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  const line5 = JSON.parse(r5.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line5.includes('第 3 次提醒'));
  assert.ok(line5.includes('停摆约 5 小时'), '停摆超 1 小时应以小时显示');

  // 6h 档拒绝：距上次 4h < 6h → 不重发
  backdate(4 * 3600 * 1000);
  const r6 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r6.stdout.trim(), '');

  // 6h 档通过：距上次 7h → 第 4 次提醒
  backdate(7 * 3600 * 1000);
  const r7 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  assert.ok(JSON.parse(r7.stdout).hookSpecificOutput.additionalContext.includes('第 4 次提醒'));

  // 24h 档（最后一档，超界取 24h）：距上次 30h → 第 5 次提醒，附提醒节奏说明
  backdate(30 * 3600 * 1000);
  const r8 = runHook(['user-prompt-submit'], { session_id: 'h1', transcript_path: transcript, prompt: '继续' }, env);
  const line8 = JSON.parse(r8.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line8.includes('第 5 次提醒'));
  assert.ok(line8.includes('此后每 24 小时提醒一次'), '第 5 次起应附提醒节奏说明');
  assert.ok(line8.includes('监督报个数'), '节奏说明应含即时查询入口');
});

test('4a 健康告警：count=2 不发；enabled=false 不发', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h2', transcript_path: transcript, prompt: '开始' }, env);
  appendTurn(transcript, '第一轮失败内容');
  runHook(['stop'], { session_id: 'h2', transcript_path: transcript }, env);
  appendTurn(transcript, '第二轮失败内容');
  runHook(['stop'], { session_id: 'h2', transcript_path: transcript }, env);
  assert.strictEqual(readState(stateDir, 'h2').failStreak.count, 2);
  assert.strictEqual(readState(stateDir, 'h2').failStreak.reason, 'unparsed');

  // count=2 低于阈值：不告警（注册行已消费、无意见 → 无输出）
  const r = runHook(['user-prompt-submit'], { session_id: 'h2', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r.stdout.trim(), '');
  assert.strictEqual(readState(stateDir, 'h2').healthNotifiedAt, '');

  // enabled=false：不告警（先凑满 3 次失败，再停用）
  appendTurn(transcript, '第三轮失败内容');
  runHook(['stop'], { session_id: 'h2', transcript_path: transcript }, env);
  const off = runHook(['ctl', 'off', '--state', path.join(stateDir, 'sess-h2.json')], null, env);
  assert.ok(off.stdout.includes('已停用'));
  const r2 = runHook(['user-prompt-submit'], { session_id: 'h2', transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(r2.stdout.trim(), '');
  assert.strictEqual(readState(stateDir, 'h2').healthNotifiedAt, '');
});

test('4a 健康告警：sync 成功审查后 failStreak 重置为 null，不再告警', (t) => {
  const { transcript, stateDir } = setup(t);
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h3', transcript_path: transcript, prompt: '开始' }, envFail);
  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `第 ${i + 1} 轮失败内容`);
    runHook(['stop'], { session_id: 'h3', transcript_path: transcript }, envFail);
  }
  assert.strictEqual(readState(stateDir, 'h3').failStreak.count, 3);
  assert.strictEqual(readState(stateDir, 'h3').failStreak.reason, 'unparsed');

  // 成功审查（合法 none 帧，不入队不打扰）→ failStreak 清零
  const envOk = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":"没有问题"}'
  });
  appendTurn(transcript, '恢复后的新一轮内容');
  runHook(['stop'], { session_id: 'h3', transcript_path: transcript }, envOk);
  assert.strictEqual(readState(stateDir, 'h3').failStreak, null);

  const r = runHook(['user-prompt-submit'], { session_id: 'h3', transcript_path: transcript, prompt: '继续' }, envOk);
  assert.strictEqual(r.stdout.trim(), '');
});

test('4a 健康告警：async worker 成功审查后 failStreak 同样清零', (t) => {
  const { transcript, stateDir } = setup(t);
  const stateFile = path.join(stateDir, 'sess-h4.json');
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h4', transcript_path: transcript, prompt: '开始' }, envFail);
  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `第 ${i + 1} 轮失败内容`);
    runHook(['stop'], { session_id: 'h4', transcript_path: transcript }, envFail);
    runHook(['review-worker', '--state', stateFile], null, envFail);
  }
  assert.strictEqual(readState(stateDir, 'h4').failStreak.count, 3);
  assert.strictEqual(readState(stateDir, 'h4').failStreak.reason, 'unparsed');

  const envOk = makeEnv(stateDir, {
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":"没有问题"}'
  });
  appendTurn(transcript, '恢复后的新一轮内容');
  runHook(['stop'], { session_id: 'h4', transcript_path: transcript }, envOk);
  runHook(['review-worker', '--state', stateFile], null, envOk);
  assert.strictEqual(readState(stateDir, 'h4').failStreak, null);
});

test('4a 健康告警：旧形状 state 文件（无新字段）升级后不炸', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = makeEnv(stateDir);
  runHook(['session-start'], { session_id: 'h5', transcript_path: transcript }, env);
  // 手工抹掉新字段，模拟旧版本写入的会话状态
  const stateFile = path.join(stateDir, 'sess-h5.json');
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete raw.failStreak;
  delete raw.healthNotifiedAt;
  delete raw.healthAlertCount;
  delete raw.healthRecoveryPending;
  fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8');

  // UPS：failStreak 缺失时防御读取，不得抛错
  const r = runHook(['user-prompt-submit'], { session_id: 'h5', transcript_path: transcript, prompt: 'x' }, env);
  assert.strictEqual(r.status, 0);

  // stop（审查失败）：bumpDrop 应在缺失字段上正常建立 failStreak（新版形状带 sinceTs）
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  const r2 = runHook(['stop'], { session_id: 'h5', transcript_path: transcript }, envFail);
  assert.strictEqual(r2.status, 0);
  const streak = readState(stateDir, 'h5').failStreak;
  assert.strictEqual(streak.reason, 'unparsed');
  assert.strictEqual(streak.count, 1);
  assert.ok(streak.sinceTs, '新建连击应带 sinceTs');

  // 旧版本形状的 failStreak（无 sinceTs）达阈值：告警照发，停摆时长防御显示"未知"
  const raw2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw2.failStreak = { reason: 'unparsed', count: 3 };
  delete raw2.healthNotifiedAt;
  delete raw2.healthAlertCount;
  delete raw2.healthRecoveryPending;
  fs.writeFileSync(stateFile, JSON.stringify(raw2, null, 2), 'utf8');
  const r3 = runHook(['user-prompt-submit'], { session_id: 'h5', transcript_path: transcript, prompt: 'x' }, envFail);
  assert.strictEqual(r3.status, 0);
  const line = JSON.parse(r3.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line.includes('健康告警'), '旧形状 state 上告警应照常触发');
  assert.ok(line.includes('第 1 次提醒'), '缺 healthAlertCount 时按第 1 次提醒计');
  assert.ok(line.includes('停摆约 未知'), '缺 sinceTs 时停摆时长防御显示未知');
});

test('4a 恢复信号：告警过的会话恢复后下一次 UPS 喊一声（一次性）', (t) => {
  const { transcript, stateDir } = setup(t);
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h6', transcript_path: transcript, prompt: '开始' }, envFail);
  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `第 ${i + 1} 轮失败内容`);
    runHook(['stop'], { session_id: 'h6', transcript_path: transcript }, envFail);
  }
  // 触发第 1 次告警（此后 healthNotifiedAt 非空）
  const r = runHook(['user-prompt-submit'], { session_id: 'h6', transcript_path: transcript, prompt: '继续' }, envFail);
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('健康告警'));

  // 恢复成功（拿到合法 frame）→ 置恢复标志但不立即注入
  const envOk = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":"没有问题"}'
  });
  appendTurn(transcript, '恢复后的新一轮内容');
  runHook(['stop'], { session_id: 'h6', transcript_path: transcript }, envOk);
  const state = readState(stateDir, 'h6');
  assert.strictEqual(state.healthRecoveryPending, true, '告警过的会话恢复后应置恢复标志');
  assert.strictEqual(state.failStreak, null);

  // 下一次 UPS：注入恢复行，同一临界区内清掉恢复标志/告警时间/告警计数
  const r2 = runHook(['user-prompt-submit'], { session_id: 'h6', transcript_path: transcript, prompt: '继续' }, envOk);
  const line = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line.includes('监督已恢复'), '应注入恢复信号');
  assert.ok(!line.includes('健康告警'), '恢复轮不应同屏再注入告警');
  const state2 = readState(stateDir, 'h6');
  assert.strictEqual(state2.healthRecoveryPending, false);
  assert.strictEqual(state2.healthNotifiedAt, '');
  assert.strictEqual(state2.healthAlertCount, 0);

  // 一次性：再一轮 UPS 不再发恢复消息
  const r3 = runHook(['user-prompt-submit'], { session_id: 'h6', transcript_path: transcript, prompt: '继续' }, envOk);
  assert.strictEqual(r3.stdout.trim(), '');
});

test('4a 恢复信号：从未告警过的会话不发恢复消息', (t) => {
  const { transcript, stateDir } = setup(t);
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h7', transcript_path: transcript, prompt: '开始' }, envFail);
  appendTurn(transcript, '失败一轮（未达告警阈值）');
  runHook(['stop'], { session_id: 'h7', transcript_path: transcript }, envFail);
  // 从未告警（healthNotifiedAt 为空）：成功后不得置恢复标志
  const envOk = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":"没有问题"}'
  });
  appendTurn(transcript, '恢复后的新一轮内容');
  runHook(['stop'], { session_id: 'h7', transcript_path: transcript }, envOk);
  assert.strictEqual(readState(stateDir, 'h7').healthRecoveryPending, false);
  const r = runHook(['user-prompt-submit'], { session_id: 'h7', transcript_path: transcript, prompt: '继续' }, envOk);
  assert.strictEqual(r.stdout.trim(), '');
});

test('4a 恢复信号作废：告警后恢复置标志、再次连败到阈值 → 发告警不发恢复行', (t) => {
  const { transcript, stateDir } = setup(t);
  const envFail = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"catastrophic","note":"非法级别"}'
  });
  runHook(['user-prompt-submit'], { session_id: 'h8', transcript_path: transcript, prompt: '开始' }, envFail);
  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `停摆轮 ${i + 1}`);
    runHook(['stop'], { session_id: 'h8', transcript_path: transcript }, envFail);
  }
  // 第 1 次告警（healthNotifiedAt 非空）
  const r1 = runHook(['user-prompt-submit'], { session_id: 'h8', transcript_path: transcript, prompt: '继续' }, envFail);
  assert.ok(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext.includes('健康告警'));

  // 恢复一轮 → 置恢复标志
  const envOk = makeEnv(stateDir, {
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":"没有问题"}'
  });
  appendTurn(transcript, '短暂恢复轮');
  runHook(['stop'], { session_id: 'h8', transcript_path: transcript }, envOk);
  assert.strictEqual(readState(stateDir, 'h8').healthRecoveryPending, true);

  // 再次连败到阈值：恢复标志必须作废（不发「已恢复」），立即重新告警（第 1 次提醒，不走旧阶梯）
  for (let i = 0; i < 3; i++) {
    appendTurn(transcript, `二次停摆轮 ${i + 1}`);
    runHook(['stop'], { session_id: 'h8', transcript_path: transcript }, envFail);
  }
  const r2 = runHook(['user-prompt-submit'], { session_id: 'h8', transcript_path: transcript, prompt: '继续' }, envFail);
  const line = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!line.includes('监督已恢复'), '再次停摆达阈值时不得注入恢复行（状态说反）');
  assert.ok(line.includes('健康告警'), '应重新注入告警');
  assert.ok(line.includes('第 1 次提醒'), `作废重置后应从第 1 次提醒开始（旧阶梯被清）：${line}`);
  const st = readState(stateDir, 'h8');
  assert.strictEqual(st.healthRecoveryPending, false, '过期恢复标志应被作废');
});

// ---------------- M4 降级告警（UPS 侧，无网络） ----------------
// 直接构造 state（模拟 async worker 已把 primaryFailStreak 累积到阈值），
// 验证 UPS 注入降级告警、且不与停摆告警混淆。这覆盖 alert 组装逻辑，不需要真实端点。

function writeStateForAlert(stateDir, sid, patch) {
  const file = path.join(stateDir, `sess-${sid}.json`);
  const base = {
    schema: 1, sessionId: sid, transcriptPath: '', enabled: true, disabledReason: '',
    pendingRegistration: false, pendingNotes: [], byteOffset: 0, lastHeadHash: '',
    immuneTurns: 0, consecutiveSteers: 0, reviews: 0, steers: 0, deferred: 0, dropped: {},
    failStreak: null, healthNotifiedAt: '', healthAlertCount: 0, healthRecoveryPending: false,
    primaryFailStreak: null, fallbackUsed: 0, fallbackLastAt: '', fallbackLastModel: '',
    degradeNotifiedAt: '', degradeAlertCount: 0, sessionFallbackModel: '',
    tokensIn: 0, tokensOut: 0, sessionModel: '', sessionApi: { baseUrl: '', apiKey: '', model: '' },
    lastAction: '', lastActivity: '', createdAt: new Date().toISOString()
  };
  fs.writeFileSync(file, JSON.stringify(Object.assign(base, patch || {}), null, 2), 'utf8');
  return file;
}

test('M4 告警：primaryFailStreak 达阈值 → UPS 注入降级告警（不停摆告警）', (t) => {
  const { stateDir } = setup(t);
  const env = makeEnv(stateDir);
  writeStateForAlert(stateDir, 'd1', {
    primaryFailStreak: { reason: 'llm_http_404', count: 3, sinceTs: new Date(Date.now() - 3600 * 1000).toISOString() },
    fallbackLastModel: 'fb-model',
    failStreak: null // 系统可用（备用兜住）
  });
  const r = runHook(['user-prompt-submit'], { session_id: 'd1', transcript_path: '/nonexistent', prompt: 'x' }, env);
  const line = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(line.includes('降级告警'), '应注入降级告警');
  assert.ok(line.includes('主模型已连续失败 3 次'), '应含主模型失败次数');
  assert.ok(line.includes('fb-model'), '应指明备用模型');
  assert.ok(!line.includes('健康告警'), '服务未中断，不得报停摆');
  const st = readState(stateDir, 'd1');
  assert.strictEqual(st.degradeAlertCount, 1);
  assert.ok(st.degradeNotifiedAt, '应记录降级告警时间');
});

test('M4 告警：低于阈值不喊；停摆与降级各自独立计数', (t) => {
  const { stateDir } = setup(t);
  const env = makeEnv(stateDir);
  // count=2 < 阈值 3：不喊
  writeStateForAlert(stateDir, 'd2', {
    primaryFailStreak: { reason: 'unparsed', count: 2, sinceTs: new Date().toISOString() }
  });
  const r = runHook(['user-prompt-submit'], { session_id: 'd2', transcript_path: '/nonexistent', prompt: 'x' }, env);
  assert.strictEqual(r.stdout.trim(), '', '未达阈值不应有任何注入');
});

test('M4 告警：同时停摆与降级时只报停摆（避免两条告警刷屏）', (t) => {
  const { stateDir } = setup(t);
  const env = makeEnv(stateDir);
  writeStateForAlert(stateDir, 'd3', {
    failStreak: { reason: 'llm_http_401', count: 3, sinceTs: new Date().toISOString() },
    primaryFailStreak: { reason: 'llm_http_404', count: 5, sinceTs: new Date().toISOString() }
  });
  const r = runHook(['user-prompt-submit'], { session_id: 'd3', transcript_path: '/nonexistent', prompt: 'x' }, env);
  const line = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(line.includes('健康告警'), '停摆优先');
  assert.ok(!line.includes('降级告警'), '停摆期间不叠加降级告警');
});

test('M4 告警：旧形状 state（无 M4 字段）升级后不炸', (t) => {
  const { stateDir } = setup(t);
  const env = makeEnv(stateDir);
  // 模拟仅含旧字段的 state（无 primaryFailStreak/degrade*）
  const file = path.join(stateDir, 'sess-d4.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, sessionId: 'd4', enabled: true, pendingRegistration: false, pendingNotes: [],
    failStreak: null, healthNotifiedAt: '', healthAlertCount: 0, healthRecoveryPending: false,
    dropped: {}, sessionApi: {}
  }), 'utf8');
  const r = runHook(['user-prompt-submit'], { session_id: 'd4', transcript_path: '/nonexistent', prompt: 'x' }, env);
  assert.strictEqual(r.status, 0, '旧形状 state 不应导致崩溃');
});
