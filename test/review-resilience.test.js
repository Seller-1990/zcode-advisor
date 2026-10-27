'use strict';

// 评审通道韧性（2026-10-27 批次）行为测试。
//
// 背景：2026-10-24~26 的 unparsed 丢弃潮（89 次审查 61 次丢弃、3 天 2 条意见）
// 暴露了三个叠加缺陷——模型侧 max_tokens 截断思考型模型的正文（P0）、失败无声
// （P1-③④）、确定性失败每轮白烧（P1-⑤）。本文件逐项钉住修复行为：
//
// P0-① OpenAI 通道不发送 max_tokens（对齐上游 dsh-advisor 0.5.7 裁决）；Anthropic 保留。
// P0-② 正文非空 + finish=length + 解析不出帧 → 进截断重试通道；耗尽成 llm_truncated。
// P1-③ unparsed/llm_truncated 留原始响应头部样本（有界、0600）。
// P1-④ 滑动窗口失败率：连击被成功洗零时窗口照样告警。
// P1-⑤ llm_http_404 → halted 停机 + UPS 一次性告知 + /advisor-on 清除。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// history/samples 的文件路径在**模块加载时**解析 env（history.js 的约定）——
// 必须在 require advisor-hook 之前隔离，否则测试会写进真实 ~/.zcode。
const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-resil-'));
process.env.ZCODE_ADVISOR_HISTORY = path.join(TMP_BASE, 'history.jsonl');
test.after(() => { try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) {} });

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'advisor-hook.js');
const { callReviewer } = require('../hooks/lib/reviewer.js');
const { appendSample, headOf } = require('../hooks/lib/samples.js');
const { reviewTurn, applyReviewOutcome, FALLBACK_TRIGGER_REASONS } = require('../hooks/advisor-hook.js');

// ---------------- 工具 ----------------

function withFetch(fn, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = orig; });
}

function okJson(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

// ---------------- P0-①：请求体预算 ----------------

test('callReviewer(openai)：请求体不携带 max_tokens（reasoning 与正文共享上限会截断思考型模型）', async () => {
  let body = null;
  await withFetch(() => callReviewer({
    baseUrl: 'https://x.example.com/v1', model: 'glm-5.3-flash', apiKey: 'k',
    systemPrompt: 'sp', userContent: 'uc',
    maxTokens: 4096, temperature: 0.2, timeoutMs: 5000
  }), async (url, opt) => {
    body = JSON.parse(opt.body);
    return okJson({
      choices: [{ message: { content: '{"severity":"none","note":""}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
  });
  assert.strictEqual(body.max_tokens, undefined, 'OpenAI 通道不得发送 max_tokens');
  assert.ok(!('max_completion_tokens' in body), '也不得以别名发送');
});

test('callReviewer(openai)：finish_reason=length 透传为 finishReason（截断判定靠它）', async () => {
  const r = await withFetch(() => callReviewer({
    baseUrl: 'https://x.example.com/v1', model: 'm', apiKey: 'k',
    systemPrompt: 'sp', userContent: 'uc', maxTokens: 4096, temperature: 0, timeoutMs: 5000
  }), async () => okJson({
    choices: [{ message: { content: '{"severity":"concern","note":"半截' }, finish_reason: 'length' }],
    usage: {}
  }));
  assert.ok(!r.error, `不应报错，实际 ${r.error}`);
  assert.strictEqual(r.finishReason, 'length');
});

test('callReviewer(anthropic)：max_tokens 仍发送（/v1/messages 硬性要求），缺省兜底 4096；stop_reason=max_tokens 归一为 length', async () => {
  const seen = [];
  await withFetch(() => callReviewer({
    baseUrl: 'https://x.example.com/v1', protocol: 'anthropic', model: 'm', apiKey: 'k',
    systemPrompt: 'sp', userContent: 'uc', temperature: 0, timeoutMs: 5000
  }), async (url, opt) => {
    seen.push(JSON.parse(opt.body));
    return okJson({
      content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }],
      stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 }
    });
  });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].max_tokens, 4096, '未配置 maxTokens 时用 Anthropic 兜底值');
  const r = await withFetch(() => callReviewer({
    baseUrl: 'https://x.example.com/v1', protocol: 'anthropic', model: 'm', apiKey: 'k',
    systemPrompt: 'sp', userContent: 'uc', maxTokens: 1024, temperature: 0, timeoutMs: 5000
  }), async () => okJson({
    content: [{ type: 'text', text: '{"severity":"nit","note":"ok"}' }],
    stop_reason: 'max_tokens', usage: {}
  }));
  assert.strictEqual(r.finishReason, 'length', 'stop_reason=max_tokens 归一为 length');
});

// ---------------- P0-②：截断重试与 llm_truncated ----------------

const TARGET = { baseUrl: 'https://x/v1/chat/completions', model: 'primary-model', apiKey: 'k' };

function mkCfg(over) {
  return Object.assign({
    model: 'primary-model',
    baseUrl: TARGET.baseUrl,
    maxTokens: 4096,
    temperature: 0.2,
    reviewTimeoutMs: 240000,
    reviewMode: 'async',
    proseFallback: true,
    maxNoteChars: 768,
    fallbackModel: ''
  }, over || {});
}

function seqCaller(seq) {
  const calls = [];
  const fn = async (p) => {
    calls.push({ p });
    return seq[Math.min(calls.length - 1, seq.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

test('reviewTurn：截断帧（finish=length + 解析失败）触发一次 carry 重试并采纳重试结果', async () => {
  const caller = seqCaller([
    { text: '{"severity":"concern","note":"半截', finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1 } },
    { text: '{"severity":"concern","note":"完整帧"}', finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 2 } }
  ]);
  const r = await reviewTurn(mkCfg(), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.ok(!r.error, `不应报错，实际 ${r.error}`);
  assert.strictEqual(r.frame.severity, 'concern');
  assert.strictEqual(r.frame.note, '完整帧');
  assert.strictEqual(caller.calls.length, 2, '首调 + 1 次重试');
  assert.strictEqual(caller.calls[1].p.temperature, 0, '重试温度归零');
  assert.ok(caller.calls[1].p.userContent.includes('被截断'), '重试携带截断纠正指令');
  assert.ok(caller.calls[1].p.userContent.includes('DELTA'), '重试重发原始 delta');
  // usage 覆盖每一次物理调用（R06 纪律不因重试重构而回退）
  assert.deepStrictEqual(r.usage, { promptTokens: 3, completionTokens: 3 });
});

test('reviewTurn：截断重试耗尽 → llm_truncated（与散文型 unparsed 区分）', async () => {
  const caller = seqCaller([
    { text: '{"severity":"concern","note":"半截', finishReason: 'length' },
    { text: '{"severity":"concern","note":"还是半截', finishReason: 'length' },
    { text: '{"severity":"concern","note":"依旧半截', finishReason: 'length' }
  ]);
  const r = await reviewTurn(mkCfg(), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.strictEqual(r.error, 'llm_truncated');
  assert.strictEqual(caller.calls.length, 3, '首调 + 2 次重试');
});

test('reviewTurn：非 length 的解析失败维持 unparsed 且不重试', async () => {
  const caller = seqCaller([{ text: '纯粹散文回复，没有 JSON 帧', finishReason: 'stop' }]);
  const r = await reviewTurn(mkCfg({ proseFallback: false }), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.strictEqual(r.error, 'unparsed');
  assert.strictEqual(caller.calls.length, 1, '散文型不进截断重试通道');
});

test('reviewTurn：截断但解析成功 → 照常采纳，不重试（截断只救失败帧）', async () => {
  const caller = seqCaller([{ text: '{"severity":"nit","note":"完整帧"}', finishReason: 'length' }]);
  const r = await reviewTurn(mkCfg(), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.ok(!r.error && r.frame.note === '完整帧');
  assert.strictEqual(caller.calls.length, 1);
});

test('reviewTurn：键名漂移的完整 JSON（真机实测形态）触发 schema 纠正重试', async () => {
  // 真机采样实证：glm 经中转网关会返回 {turn_ok,turn_severity,...} 这类另一套
  // schema（finish=stop、JSON 完整但无 severity/note）——旧逻辑直接判 unparsed 丢弃。
  const caller = seqCaller([
    { text: '```json\n{ "turn_ok": false, "turn_severity": "high", "turn_reason": "不可逆删除未确认" }\n```', finishReason: 'stop' },
    { text: '{"severity":"blocker","note":"不可逆删除前未取得确认"}', finishReason: 'stop' }
  ]);
  const r = await reviewTurn(mkCfg(), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.ok(!r.error && r.frame.severity === 'blocker', `应救回帧，实际 ${JSON.stringify(r).slice(0, 120)}`);
  assert.strictEqual(caller.calls.length, 2);
  assert.ok(caller.calls[1].p.userContent.includes('缺少 severity/note'), '携带 schema 纠正指令');
});

test('reviewTurn：JSON 形状的垃圾重试耗尽 → unparsed（有界 3 次调用）', async () => {
  const bad = { text: '{"a":1,"b":2}', finishReason: 'stop' };
  const caller = seqCaller([bad, bad, bad]);
  const r = await reviewTurn(mkCfg({ proseFallback: false }), TARGET, 'DELTA', false, { callReviewer: caller });
  assert.strictEqual(r.error, 'unparsed');
  assert.strictEqual(caller.calls.length, 3);
});

test('llm_truncated 属 fallback 触发白名单', () => {
  assert.ok(FALLBACK_TRIGGER_REASONS.has('llm_truncated'));
});

// ---------------- P1-③：失败样本留存 ----------------

test('appendSample：字段落盘 + 码点截断 + 超限裁剪到一半', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-sample-'));
  const file = path.join(dir, 'samples.jsonl');
  const orig = process.env.ZCODE_ADVISOR_SAMPLES;
  process.env.ZCODE_ADVISOR_SAMPLES = file;
  try {
    assert.ok(appendSample({ error: 'unparsed', model: 'm', finishReason: 'length', textHead: '{"a":', deltaChars: 123, ms: 45 }));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.strictEqual(rec.error, 'unparsed');
    assert.strictEqual(rec.textHead, '{"a":');
    assert.strictEqual(rec.deltaChars, 123);
    assert.ok(rec.ts, '时间戳由模块补齐');
    // 头部截断：按码点
    assert.strictEqual(headOf('a'.repeat(300) + '端', 200).length, 201, '200 码点 + 省略号');
    // 超限裁剪
    for (let i = 0; i < 105; i++) appendSample({ error: 'unparsed', textHead: `s${i}` });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 55, `裁剪到一半以内，实际 ${lines.length}`);
  } finally {
    if (orig === undefined) delete process.env.ZCODE_ADVISOR_SAMPLES;
    else process.env.ZCODE_ADVISOR_SAMPLES = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewTurn：unparsed/llm_truncated 终局自动留样本（含响应头部）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-sample2-'));
  const file = path.join(dir, 'samples.jsonl');
  const orig = process.env.ZCODE_ADVISOR_SAMPLES;
  process.env.ZCODE_ADVISOR_SAMPLES = file;
  try {
    const caller = seqCaller([{ text: '一头散文，肯定解析不出', finishReason: 'stop' }]);
    await reviewTurn(mkCfg({ proseFallback: false }), TARGET, '较长的DELTA内容', false, { callReviewer: caller });
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.strictEqual(rec.error, 'unparsed');
    assert.ok(rec.textHead.includes('散文'), '样本含原始响应头部');
    assert.strictEqual(rec.model, 'primary-model');
  } finally {
    if (orig === undefined) delete process.env.ZCODE_ADVISOR_SAMPLES;
    else process.env.ZCODE_ADVISOR_SAMPLES = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- P1-⑤：确定性失败停机 ----------------

const EFF = { model: 'm-404', providerName: 'p' };

test('applyReviewOutcome：llm_http_404 终局 → halted + history；fallback 救回的不停机', () => {
  const s = { sessionId: 's1', dropped: {}, droppedAt: {}, halted: null };
  applyReviewOutcome(s, { error: 'llm_http_404' }, EFF, mkCfg());
  assert.ok(s.halted && s.halted.reason === 'llm_http_404' && s.halted.model === 'm-404', '404 终局必须停机');
  const hist = fs.readFileSync(process.env.ZCODE_ADVISOR_HISTORY, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(hist.some((h) => h.event === 'halted' && h.reason === 'llm_http_404'), '停机必须留 history');

  const s2 = { sessionId: 's2', dropped: {}, droppedAt: {}, halted: null };
  applyReviewOutcome(s2, { usedFallback: true, fallbackModel: 'fb', primaryFailure: 'llm_http_404' }, EFF, mkCfg());
  assert.strictEqual(s2.halted, null, '备用救回 = 有活路，不停机');
});

test('applyReviewOutcome：winStats 累计成败、2×WIN 折半衰减（P1-④）', () => {
  const s = { sessionId: 's3', dropped: {}, droppedAt: {}, winStats: null };
  for (let i = 0; i < 19; i++) applyReviewOutcome(s, { error: 'unparsed' }, EFF, mkCfg());
  assert.strictEqual(s.winStats.total, 19);
  assert.strictEqual(s.winStats.failed, 19);
  applyReviewOutcome(s, { error: 'unparsed' }, EFF, mkCfg()); // 第 20 次：total=20 → 折半 10
  assert.strictEqual(s.winStats.total, 10);
  assert.strictEqual(s.winStats.failed, 10);
  applyReviewOutcome(s, { frame: { severity: 'none' } }, EFF, mkCfg()); // 成功也计入
  assert.strictEqual(s.winStats.total, 11);
  assert.strictEqual(s.winStats.failed, 10);
});

// ---------------- P1-④⑤：UPS 注入（CLI 级） ----------------

function mkEnv(stateDir) {
  return Object.assign({}, process.env, {
    ZCODE_ADVISOR_STATE_DIR: stateDir,
    ZCODE_ADVISOR_USER_CONFIG: path.join(stateDir, 'no-such-user-config.json'),
    ZCODE_ADVISOR_ZCODE_CONFIG: path.join(stateDir, 'no-such-zcode.json'),
    ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG: path.join(stateDir, 'no-such-provider-config.json')
  });
}

function preseedState(stateDir, sessionId, over) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `sess-${sessionId}.json`);
  const base = Object.assign({
    schema: 1,
    sessionId,
    transcriptPath: '',
    enabled: true,
    disabledReason: '',
    pendingRegistration: false, // 不送注册行，注入内容只反映被测分支
    pendingNotes: [],
    byteOffset: 0,
    lastHeadHash: '',
    immuneTurns: 0,
    consecutiveSteers: 0,
    reviews: 0,
    steers: 0,
    deferred: 0,
    dropped: {},
    failStreak: null,
    healthNotifiedAt: '',
    healthAlertCount: 0,
    healthRecoveryPending: false,
    primaryFailStreak: null,
    fallbackUsed: 0,
    fallbackLastAt: '',
    fallbackLastModel: '',
    degradeNotifiedAt: '',
    degradeAlertCount: 0,
    winStats: { total: 0, failed: 0 },
    rateAlertCount: 0,
    rateNotifiedAt: '',
    halted: null,
    haltNotifiedAt: '',
    tokensIn: 0,
    tokensOut: 0,
    sessionProvider: '',
    sessionModel: '',
    lastAction: '',
    lastActivity: '',
    createdAt: new Date().toISOString()
  }, over || {});
  fs.writeFileSync(file, JSON.stringify(base), 'utf8');
  return file;
}

function runUps(stateDir, sessionId) {
  return spawnSync(process.execPath, [HOOK, 'user-prompt-submit'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: '' }),
    env: mkEnv(stateDir),
    encoding: 'utf8',
    timeout: 60000
  });
}

test('UPS：halted → 一次性停机告知，再次提交不重复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-ups1-'));
  try {
    const stateDir = path.join(dir, 'state');
    const sessionId = 'ups_halt';
    preseedState(stateDir, sessionId, {
      halted: { reason: 'llm_http_404', model: 'm-404', at: '2026-10-27T00:00:00.000Z' }
    });
    const r1 = runUps(stateDir, sessionId);
    assert.strictEqual(r1.status, 0);
    assert.ok(r1.stdout.includes('审查已停机'), `应含停机告知，实际：${r1.stdout.slice(0, 200)}`);
    const st1 = JSON.parse(fs.readFileSync(path.join(stateDir, `sess-${sessionId}.json`), 'utf8'));
    assert.ok(st1.haltNotifiedAt, '告知后置位');
    const r2 = runUps(stateDir, sessionId);
    assert.ok(!r2.stdout.includes('审查已停机'), '一次性：不重复告知');
    // /advisor-on 清除停机（恢复路径）
    const on = spawnSync(process.execPath, [HOOK, 'ctl', 'on', '--state', path.join(stateDir, `sess-${sessionId}.json`)], {
      input: '', env: mkEnv(stateDir), encoding: 'utf8', timeout: 60000
    });
    assert.strictEqual(on.status, 0);
    assert.ok(on.stdout.includes('停机状态已清除'), `on 应报告清除停机：${on.stdout}`);
    const st3 = JSON.parse(fs.readFileSync(path.join(stateDir, `sess-${sessionId}.json`), 'utf8'));
    assert.strictEqual(st3.halted, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPS：窗口失败率 ≥50% 触发告警；比率回落后阶梯重置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-ups2-'));
  try {
    const stateDir = path.join(dir, 'state');
    const sessionId = 'ups_rate';
    preseedState(stateDir, sessionId, {
      winStats: { total: 10, failed: 6 },
      dropped: { unparsed: 6 }
    });
    const r1 = runUps(stateDir, sessionId);
    assert.strictEqual(r1.status, 0);
    assert.ok(r1.stdout.includes('评审质量告警'), `应含窗口告警，实际：${r1.stdout.slice(0, 300)}`);
    assert.ok(r1.stdout.includes('unparsed'), '归因行带最高计数原因');
    assert.ok(r1.stdout.includes('60%'));
    const st1 = JSON.parse(fs.readFileSync(path.join(stateDir, `sess-${sessionId}.json`), 'utf8'));
    assert.strictEqual(st1.rateAlertCount, 1);
    // 二次提交：阶梯间隔压制（第 2 次提醒距上次 1h），不重复
    const r2 = runUps(stateDir, sessionId);
    assert.ok(!r2.stdout.includes('评审质量告警'), '间隔压制生效');
    // 比率回落：重置阶梯
    const file = path.join(stateDir, `sess-${sessionId}.json`);
    const st2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    st2.winStats = { total: 10, failed: 1 };
    fs.writeFileSync(file, JSON.stringify(st2), 'utf8');
    const r3 = runUps(stateDir, sessionId);
    assert.ok(!r3.stdout.includes('评审质量告警'));
    const st3 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(st3.rateAlertCount, 0, '恢复后阶梯重置');
    assert.strictEqual(st3.rateNotifiedAt, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UPS：连击停摆告警在场时窗口告警不重复喊', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcadv-ups3-'));
  try {
    const stateDir = path.join(dir, 'state');
    const sessionId = 'ups_both';
    preseedState(stateDir, sessionId, {
      winStats: { total: 10, failed: 6 },
      dropped: { llm_error: 6 },
      failStreak: { reason: 'llm_error', count: 3, sinceTs: new Date().toISOString() }
    });
    const r = runUps(stateDir, sessionId);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('健康告警'), '连击告警在场');
    assert.ok(!r.stdout.includes('评审质量告警'), '同一劣化不压两遍');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
