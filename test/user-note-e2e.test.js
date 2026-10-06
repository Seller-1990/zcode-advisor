'use strict';

// issue #9 的**跨进程**闭环：controller 侧面板写入 → hook 侧 UserPromptSubmit 送达。
//
// 为什么必须跨进程验证：这是本 issue 的核心承诺——"面板上追加的人工意见，下一轮
// 对话开始时随顾问意见一起注回会话"。controller 与 hook 是两个独立进程，靠
// sess-<id>.json 里的 pendingNotes 队列 + 同一把 <file>.wrlock 交接。
// 单侧单测（各自 mock 对方）无法证明"真的能送达"——只证明"各自按约定调用了函数"。
// 真机上这条链断掉的典型症状是：面板提示"已入队"，用户下一轮却什么都没看到。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'advisor-hook.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-basic.jsonl');

// —— controller 侧的隔离（必须在 require 之前）——
// 真机故障（static-guards 有守卫）：controller.cjs 在模块加载期固化 HEALTH_DIR /
// HISTORY_FILE / LOG_FILE，忘设 env 就会读写用户真实目录。
const healthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-e2e-health-'));
const historyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-e2e-hist-')), 'advisor-history.jsonl');
process.env.ZCODE_ADVISOR_HEALTH_DIR = healthDir;
process.env.ZCODE_ADVISOR_HISTORY = historyFile;
process.env.ZCODE_ADVISOR_COMPANION_LOG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zca-note-e2e-log-')), 'companion.log');
const controller = require('../tools/companion/controller.cjs');

const SESSION_ID = 's9';

function hookEnv(stateDir) {
  // 审查目标（端点/key/模型）一律由 ZCode 第三方服务商解析；自带 fixture 隔离本机真实配置。
  const zcodeCfg = path.join(stateDir, 'zcode-v2.json');
  fs.writeFileSync(zcodeCfg, JSON.stringify({
    provider: {
      'prov-e2e': {
        name: 'E2E 网关',
        kind: 'openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'e2e-key-abc123-not-placeholder' },
        models: { 'e2e-model': {} }
      }
    }
  }));
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_MOCK: '1',
    ZCODE_ADVISOR_NO_SPAWN: '1',
    // sync 审查：一轮 Stop 即写出健康信标（controller 定位会话的前提）。
    // 帧用 severity=none，避免机器意见混进队列干扰断言。
    ZCODE_ADVISOR_REVIEW_MODE: 'sync',
    ZCODE_ADVISOR_MOCK_FRAME: '{"severity":"none","note":""}',
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-such-user-config.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: zcodeCfg,
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(stateDir, 'no-such-provider-config.json'),
    // hook 侧的历史文件必须与 controller 侧同一个（面板据此标注"已跟进"）
    ZCODE_ADVISOR_HISTORY: historyFile
  });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-note-e2e-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.copyFileSync(FIXTURE, transcript);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.mock-allowed'), '1', 'utf8');
  for (const f of fs.readdirSync(healthDir)) { try { fs.unlinkSync(path.join(healthDir, f)); } catch (_) {} }
  try { fs.unlinkSync(historyFile); } catch (_) {}
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, transcript, stateDir };
}

// 建立会话并触发一轮真实审查——健康信标只在审查时写出（health.writeAttempt），
// 而 controller 正是靠信标里的 stateDir 定位 sess-<id>.json。不跑审查就没有信标，
// 面板会（正确地）报 no_session。这一步必须走真实 hook 路径，不能手写信标文件：
// 手写就绕过了"信标格式/stateDir 是否被 controller 读懂"这条真实风险。
function establishSession(transcript, stateDir, env) {
  const rs = runHook(['session-start'], { session_id: SESSION_ID, transcript_path: transcript }, env);
  assert.strictEqual(rs.status, 0);
  fs.appendFileSync(transcript, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一轮回复"}]}}\n');
  const rr = runHook(['stop'], { session_id: SESSION_ID, transcript_path: transcript }, env);
  assert.strictEqual(rr.status, 0);
}

test('issue #9 闭环：面板入队的人工意见由 hook 在下一个 UserPromptSubmit 送达', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = hookEnv(stateDir);

  // ① hook 建会话并跑一轮审查 → 状态文件 + 健康信标就位
  establishSession(transcript, stateDir, env);
  const stateFile = path.join(stateDir, `sess-${SESSION_ID}.json`);
  assert.ok(fs.existsSync(stateFile), 'hook 应创建会话状态文件');
  // 信标文件名必须与 controller 的 locateLatestSessionBeacon 扫描规则一致
  assert.ok(fs.existsSync(path.join(healthDir, `advisor-health-${SESSION_ID}.json`)),
    'hook 应写出健康信标（controller 靠它找到会话）');

  // ② 模拟用户在面板上点「认同并转达」
  const r = controller.enqueueUserNote({
    action: 'ack', severity: 'blocker', note: '这个分支没有覆盖 null 输入。'
  });
  assert.strictEqual(r.ok, true, `面板入队应成功，实际：${JSON.stringify(r)}`);
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.sessionId, SESSION_ID, 'controller 应定位到 hook 刚建的那个会话');

  // ③ 下一个 UserPromptSubmit：hook 必须把这条注回 additionalContext
  const rp = runHook(['user-prompt-submit'],
    { session_id: SESSION_ID, transcript_path: transcript, prompt: '继续' }, env);
  assert.strictEqual(rp.status, 0);
  assert.ok(rp.stdout.trim(), '有排队意见时 hook 必须产出注入内容');
  const ctx = JSON.parse(rp.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[advisor:user:ack\]/,
    `人工意见必须带 [advisor:user:ack] 前缀注回（与机器意见 [advisor:*] 可区分），实际：${ctx}`);
  assert.match(ctx, /这个分支没有覆盖 null 输入。/, '必须带上原意见正文（主模型要知道在说什么）');
  assert.match(ctx, /advisory-only/, 'ack 的语义必须是 advisory-only（不强制改代码）');

  // ④ 送达后队列清空：同一条意见不得在下一轮重复注入
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.pendingNotes.length, 0, '送达后必须从队列移除，否则会每轮重复注入');
  const rp2 = runHook(['user-prompt-submit'],
    { session_id: SESSION_ID, transcript_path: transcript, prompt: '再继续' }, env);
  const ctx2 = rp2.stdout.trim() ? JSON.parse(rp2.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(!/\[advisor:user:ack\]/.test(ctx2), '不得重复送达（重复注入会让主模型以为用户反复强调）');
});

test('issue #9 闭环：hook 的 delivered 历史事件带回人工意见正文，供面板回看', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = hookEnv(stateDir);
  establishSession(transcript, stateDir, env);
  const enq = controller.enqueueUserNote({ action: 'note', severity: 'nit', note: '建议重命名。', text: '这是上游字段名。' });
  assert.strictEqual(enq.ok, true, `面板入队应成功，实际：${JSON.stringify(enq)}`);
  runHook(['user-prompt-submit'], { session_id: SESSION_ID, transcript_path: transcript, prompt: 'x' }, env);

  // 历史文件由 hook 与 controller 共写：面板读的就是这个文件
  const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const delivered = lines.filter((e) => e.event === 'delivered');
  assert.ok(delivered.length >= 1, 'hook 应写 delivered 事件');
  const withNote = delivered.find((e) => /\[advisor:user:note\]/.test(String(e.note || '')));
  assert.ok(withNote, `delivered 事件应带回注回正文（面板据此回看），实际：${JSON.stringify(delivered)}`);
  assert.match(String(withNote.note), /这是上游字段名。/, '用户补充内容也应在历史里可回看');

  // 面板侧读取（controller.readHistory）必须能看到 hook 写的那一行——两侧格式一致
  const seen = controller.readHistory(50);
  assert.ok(seen.some((e) => e.event === 'delivered'), 'controller 的 readHistory 应能读懂 hook 写的事件');
  // 并且 user_followup 标注事件也在同一文件里（面板据此打「已跟进」）
  assert.ok(seen.some((e) => e.event === 'user_followup'),
    'user_followup 标注事件应与 delivered 写进同一 JSONL（面板闭环依赖）');
});

test('issue #9 闭环：hook 停用会话时不送达（与机器意见同一门控，不自开门）', (t) => {
  const { transcript, stateDir } = setup(t);
  const env = hookEnv(stateDir);
  establishSession(transcript, stateDir, env);
  const stateFile = path.join(stateDir, `sess-${SESSION_ID}.json`);
  // 用户停用会话（面板开关写的就是这个字段）
  const st0 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st0.enabled = false;
  fs.writeFileSync(stateFile, JSON.stringify(st0, null, 2));

  const r = controller.enqueueUserNote({ action: 'ack', severity: 'nit', note: '意见' });
  assert.strictEqual(r.ok, true, '停用会话仍允许入队（用户可能正要重新启用）');

  const rp = runHook(['user-prompt-submit'],
    { session_id: SESSION_ID, transcript_path: transcript, prompt: 'x' }, env);
  const ctx = rp.stdout.trim() ? JSON.parse(rp.stdout).hookSpecificOutput.additionalContext : '';
  assert.ok(!/\[advisor:user:ack\]/.test(ctx), '停用的会话不得注入人工意见（门控与机器意见一致）');
  // 队列保留：重新启用后仍应送达，不能因为停用一次就丢
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(st.pendingNotes.length, 1, '停用期间应保留队列（否则用户重新启用就丢了这条意见）');
});
