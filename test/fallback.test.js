'use strict';

// 降级（fallback，M4）行为测试。
//
// 本模块最贵的失败模式是**静默掩盖**：fallback 成功会清 failStreak（系统可用），
// 若不同时记录主模型劣化，用户会看到「一切正常」而实际一直在降级。
// 因此测试守住：主模型失败必须留下独立证据（primaryFailStreak + history + 告警），
// 且降级只在「换模型能治」的错上触发、只在 async 模式生效。

const test = require('node:test');
const assert = require('node:assert');
const { reviewTurn } = require('../hooks/advisor-hook');

const TARGET = { baseUrl: 'https://x/v1/chat/completions', model: 'primary-model', apiKey: 'k' };

// 最小 cfg（reviewTurn 只用这几个字段 + fallbackModel/reviewTimeoutMs/reviewMode）。
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

// 注入调用器：按调用序返回预设结果；记录每次调用的 model 与 deadline 间距。
function seqCaller(seq) {
  const calls = [];
  let i = 0;
  const fn = async (p) => {
    calls.push({ model: p.model, deadline: p.deadline, now: Date.now() });
    const v = seq[Math.min(i, seq.length - 1)];
    i++;
    return typeof v === 'function' ? v() : v;
  };
  fn.calls = calls;
  return fn;
}

const OK_FRAME = { text: '{"severity":"none","note":""}' };

// ---------------- 资格判定（fallbackEligibility） ----------------

test('eligibility：未配备用模型 → 不可用', () => {
  const H = require('../hooks/advisor-hook');
  assert.deepStrictEqual(H.fallbackEligibility(mkCfg(), {}, { model: 'primary-model' }), { ok: false, reason: 'no_fallback_model' });
});

test('eligibility：sync 模式 → 禁用（并标注原因）', () => {
  const H = require('../hooks/advisor-hook');
  const r = H.fallbackEligibility(mkCfg({ fallbackModel: 'fb', reviewMode: 'sync' }), {}, { model: 'primary-model' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'fallback_skipped:sync_mode');
});

test('eligibility：会话覆盖了端点 → 禁用（凭据边界）', () => {
  const H = require('../hooks/advisor-hook');
  const state = { sessionApi: { baseUrl: 'https://other.example/v1', apiKey: '', model: '' } };
  const r = H.fallbackEligibility(mkCfg({ fallbackModel: 'fb' }), state, { model: 'primary-model' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'fallback_skipped:session_endpoint');
});

test('eligibility：备用与主模型同名 → 不可用（换了个寂寞）', () => {
  const H = require('../hooks/advisor-hook');
  const r = H.fallbackEligibility(mkCfg({ fallbackModel: 'primary-model' }), {}, { model: 'primary-model' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'fallback_same_model');
});

test('eligibility：会话级 sessionFallbackModel 优先于全局', () => {
  const H = require('../hooks/advisor-hook');
  const state = { sessionFallbackModel: 'sess-fb' };
  assert.strictEqual(H.resolveFallbackModel(mkCfg({ fallbackModel: 'global-fb' }), state), 'sess-fb');
  assert.strictEqual(H.resolveFallbackModel(mkCfg({ fallbackModel: 'global-fb' }), {}), 'global-fb');
});

test('eligibility：async + 有备用模型 → 可用', () => {
  const H = require('../hooks/advisor-hook');
  const r = H.fallbackEligibility(mkCfg({ fallbackModel: 'fb' }), {}, { model: 'primary-model' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'fb');
});

// ---------------- 主败备成 ----------------

test('主败备成：primory llm_empty_response → 切备用并拿到帧', async () => {
  const call = seqCaller([
    { error: 'llm_empty_response' }, // primary 首调
    { error: 'llm_empty_response' }, // primary 空响应重试 1
    { error: 'llm_empty_response' }, // primary 空响应重试 2
    OK_FRAME                          // fallback
  ]);
  const cfg = mkCfg({ fallbackModel: 'fb-model' });
  const r = await reviewTurn(cfg, TARGET, 'delta', false, { state: {}, callReviewer: call });
  assert.ok(r.frame, '应拿到备用模型的帧');
  assert.strictEqual(r.usedFallback, true);
  assert.strictEqual(r.fallbackModel, 'fb-model');
  assert.strictEqual(r.primaryFailure, 'llm_empty_response', '主模型失败原因必须留痕');
  // 备用调用确实用的是 fb-model
  assert.strictEqual(call.calls[call.calls.length - 1].model, 'fb-model');
});

test('主败备成：unparsed 也触发降级（白名单）', async () => {
  const call = seqCaller([
    { text: '{"severity":' },  // 半截 JSON → unparsed（不会空响应重试）
    OK_FRAME
  ]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.ok(r.frame);
  assert.strictEqual(r.usedFallback, true);
  assert.strictEqual(r.primaryFailure, 'unparsed');
});

// ---------------- 白名单边界：不该切的错不切 ----------------

test('白名单：401 不触发降级（key 问题换模型无效）', async () => {
  const call = seqCaller([{ error: 'llm_http_401' }]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.strictEqual(r.error, 'llm_http_401');
  assert.ok(!r.usedFallback);
  assert.strictEqual(call.calls.length, 1, '不应发起第二次（备用）调用');
  assert.strictEqual(call.calls[0].model, 'primary-model');
});

test('白名单：429 不触发降级（限流换模型加剧）', async () => {
  const call = seqCaller([{ error: 'llm_http_429' }]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.strictEqual(r.error, 'llm_http_429');
  assert.strictEqual(call.calls.length, 1);
});

test('白名单：5xx / timeout 不触发降级（端点故障/慢）', async () => {
  for (const code of ['llm_http_500', 'llm_http_503', 'llm_timeout', 'llm_error']) {
    const call = seqCaller([{ error: code }]);
    const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
    assert.strictEqual(call.calls.length, 1, `${code} 不该触发降级`);
    assert.ok(!r.usedFallback);
  }
});

test('未配备用模型：主败即失败，不尝试第二次', async () => {
  const call = seqCaller([{ error: 'llm_empty_response' }, { error: 'llm_empty_response' }, { error: 'llm_empty_response' }]);
  const r = await reviewTurn(mkCfg(), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.strictEqual(r.error, 'llm_empty_response');
  assert.ok(!r.usedFallback, '未配备用模型不应有降级');
  assert.strictEqual(call.calls.length, 3, '只有 primary 的 3 次（首调+2 重试）');
});

// ---------------- 双败 ----------------

test('双败：主败 + 备败 → 报备用错误，且保留主模型失败原因', async () => {
  const call = seqCaller([
    { error: 'llm_empty_response' }, { error: 'llm_empty_response' }, { error: 'llm_empty_response' },
    { error: 'llm_http_500' }
  ]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.strictEqual(r.error, 'llm_http_500', '最终错误来自备用模型');
  assert.strictEqual(r.primaryFailure, 'llm_empty_response', '主模型失败原因仍要留痕供归因');
  assert.match(r.fallbackSkipped || '', /fallback_failed/, '应记录备用也失败');
});

// ---------------- sync 模式禁用 ----------------

test('sync 模式：即使配了备用模型也不降级', async () => {
  const call = seqCaller([
    { error: 'llm_empty_response' }, { error: 'llm_empty_response' }, { error: 'llm_empty_response' }
  ]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb', reviewMode: 'sync' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.strictEqual(r.error, 'llm_empty_response');
  assert.ok(!r.usedFallback);
  assert.strictEqual(r.fallbackSkipped, 'fallback_skipped:sync_mode');
  assert.strictEqual(call.calls.length, 3, 'sync 下只有 primary 尝试');
});

// ---------------- 预算不变量：primary 给备用让出预留 ----------------

test('预算：primary 的 deadline 早于 fallback 的 deadline（预留生效）', async () => {
  const call = seqCaller([
    { error: 'llm_empty_response' }, { error: 'llm_empty_response' }, { error: 'llm_empty_response' },
    OK_FRAME
  ]);
  const cfg = mkCfg({ fallbackModel: 'fb', reviewTimeoutMs: 240000 }); // async → B = 480s, reserve = 120s
  await reviewTurn(cfg, TARGET, 'd', false, { state: {}, callReviewer: call });
  const primaryCall = call.calls.find((c) => c.model === 'primary-model');
  const fbCall = call.calls.find((c) => c.model === 'fb');
  assert.ok(primaryCall && fbCall, '应同时有 primary 与 fallback 调用');
  assert.ok(primaryCall.deadline < fbCall.deadline,
    'primary 的截止时间必须早于 fallback（即为主模型烧预算后的备用留出空间）');
});

test('预算：未配 fallback 时 primary 用满整轮预算（不被预留削减）', async () => {
  const call = seqCaller([OK_FRAME]);
  const cfg = mkCfg({ reviewTimeoutMs: 240000 });
  const t0 = Date.now();
  await reviewTurn(cfg, TARGET, 'd', false, { state: {}, callReviewer: call });
  const usedDeadline = call.calls[0].deadline - t0;
  // async 整轮 = 2×240s = 480s（允许几秒执行开销）
  assert.ok(usedDeadline > 470000, `primary 应用满整轮预算（实际 ${usedDeadline}ms）`);
});

// ---------------- 成功路径不误报降级 ----------------

test('正常成功：不用降级，primaryFailure 为空', async () => {
  const call = seqCaller([OK_FRAME]);
  const r = await reviewTurn(mkCfg({ fallbackModel: 'fb' }), TARGET, 'd', false, { state: {}, callReviewer: call });
  assert.ok(r.frame);
  assert.ok(!r.usedFallback);
  assert.strictEqual(r.primaryFailure, '');
  assert.strictEqual(call.calls.length, 1);
});

// ---------------- 结果落盘（applyReviewOutcome）——「不得静默掩盖」的核心 ----------------
// 这段逻辑 sync/async 共用（applyReviewOutcome）。它是 M4 的不变量所在：
// 降级成功必须清 failStreak（系统可用）但**保留 primaryFailStreak**（主模型仍在坏），
// 否则用户会看到「一切正常」而实际一直在降级。

const { applyReviewOutcome } = require('../hooks/advisor-hook');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 把 history 写到隔离文件（appendHistory 读 env 定路径；本进程首次 require 时已定，
// 故用子进程跑，确保 env 生效）。
function applyInChild(result, stateInit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zca-out-'));
  const hist = path.join(dir, 'h.jsonl');
  const runner = `
    process.env.ZCODE_ADVISOR_HISTORY = ${JSON.stringify(hist)};
    const H = require(${JSON.stringify(path.join(__dirname, '../hooks/advisor-hook'))});
    const s = Object.assign(${JSON.stringify({ sessionId: 's1' })}, ${JSON.stringify(stateInit || {})});
    H.applyReviewOutcome(s, ${JSON.stringify(result)}, { model: 'primary-model' }, {});
    process.stdout.write(JSON.stringify({ s, hist: require('fs').existsSync(${JSON.stringify(hist)}) ? require('fs').readFileSync(${JSON.stringify(hist)},'utf8') : '' }));
  `;
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

test('落盘：主模型失败（无降级）→ 累加 failStreak', () => {
  const got = applyInChild({ error: 'llm_http_500' }, {});
  assert.strictEqual(got.s.failStreak.count, 1);
  assert.strictEqual(got.s.failStreak.reason, 'llm_http_500');
  assert.ok(!got.s.usedFallback);
});

test('落盘：降级成功 → 清 failStreak、保留 primaryFailStreak、写 history', () => {
  const got = applyInChild(
    { frame: { severity: 'nit', note: 'x' }, usedFallback: true, fallbackModel: 'fb', primaryFailure: 'llm_http_404' },
    { failStreak: { reason: 'llm_http_404', count: 2, sinceTs: '2026-01-01T00:00:00.000Z' } }
  );
  assert.strictEqual(got.s.failStreak, null, '降级成功 = 系统可用，failStreak 清零');
  assert.ok(got.s.primaryFailStreak, '主模型劣化证据必须保留');
  assert.strictEqual(got.s.primaryFailStreak.reason, 'llm_http_404');
  assert.strictEqual(got.s.primaryFailStreak.count, 1);
  assert.strictEqual(got.s.fallbackUsed, 1);
  assert.strictEqual(got.s.fallbackLastModel, 'fb');
  const rec = got.hist.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'degraded');
  assert.ok(rec, '必须写入 degraded 事件（唯一不依赖推送通道的持久记录）');
  assert.strictEqual(rec.primaryModel, 'primary-model');
  assert.strictEqual(rec.fallbackModel, 'fb');
  assert.strictEqual(rec.reason, 'llm_http_404');
});

test('落盘：降级累计——连续降级 primaryFailStreak 递增，failStreak 始终 null', () => {
  // 连做两轮降级（第二轮带上第一轮的 primaryFailStreak）
  const got1 = applyInChild(
    { frame: { severity: 'none', note: '' }, usedFallback: true, fallbackModel: 'fb', primaryFailure: 'unparsed' }, {});
  const got2 = applyInChild(
    { frame: { severity: 'none', note: '' }, usedFallback: true, fallbackModel: 'fb', primaryFailure: 'unparsed' },
    { primaryFailStreak: got1.s.primaryFailStreak });
  assert.strictEqual(got2.s.failStreak, null);
  assert.strictEqual(got2.s.primaryFailStreak.count, 2, '主模型连败应递增（用于降级告警阈值）');
});

test('落盘：双败（降级也失败）→ 计 dropped + 保留 primaryFailure', () => {
  const got = applyInChild({ error: 'llm_http_500', primaryFailure: 'llm_empty_response' }, {});
  assert.strictEqual(got.s.dropped.llm_http_500, 1, '按最终（备用）错误计 dropped');
  assert.strictEqual(got.s.primaryFailStreak.reason, 'llm_empty_response', '主模型失败原因单独留痕');
});

test('落盘：普通成功（无降级）→ 清 failStreak，不产生 primaryFailStreak', () => {
  const got = applyInChild(
    { frame: { severity: 'nit', note: 'x' }, usedFallback: false, primaryFailure: '' },
    { failStreak: { reason: 'llm_http_500', count: 2, sinceTs: '2026-01-01T00:00:00.000Z' } }
  );
  assert.strictEqual(got.s.failStreak, null);
  assert.ok(!got.s.primaryFailStreak, '无主模型失败时不应凭空生成 primaryFailStreak');
  assert.strictEqual(got.hist, '', '无降级不应写 history');
});

test('落盘：主模型恢复（成功且非降级）→ 清 primaryFailStreak 与降级告警阶梯', () => {
  // 防回归：primaryFailStreak 曾只增不减（latch），主模型修好后 UPS 永久重发陈旧降级告警。
  // 主模型**自己**成功产出 = 劣化已消，必须与 failStreak 对称地清零，连同告警阶梯一起复位。
  const got = applyInChild(
    { frame: { severity: 'nit', note: 'x' }, usedFallback: false, primaryFailure: '' },
    {
      primaryFailStreak: { reason: 'llm_http_404', count: 3, sinceTs: '2026-01-01T00:00:00.000Z' },
      fallbackLastModel: 'fb', fallbackUsed: 5, degradeAlertCount: 2, degradeNotifiedAt: '2026-01-01T00:00:00.000Z'
    }
  );
  assert.strictEqual(got.s.primaryFailStreak, null, '主模型恢复后劣化连击必须清零（否则是 latch）');
  assert.strictEqual(got.s.degradeAlertCount, 0, '降级告警阶梯应复位');
  assert.strictEqual(got.s.degradeNotifiedAt, '', '降级告警时间戳应清空');
  assert.strictEqual(got.s.fallbackUsed, 5, '历史降级次数是累计证据，不应被清');
});

// —— 清零口径的语义边界（顾问 concern：none 算不算"成功"） ——
// 结论：清零条件是「主模型本轮**自己返回了可解析的帧**」，不是「判据通过」。
//   - severity=none 是模型的合法审查结论（"我没发现问题"），属成功产出 → 清 streak。
//   - llm_empty_response / unparsed 是"没产出"，走 result.error 分支 → 累加 streak，绝不清零。
// 所以"只会回 none 的静默模型"不会掩盖故障：它每次都在产出结论；真正静默的模型是空响应，
// 那类会持续累加到告警阈值。此测试把这条边界钉死，防止日后有人把 none 误并入失败或反之。
test('落盘口径：none 帧（合法结论）→ 视为成功、清 streak（与空响应失败区分）', () => {
  const got = applyInChild(
    { frame: { severity: 'none', note: '' }, usedFallback: false, primaryFailure: '' },
    { failStreak: { reason: 'llm_empty_response', count: 2, sinceTs: '2026-01-01T00:00:00.000Z' } }
  );
  assert.strictEqual(got.s.failStreak, null, 'none 是合法结论，成功产出，应清 failStreak');
});

test('落盘口径：空响应/未解析（真·无产出）→ 累加 streak，绝不当成功清零', () => {
  const empty = applyInChild(
    { error: 'llm_empty_response' },
    { failStreak: { reason: 'llm_empty_response', count: 2, sinceTs: '2026-01-01T00:00:00.000Z' } }
  );
  assert.strictEqual(empty.s.failStreak.count, 3, '空响应必须累加，不得当作成功');
  const unparsed = applyInChild(
    { error: 'unparsed' },
    { failStreak: { reason: 'unparsed', count: 1, sinceTs: '2026-01-01T00:00:00.000Z' } }
  );
  assert.strictEqual(unparsed.s.failStreak.count, 2, '未解析同样累加');
});

// ---------------- 降级告警文案 ----------------

test('degradeAlertLine：含主模型失败次数/时长/原因与备用模型名，且不谎称服务中断', () => {
  const { degradeAlertLine } = require('../hooks/advisor-hook');
  const line = degradeAlertLine(
    { reason: 'llm_http_404', count: 3, sinceTs: new Date(Date.now() - 2 * 3600 * 1000).toISOString() },
    'fb-model', 1);
  assert.match(line, /降级告警/);
  assert.match(line, /第 1 次提醒/);
  assert.match(line, /主模型已连续失败 3 次/);
  assert.match(line, /原因：llm_http_404/);
  assert.match(line, /fb-model/);
  assert.match(line, /服务未中断/, '应说明服务未中断（备用在兜），而非谎报停摆');
  assert.match(line, /\/advisor-setup/);
});
