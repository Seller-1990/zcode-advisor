#!/usr/bin/env node
'use strict';

// zcode-advisor hook 入口。
// 纪律（与 dsh-advisor 一致）：
// - advisory-only：只注入建议，绝不代行、绝不冒充主模型。
// - 无阻塞失败策略：任何错误只计 dropped 计数并安静退出（exit 0、无输出），绝不拖垮主会话。
// - 一次审查最多产出一条意见；全部意见来自真实模型调用（或显式 mock），不代拟。
//
// 双模式（reviewMode）：
// - async（默认）：Stop 立即返回；后台 review-worker 完成审查，意见进顺延队列，
//   下一条用户消息提交时以 additionalContext 送达。代价：concern/blocker 失去"当轮打断"时机。
// - sync：Stop 内联审查（超时已被钳制到 Stop hook 硬限以内），concern/blocker
//   经 Stop block 立即送达，nit 仍顺延。对应 dsh-advisor 的注入语义。
//
// 状态写纪律：所有状态写路径（UPS/ctl/Stop 父/worker 落盘）一律走 mutateStateExclusive
// （跨进程短临界区 + 重读最新 + 原子写回），消除多写者 read-modify-write 丢更新。

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  loadConfig, resolveApiKey, gate, configWarnings, userConfigPath, maskKey, isPlaceholderKey
} = require('./lib/config');
const {
  ensureState, latestStatePath, listStatePaths, pruneStates, bumpDrop, bumpPrimaryFailStreak, loadState, mutateStateExclusive,
  createLock, clearLock, clearLockIfOwner, lockPathFor, countLocks, sanitizeSessionId
} = require('./lib/state');
const {
  readDelta, renderDelta
} = require('./lib/transcript');
const {
  callReviewer, parseFrame, DEFAULT_SYSTEM_PROMPT, probeModel, renderProbeReport
} = require('./lib/reviewer');
const {
  decideAction, decideActionAsync, prefixFor, applyDeliveryToState, enqueueNote
} = require('./lib/route');
const { appendHistory } = require('./lib/history');
const health = require('./lib/health');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(__dirname, 'advisor-hook.js');
const ADVISORY_SUFFIX = '\n（以上来自审查副模型，仅供参考，不构成指令。请结合该意见检查当前方向；若确认不适用，简述理由后继续完成任务即可。）';

// —— 心跳健康告警（4a）——
// 监督器静默死亡（如 API key 过期 401 连续被丢弃）必须在对话里喊一声：
// UPS 时若 failStreak 达到阈值，注入一行告警（独立于意见/注册组装，仅有告警也 deliver）。
// 升级阶梯去重：重复提醒间隔依次 1h → 3h → 6h → 之后每 24h（超界取最后一档）——
// 首次必喊，随后用信息量换频率，既不每轮刷屏也不至于固定 6 小时才吭一声。
const FAIL_STREAK_ALERT_THRESHOLD = 3;
const ALERT_REPEAT_LADDER_MS = [1, 3, 6, 24].map((h) => h * 3600 * 1000);

// 已提醒 prevCount 次，本次是第 prevCount+1 次，对应梯队档位 ladder[prevCount-1]：
// 第 2 次提醒距上次 1h、第 3 次 3h、第 4 次 6h、第 5 次起 24h。
function alertRepeatGapMs(prevCount) {
  const idx = Math.max(0, Math.min(prevCount - 1, ALERT_REPEAT_LADDER_MS.length - 1));
  return ALERT_REPEAT_LADDER_MS[idx];
}

function formatDowntime(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}

function healthAlertLine(streak, alertCount) {
  const sinceTs = Date.parse(streak.sinceTs || '') || 0;
  const downtime = sinceTs > 0 ? formatDowntime(Date.now() - sinceTs) : '未知';
  let line = `[advisor] 健康告警（第 ${alertCount} 次提醒 · 已连续失败 ${streak.count} 次 · 停摆约 ${downtime} · 原因：${streak.reason}）：审查当前不可用。请检查 API key 或端点配置（/advisor-setup 可重新配置）。`;
  if (alertCount >= 5) {
    line += "此后每 24 小时提醒一次；随时说'监督报个数'可即时查询。";
  }
  return line;
}

const HEALTH_RECOVERY_LINE = '[advisor] 监督已恢复：此前有一段不可用期（期间审查可能缺失），现已恢复正常。';

// 降级告警（M4）：主模型持续失败、靠备用模型续命时喊一声。
// 为什么必须喊：fallback 成功会清 failStreak（系统可用），若不同时记录主模型劣化，
// 用户会看到「一切正常」而实际一直在降级——这正是「静默掩盖故障」。
function degradeAlertLine(streak, fallbackModel, alertCount) {
  const sinceTs = Date.parse(streak.sinceTs || '') || 0;
  const dur = sinceTs > 0 ? formatDowntime(Date.now() - sinceTs) : '未知';
  let line = `[advisor] 降级告警（第 ${alertCount} 次提醒 · 主模型已连续失败 ${streak.count} 次 · 持续约 ${dur} · 原因：${streak.reason}）：`
    + `审查当前由备用模型${fallbackModel ? ` ${fallbackModel}` : ''}维持，服务未中断，但主模型本身需要处理（请检查主模型配置：/advisor-setup）。`;
  if (alertCount >= 5) line += "此后每 24 小时提醒一次。";
  return line;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function resolveStateDir(cfg) {
  if (cfg.stateDir && String(cfg.stateDir).trim()) return path.resolve(cfg.stateDir);
  if (process.env.ZCODE_ADVISOR_STATE_DIR) return path.resolve(process.env.ZCODE_ADVISOR_STATE_DIR);
  // 宿主为插件提供的数据目录（跨版本升级保留）；不可用则退回插件目录内。
  const dataDir = process.env.ZCODE_ADVISOR_PLUGIN_DATA || process.env.ZCODE_PLUGIN_DATA;
  if (dataDir) return path.join(dataDir, 'state');
  return path.join(PLUGIN_ROOT, 'state');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// 非匿名化标识：32 位 djb2 变体、无盐、确定性——可被字典穷举确认、同前缀跨会话可关联，
// 仅用于状态文件名与日志 requestId 的弱区分，不得当作脱敏手段。
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function effectiveModel(cfg, state) {
  if (state && state.sessionModel) return { model: state.sessionModel, source: 'session-override' };
  return { model: cfg.model, source: 'global-default' };
}

// 会话级 API 覆盖解析：state.sessionApi 三键（baseUrl/apiKey/model）独立可空，
// 空键回落全局配置（含 apiSource=zcode 已解析出的值）。返回值同时兼容两种消费方：
// reviewTurn 读扁平的 baseUrl/apiKey/model；gate()/configWarnings() 读 resolveApiKey
// 约定的 {key, source} 形状（会话覆盖时 source=session-override，状态行用它区分）。
function effectiveApi(cfg, apiKeyInfo, state) {
  const ov = state && state.sessionApi && typeof state.sessionApi === 'object' ? state.sessionApi : {};
  const baseUrl = String(ov.baseUrl || '').trim();
  const apiKey = String(ov.apiKey || '').trim();
  const effModel = effectiveModel(cfg, state);
  // 会话 key 与全局 resolveApiKey 同一占位符纪律：test-*/your-api-key 一类值
  // 视为未配置，回落全局 key，不放行去打真实请求。
  const sessionKey = apiKey && !isPlaceholderKey(apiKey) ? apiKey : '';
  const resolvedKey = sessionKey || (apiKeyInfo ? apiKeyInfo.key : '');
  return {
    baseUrl: baseUrl || cfg.baseUrl,
    apiKey: resolvedKey,
    key: resolvedKey,
    source: sessionKey ? 'session-override' : ((apiKeyInfo && apiKeyInfo.source) || ''),
    model: effModel.model,
    modelSource: effModel.source,
    // hasOverride/overrides 按**实际生效**的键算：apiKey 被占位符过滤后不算覆盖，
    // 否则 status 显示「已覆盖 apiKey」而实际回落全局，排查时自相矛盾。
    hasOverride: Boolean(baseUrl || sessionKey),
    overrides: [baseUrl && 'baseUrl', sessionKey && 'apiKey'].filter(Boolean)
  };
}

// 门禁按会话生效值评估的统一入口：gate(cfg, ...) 检查第一参的 baseUrl/model 字段，
// 传全局 cfg 会在「全局配空 + 会话已 set 端点/模型」时误报 missing。所有 gate
// 调用点（stop/sync/worker/status/on）必须走这里，防止逐点手搓漏改。
function gateWithSession(cfg, apiKeyInfo, state) {
  const eff = effectiveApi(cfg, apiKeyInfo, state);
  return { eff, reasons: gate({ baseUrl: eff.baseUrl, model: eff.model }, eff) };
}

function isStopHookActive(input) {
  if (!input) return false;
  const v = input.stop_hook_active != null ? input.stop_hook_active : input.stopHookActive;
  return v === true || String(v).toLowerCase() === 'true' || v === 1 || v === '1';
}

// 控制面提示行（不受审查门禁、也不受会话启停约束——它是命令定位与可观测性的载体，
// 停用/缺 key 的会话必须仍能用 /advisor-on、/advisor-status 自救）。
function controlLines(cfg, apiKeyInfo, stateDir, file) {
  const eff = effectiveModel(cfg, null);
  const lines = [];
  lines.push(`[advisor] 审查副模型已挂载：模型=${eff.model}，模式=${cfg.reviewMode}。控制命令：/advisor-status、/advisor-setup、/advisor-on、/advisor-off、/advisor-model、/advisor-api（会话级端点/key 覆盖）。脚本：${SCRIPT_PATH}；状态文件：${file}。`);
  if (process.env.ZCODE_ADVISOR_MOCK === '1' && !mockAllowed(stateDir)) {
    lines.push('[advisor] 配置警告：检测到 ZCODE_ADVISOR_MOCK=1，但 state 目录缺少 .mock-allowed 文件——mock 未生效，将发起真实 API 调用。');
  }
  for (const p of cfg.problems || []) lines.push(`[advisor] 配置问题：${p}`);
  const gateReasons = gate(cfg, apiKeyInfo);
  if (gateReasons.length > 0) {
    lines.push(`[advisor] 门禁未满足（${gateReasons.join(',')}）：审查暂不运行。运行 /advisor-setup 可交互式填写 API key 并验证，或手动编辑用户级配置 ~/.zcode/advisor.config.json。`);
  }
  for (const w of configWarnings(cfg, apiKeyInfo)) lines.push(`[advisor] 配置警告：${w}`);
  return lines;
}

function mockAllowed(stateDir) {
  // mock 需要环境变量 + state 目录下的显式允许文件：防止持久环境变量把
  // "每轮注入攻击者指定 note"的旁路带进正常会话（安全复审第 5 条）。
  try {
    return fs.existsSync(path.join(stateDir, '.mock-allowed'));
  } catch (_) {
    return false;
  }
}

function mockFrame(cfg) {
  const raw = process.env.ZCODE_ADVISOR_MOCK_FRAME;
  let frame = { severity: 'nit', note: '(mock) 建议为本次改动补充一个最小验证。' };
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.severity === 'string') frame = obj;
    } catch (_) {}
  }
  // mock 与生产同口径：同样过 parseFrame 校验，非法帧同样计 unparsed。
  return parseFrame(JSON.stringify(frame), cfg.proseFallback, { maxNoteChars: cfg.maxNoteChars });
}

// 结构化审查日志（默认关闭）：ZCODE_ADVISOR_DEBUG=1 时按行追加到 <stateDir>/review.log。
// 目的：把"审查失败只能通过 /advisor-status 的计数间接观察"变成可回溯单次失败原因
// （error 分类 + requestId + 耗时 + 模型）。默认零常驻 IO（审计报告 B10）。
function logReview(cfg, entry) {
  if (process.env.ZCODE_ADVISOR_DEBUG !== '1') return;
  try {
    const dir = resolveStateDir(cfg);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'review.log'),
      JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (_) { /* 日志是辅助功能，失败不影响审查 */ }
}

// 单轮审查总预算。sync 复用被钳制的 reviewTimeoutMs（≤300s，单轮 < Stop hook 硬超时 320s）；
// async 由后台 worker 执行、无宿主硬限，放宽到 2×reviewTimeoutMs——首次尝试烧满 T 后
// 重试仍有 ≥T 预算（v0.2.7 曾把 async 一并压到 1×，重试预算被首尝试挤占）。
// 不变量：worker 锁 staleMs（=2×timeout+60s）> worker 最坏生命周期（预算 + 有界 ε），
// 2×预算仍满足，双开窗口保持关闭。
function reviewBudgetMs(cfg) {
  return cfg.reviewMode === 'sync' ? cfg.reviewTimeoutMs : cfg.reviewTimeoutMs * 2;
}

// 降级（fallback，M4）：只对「换模型能治」的错切换。
// 端点故障/限流/超时/与模型无关的错**不触发**——换模型只会加剧或无效。
const FALLBACK_TRIGGER_REASONS = new Set(['llm_empty_response', 'unparsed', 'llm_http_404']);

// 备用模型的目标解析：会话级 sessionFallbackModel 优先，其次全局 cfg.fallbackModel。
function resolveFallbackModel(cfg, state) {
  const s = state && typeof state === 'object' ? state : {};
  const sess = String(s.sessionFallbackModel || '').trim();
  if (sess) return sess;
  return String(cfg.fallbackModel || '').trim();
}

// 降级是否可用：需配了备用模型、仅 async 模式、且会话没覆盖端点。
// - 仅 async：reviewBudgetMs 在 sync 下 = T，"预留子预算"会把 primary 砍到 0.5T，
//   且 sync 单轮受 Stop 硬超时 320s 约束，切预算会复活「强杀→指针不推进→每轮重审」停滞。
// - 会话覆盖了 baseUrl：备用模型可能不属于该端点，换 model id 可能无效；且凭据边界
//   （禁止跨端点带 key）要求跳过。
function fallbackEligibility(cfg, state, eff) {
  const model = resolveFallbackModel(cfg, state);
  if (!model) return { ok: false, reason: 'no_fallback_model' };
  if (cfg.reviewMode === 'sync') return { ok: false, reason: 'fallback_skipped:sync_mode' };
  const ovBase = state && state.sessionApi && String(state.sessionApi.baseUrl || '').trim();
  if (ovBase) return { ok: false, reason: 'fallback_skipped:session_endpoint' };
  if (model === eff.model) return { ok: false, reason: 'fallback_same_model' };
  return { ok: true, model };
}

// 备用模型预留子预算：必须 ≥ 备用模型实测 p90 延迟，否则它在主模型烧完预算后
// 拿不到足够剩余（最需要它时失效）。取 min(T, max(30s, T/2))。
// 仅 async 使用（sync 已在 fallbackEligibility 里禁用）。
function fallbackReserveMs(cfg) {
  const T = cfg.reviewTimeoutMs;
  return Math.min(T, Math.max(30000, Math.floor(T / 2)));
}

async function reviewTurn(cfg, target, userContent, allowMock, opts) {
  if (process.env.ZCODE_ADVISOR_MOCK === '1' && allowMock) {
    const frame = mockFrame(cfg);
    if (!frame) return { error: 'unparsed' };
    return { frame };
  }
  const o = opts || {};
  // 可注入的调用器（测试用；生产走真实 callReviewer）。与 probeModel 的 deps 同纪律。
  const call = o.callReviewer || callReviewer;
  const systemPrompt = cfg.systemPrompt && cfg.systemPrompt.trim() ? cfg.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  // 整轮总预算 B（按模式区分，见 reviewBudgetMs）。正常单模型路径整轮共享 overallDeadline；
  // 配了备用模型且候选 eligible 时，给 primary 切成 primaryDeadline 以**预留**备用模型的子预算
  // （否则主模型烧满 B 后备用模型拿不到剩余 → 最需要它时失效）。
  const overallDeadline = Date.now() + reviewBudgetMs(cfg);
  const t0 = Date.now();
  const baseParams = {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    systemPrompt,
    userContent,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    timeoutMs: cfg.reviewTimeoutMs
  };

  // 单次尝试的收尾器：跑首调 + 最多 2 次空响应重试（全共享传入 deadline，不重新起算），
  // **并把「解析成帧」纳入结果**——unparsed 是白名单触发原因之一，只有在解析后才知道，
  // 所以判定与降级决策必须在同一次尝试的结果上做，不能先看 res.error 再解析。
  const runAttempt = async (deadline, model, temperature) => {
    let res = await call(Object.assign({}, baseParams, { model, deadline, temperature }));
    for (let attempt = 0; attempt < 2 && res.error === 'llm_empty_response'; attempt++) {
      if (deadline - Date.now() < 10000) break; // 剩余预算不足一次重试：放弃
      const carry = res.reasoningText
        ? `\n\n【你上一步的分析（供参考，不要重复）】\n${res.reasoningText.slice(0, 3000)}\n\n请基于以上分析，只输出一个 JSON 对象，格式：{"severity":"none|nit|concern|blocker","note":"一句具体建议"}。不要输出任何其他文字。`
        : '\n\n（请直接输出一个 JSON 对象，不要输出推理过程或其他文本。）';
      res = await call(Object.assign({}, baseParams, {
        model, deadline, temperature: 0, userContent: `${userContent}${carry}`
      }));
    }
    if (res.error) return { res, error: res.error, frame: null };
    const frame = parseFrame(res.text, cfg.proseFallback, { maxNoteChars: cfg.maxNoteChars });
    if (!frame) return { res, error: 'unparsed', frame: null };
    return { res, error: '', frame };
  };

  const fb = fallbackEligibility(cfg, o.state, target);
  let primaryDeadline = overallDeadline;
  let fallbackSkipped = '';
  if (!fb.ok && fb.reason && fb.reason.startsWith('fallback_skipped')) fallbackSkipped = fb.reason;
  if (fb.ok) {
    // primary 必须留出 reserve：主模型烧满后备用模型仍有预算（reserve = min(T, max(30s, T/2))）
    primaryDeadline = overallDeadline - fallbackReserveMs(cfg);
  }

  let attempt = await runAttempt(primaryDeadline, target.model, cfg.temperature);
  let usedFallback = false;
  let fallbackModel = '';
  let primaryFailure = '';
  let remainingHint = attempt.res && attempt.res.hint;

  // 主模型失败且属白名单可治 → 用剩余预算（overallDeadline，含预留 reserve）切备用模型。
  if (fb.ok && attempt.error && FALLBACK_TRIGGER_REASONS.has(attempt.error)) {
    primaryFailure = attempt.error;
    const left = overallDeadline - Date.now();
    if (left < 5000) {
      fallbackSkipped = 'fallback_skipped:insufficient_budget'; // 如实记录，不假装降级过
    } else {
      // 备用模型首调同样用 cfg.temperature（与主模型口径一致）；其空响应重试由
      // runAttempt 内部降到 0，与主模型重试同规则——不在降级路径上另立一套温度语义。
      const fbAttempt = await runAttempt(overallDeadline, fb.model, cfg.temperature);
      if (!fbAttempt.error) {
        attempt = fbAttempt;
        usedFallback = true;
        fallbackModel = fb.model;
        remainingHint = '';
      } else {
        // 备用也失败：以备用错误为最终结果，但保留主模型失败原因供告警归因
        attempt = fbAttempt;
        remainingHint = fbAttempt.res && fbAttempt.res.hint;
        fallbackSkipped = `fallback_failed:${fbAttempt.error}`;
      }
    }
  }

  const meta = { model: usedFallback ? fallbackModel : target.model, ms: Date.now() - t0, requestId: hashId(userContent) };
  const usage = attempt.res && attempt.res.usage;
  if (attempt.error) {
    logReview(cfg, Object.assign({ kind: attempt.error === 'unparsed' ? 'unparsed' : 'error', error: attempt.error, hint: remainingHint || '' }, meta));
    return {
      error: attempt.error, usage, hint: remainingHint,
      primaryFailure: primaryFailure || (FALLBACK_TRIGGER_REASONS.has(attempt.error) ? attempt.error : ''),
      fallbackSkipped
    };
  }
  const frame = attempt.frame;
  logReview(cfg, Object.assign({ kind: 'frame', severity: frame.severity }, meta));
  return {
    frame, usage,
    usedFallback, fallbackModel,
    // 主模型曾失败（即便最终经备用恢复）——上层据此维护 primaryFailStreak
    primaryFailure: primaryFailure || '',
    fallbackSkipped
  };
}

// 单轮审查结果落盘（sync / async worker 共用）。抽出来的原因：这段是 M4「不得静默掩盖」
// 的核心不变量所在，两条路径各写一遍随时可能漂移（曾经 async 路径就漏了字段）。
// 调用方负责 reviews 计数、lastActivity、健康信标与指针推进等分支专属工作；
// 这里只管「按审查结果更新 streak / 降级计数 / history」这部分字段。
function applyReviewOutcome(s, result, eff, cfg) {
  if (result.error) {
    bumpDrop(s, result.error);
    // 降级（M4）：主模型失败连击单独维护——即便这次 fallback 也失败，
    // 主模型劣化的证据仍要留下，供降级告警归因。
    if (result.primaryFailure) bumpPrimaryFailStreak(s, result.primaryFailure);
    return;
  }
  // 降级成功：系统可用（清 failStreak），但主模型劣化未消（primaryFailStreak 不动）。
  if (result.usedFallback) {
    s.fallbackUsed = (s.fallbackUsed || 0) + 1;
    s.fallbackLastAt = new Date().toISOString();
    s.fallbackLastModel = result.fallbackModel || '';
    if (result.primaryFailure) bumpPrimaryFailStreak(s, result.primaryFailure);
    // **必须写 history**：降级告警的可见性依赖 additionalContext 与 M1 角标，
    // 两者都可能失效；history 是唯一不依赖实时推送通道的持久记录（M4 必做项）。
    appendHistory({
      event: 'degraded', sessionId: s.sessionId,
      primaryModel: eff.model, fallbackModel: result.fallbackModel || '',
      reason: result.primaryFailure || 'unknown'
    });
  }
  s.failStreak = null; // 审查成功：清零失败连击（4a 健康告警的恢复信号）
}

function accumulateUsage(state, result) {
  if (result && result.usage) {
    state.tokensIn = (state.tokensIn || 0) + (result.usage.promptTokens || 0);
    state.tokensOut = (state.tokensOut || 0) + (result.usage.completionTokens || 0);
  }
}

// ---------------- 事件处理 ----------------

function onSessionStart(ctx) {
  const { stateDir, sessionId, transcriptPath, cfg, input } = ctx;
  const { file } = ensureState(stateDir, sessionId, transcriptPath, cfg.startEnabled);
  pruneStates(stateDir, 7, 50);
  // resume/compact/clear 后重发注册行：旧注册行可能已被压缩出上下文，
  // 没有它 /advisor-* 命令在最需要排查的长会话里失联。
  const source = String((input && (input.source || input.matcher)) || 'startup');
  if (source !== 'startup') {
    mutateStateExclusive(file, (s) => {
      s.pendingRegistration = true;
    });
  }
  // 输出为空：SessionStart 不注入任何内容。
  return;
}

function onUserPromptSubmit(ctx) {
  const { stateDir, sessionId, transcriptPath, cfg, apiKeyInfo } = ctx;
  const { file } = ensureState(stateDir, sessionId, transcriptPath, cfg.startEnabled);

  // 临界区 1：读取队列与注册标记，组装投递内容。
  // 控制面（注册行/门禁提示）不受 enabled 门控——停用的会话也必须能用 /advisor-on 自救。
  let deliver = '';
  let deliveredNoteCount = 0;
  mutateStateExclusive(file, (s) => {
    s.consecutiveSteers = 0;
    s.lastActivity = new Date().toISOString();
    if (transcriptPath && s.transcriptPath !== transcriptPath) {
      s.transcriptPath = transcriptPath;
      s.byteOffset = 0;
      s.lastHeadHash = '';
    }
    const parts = [];
    if (s.enabled && Array.isArray(s.pendingNotes) && s.pendingNotes.length > 0) {
      parts.push(s.pendingNotes.join('\n\n'));
      deliveredNoteCount = s.pendingNotes.length;
    }
    if (s.pendingRegistration) {
      parts.push(controlLines(cfg, apiKeyInfo, stateDir, file).join('\n'));
    }
    // 心跳健康告警（4a）：独立于 pendingNotes/pendingRegistration 组装——
    // 仅有告警时 deliver 也不能为空，否则监督器死了用户仍然无感知。
    // 防御读取：旧会话状态文件没有 failStreak/healthNotifiedAt/healthAlertCount 字段。
    // enabled 门控：用户主动停用的会话不再喊。
    // 恢复信号有前提：当前失败连击未再次达阈值。成功置上恢复标志后又连续失败到
    // 阈值时，注入「已恢复」会把实际仍不可用的状态说反——此时作废恢复标志并重置
    // 告警计数，走告警分支（prevCount=0 令新一轮从第 1 次提醒开始，旧时间戳
    // 因 prevCount<=0 短路不参与间隔压制）。低于阈值（1~2 次）的短暂失败仍播恢复行：
    // 告警只对「达阈值停摆」负责，短暂抖动不打扰。
    const outageActive = s.enabled === true && s.failStreak && (s.failStreak.count || 0) >= FAIL_STREAK_ALERT_THRESHOLD;
    if (s.enabled === true && s.healthRecoveryPending === true && !outageActive) {
      parts.unshift(HEALTH_RECOVERY_LINE);
      // 一次性：注入后同一临界区内清掉恢复标志与告警计数
      s.healthRecoveryPending = false;
      s.healthNotifiedAt = '';
      s.healthAlertCount = 0;
    }
    if (outageActive) {
      if (s.healthRecoveryPending === true) {
        // 过期的恢复标志：审查已再次停摆，恢复行作废、告警计数重置
        s.healthRecoveryPending = false;
        s.healthAlertCount = 0;
      }
      const prevCount = s.healthAlertCount || 0;
      const lastNotified = Date.parse(s.healthNotifiedAt || '') || 0;
      // 首次告警立即发；重复提醒按升级阶梯拉长间隔（1h→3h→6h→24h）
      if (!lastNotified || prevCount <= 0 || Date.now() - lastNotified >= alertRepeatGapMs(prevCount)) {
        const n = prevCount + 1;
        parts.unshift(healthAlertLine(s.failStreak, n));
        // 注入（或决定注入）即在同一临界区内记录次数与时间，防止多写者重复告警
        s.healthAlertCount = n;
        s.healthNotifiedAt = new Date().toISOString();
      }
    }
    // 降级告警（M4）：**独立阶梯**，不与停摆告警共计数——否则两类故障互相压制对方的提醒。
    // 只在「主模型仍在劣化」时喊：primaryFailStreak 达阈值。fallback 成功会清 failStreak
    // 但不清它，所以这条恰好在「系统看似正常、实则一直在降级」时提醒用户。
    const degradeActive = s.enabled === true && s.primaryFailStreak && (s.primaryFailStreak.count || 0) >= FAIL_STREAK_ALERT_THRESHOLD;
    if (degradeActive && !outageActive) {
      const prevDeg = s.degradeAlertCount || 0;
      const lastDeg = Date.parse(s.degradeNotifiedAt || '') || 0;
      if (!lastDeg || prevDeg <= 0 || Date.now() - lastDeg >= alertRepeatGapMs(prevDeg)) {
        const n = prevDeg + 1;
        parts.unshift(degradeAlertLine(s.primaryFailStreak, s.fallbackLastModel, n));
        s.degradeAlertCount = n;
        s.degradeNotifiedAt = new Date().toISOString();
      }
    } else if (!degradeActive && s.primaryFailStreak && (s.primaryFailStreak.count || 0) < FAIL_STREAK_ALERT_THRESHOLD) {
      // 主模型恢复（连击被清空或低于阈值）：重置降级告警阶梯，下次劣化从第 1 次提醒开始
      if (s.degradeNotifiedAt) { s.degradeAlertCount = 0; s.degradeNotifiedAt = ''; }
    }
    if (parts.length > 0) deliver = parts.join('\n\n');
  });

  if (!deliver) return;

  // 先 emit 后落盘清理：emit 后被杀只会导致下轮重复投递（两害取其轻，丢失更糟）。
  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: deliver
    }
  });
  // 历史记录：意见真实送达主会话（与入队记录通过 ts 顺序可对应）
  appendHistory({
    event: 'delivered',
    count: deliveredNoteCount,
    sessionId,
    mode: 'async'
  });
  // 只清除自己已投递的前 deliveredNoteCount 条——临界区间隙里 worker 新入队的意见不受影响。
  mutateStateExclusive(file, (s) => {
    if (deliveredNoteCount > 0 && Array.isArray(s.pendingNotes)) {
      s.pendingNotes = s.pendingNotes.slice(deliveredNoteCount);
    }
    s.pendingRegistration = false;
  });
}

async function onStop(ctx) {
  const { cfg } = ctx;
  if (cfg.reviewMode === 'sync') return onStopSync(ctx);
  return onStopAsync(ctx);
}

// —— async 模式：Stop 立即返回，守护子进程完成审查 ——
function onStopAsync(ctx) {
  const { stateDir, sessionId, transcriptPath, cfg, apiKeyInfo, input } = ctx;
  const { file } = ensureState(stateDir, sessionId, transcriptPath, cfg.startEnabled);

  if (isStopHookActive(input)) {
    mutateStateExclusive(file, (s) => {
      s.lastActivity = new Date().toISOString();
    });
    return;
  }

  const current = loadState(file);
  // 门禁按会话级生效值评估：全局 key/端点/模型任一缺失但本会话已覆盖时照常审查。
  const { reasons: gateReasons } = gateWithSession(cfg, apiKeyInfo, current);
  if (!current || !current.enabled || gateReasons.length > 0) {
    mutateStateExclusive(file, (s) => {
      s.lastActivity = new Date().toISOString();
      if (s.enabled && gateReasons.length > 0) s.disabledReason = gateReasons.join(',');
    });
    // 门禁失败不推进指针：修复配置后可回看积压（受增量窗口与 backfill 上限截断）。
    return;
  }

  // 全局在飞 worker 上限（跨会话），超限丢弃——这是有界积压纪律的跨会话延伸。
  // 只统计新鲜锁：崩溃残留的尸锁不得占用全局额度。
  const staleMs = cfg.reviewTimeoutMs * 2 + 60000;
  if (countLocks(stateDir, staleMs) >= (cfg.maxGlobalWorkers || 4)) {
    mutateStateExclusive(file, (s) => {
      bumpDrop(s, 'global_busy');
      s.lastActivity = new Date().toISOString();
    });
    return;
  }

  // 互斥：同一会话同时在审就不再叠加。
  if (!createLock(file, staleMs)) {
    mutateStateExclusive(file, (s) => {
      bumpDrop(s, 'busy');
      s.lastActivity = new Date().toISOString();
    });
    return;
  }

  mutateStateExclusive(file, (s) => {
    s.lastAction = 'spawned-review';
    s.lastActivity = new Date().toISOString();
  });

  // 健康信标（M1）：父进程必然会执行到此，记「本轮尝试了审查」。
  // worker 被强杀时只有这条会更新，lastSuccessAt 停留 → 读取侧可判 down（而非假绿）。
  {
    const effAttempt = effectiveApi(cfg, apiKeyInfo, current);
    health.writeAttempt(health.resolveHealthDir(process.env), sessionId, {
      model: effAttempt.model, effectiveModel: effAttempt.model
    });
  }

  // —— 转录快照（ZCode 宿主契约适配）——
  // ZCode 给 hook 的 transcript_path 是**每轮临时快照**（/var/folders/.../T/zcode-*-hook-*/），
  // Stop 返回后即被清理。async 的 worker 在 hook 退出后才读 → 必然 no_transcript
  // （实测：reviews=0 全部丢弃于此）。因此 Stop 侧在 spawn 之前**同步读增量并快照**，
  // worker 改读快照文件。
  let snapshotPath = '';
  try {
    const cur = loadState(file);
    if (cur && cur.transcriptPath && fs.existsSync(cur.transcriptPath)) {
      const snapDir = path.join(stateDir, 'snapshots');
      // 权限 0o700：快照含完整转录（可能有源码/密钥），仅属主可读
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      // 文件名净化：sessionId 来自 hook stdin，未净化可被 "../../x" 路径穿越
      const snapFile = path.join(snapDir, `${sanitizeSessionId(sessionId)}.jsonl`);
      fs.copyFileSync(cur.transcriptPath, snapFile);
      // **复制成功后才赋值**：若后续清理抛错，不能让 worker 拿到"已赋值但可能不完整"的路径
      snapshotPath = snapFile;
      fs.chmodSync(snapFile, 0o600);

      // 防堆积：保留最近 N 个（N 至少容纳在飞 worker 数，避免删掉正在被读的快照）
      // worker 是 detached 异步读取，保留窗口必须大于并发上限
      const keep = Math.max(10, (cfg.maxGlobalWorkers || 4) + 6);
      const snaps = fs.readdirSync(snapDir).map((n) => {
        try { return { n, t: fs.statSync(path.join(snapDir, n)).mtimeMs }; } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => b.t - a.t);
      for (const oldSnap of snaps.slice(keep)) {
        // 绝不删除本轮刚写的快照
        if (path.join(snapDir, oldSnap.n) === snapFile) continue;
        try { fs.unlinkSync(path.join(snapDir, oldSnap.n)); } catch (_) {}
      }
    }
  } catch (_) {
    // 快照失败：清空路径，让 worker 退回原路径（会记 no_transcript，但不会拿到坏路径）
    snapshotPath = '';
  }

  // 测试/调试钩子：跳过真实派生，由外部直接调 review-worker。
  if (process.env.ZCODE_ADVISOR_NO_SPAWN === '1') return;

  const workerArgs = ['review-worker', '--state', file];
  if (snapshotPath) workerArgs.push('--transcript', snapshotPath);
  const child = spawn(process.execPath, [__filename, ...workerArgs], {
    detached: true,
    stdio: 'ignore',
    cwd: PLUGIN_ROOT,
    windowsHide: true
  });
  // spawn 失败（EMFILE 等）走异步 error 事件：不挂监听会变 uncaughtException，
  // 且锁无人认领/清除，会话审查将停摆到 staleMs。尽力清锁并计数。
  child.on('error', () => {
    clearLock(file);
    try {
      mutateStateExclusive(file, (s) => {
        bumpDrop(s, 'spawn_failed');
      });
    } catch (_) {}
  });
  child.unref();
  // 不输出、不推进指针：worker 负责读取增量并在完成后推进。
}

// —— sync 模式：Stop 内联审查，concern/blocker 立即送达 ——
async function onStopSync(ctx) {
  const { stateDir, sessionId, transcriptPath, cfg, apiKeyInfo, input } = ctx;
  const { file, state: st } = ensureState(stateDir, sessionId, transcriptPath, cfg.startEnabled);

  // 续跑响应（由我们的 block 触发的那一轮）不重审、不推进指针：其内容并入下一次真实审查。
  if (isStopHookActive(input)) {
    mutateStateExclusive(file, (s) => {
      s.lastActivity = new Date().toISOString();
    });
    return;
  }

  mutateStateExclusive(file, (s) => {
    s.lastActivity = new Date().toISOString();
  });
  const current = loadState(file);
  if (!current || !current.enabled) return;

  // 门禁按会话级生效值评估（与 async 路径同一口径）。
  const gateReasons = gateWithSession(cfg, apiKeyInfo, current).reasons;
  if (gateReasons.length > 0) {
    mutateStateExclusive(file, (s) => {
      s.disabledReason = gateReasons.join(',');
    });
    // 门禁失败不推进指针：修复配置后可回看积压（受增量窗口与 backfill 上限截断）。
    return;
  }

  const delta = readDelta(current.transcriptPath, current.byteOffset, {
    expectedHeadHash: current.lastHeadHash,
    backfillLimitBytes: cfg.backfillLimitBytes
  });
  if (delta.missing) {
    mutateStateExclusive(file, (s) => {
      bumpDrop(s, 'no_transcript');
    });
    return;
  }

  const rendered = renderDelta(delta.entries, {
    maxDeltaMessages: cfg.maxDeltaMessages,
    maxContextChars: cfg.maxContextChars,
    userChars: 4000,
    assistantChars: 4000,
    toolChars: 300,
    keepFirstUserMessage: true
  });

  if (rendered.count === 0) {
    // 没有可审的实质内容：推进指针（连同首部指纹），不发审查。
    // 有完整行却零解析产率 = 转录格式与解析器完全不合（v1 为完全静默，现留 parse_empty 信号）。
    if (delta.entries.length === 0 && delta.consumed > 0) {
      mutateStateExclusive(file, (s) => {
        s.byteOffset = delta.nextOffset;
        s.lastHeadHash = delta.headHash;
        bumpDrop(s, 'parse_empty');
      });
      return;
    }
    mutateStateExclusive(file, (s) => {
      s.byteOffset = delta.nextOffset;
      s.lastHeadHash = delta.headHash;
    });
    return;
  }

  const eff = effectiveApi(cfg, apiKeyInfo, current);
  const userContent = `以下是一轮对话增量（按时间顺序，可能被截断）。请按系统指令输出 JSON 判定。\n\n${rendered.text}`;

  // 健康信标（M1）：sync 路径无分发 worker，attempt 在审查发起前写。
  health.writeAttempt(health.resolveHealthDir(process.env), sessionId, {
    model: eff.model, effectiveModel: eff.model
  });
  const result = await reviewTurn(cfg, eff, userContent, mockAllowed(stateDir), { state: current });

  // 指针推进策略：只要完成了一次审查尝试就前进——失败同样前进（drop 即放弃，
  // 与 dsh-advisor 的有界积压一致，绝不反复重试拖住主循环）。
  const finish = (mutateFn) => {
    mutateStateExclusive(file, (s) => {
      s.byteOffset = delta.nextOffset;
      s.lastHeadHash = delta.headHash;
      mutateFn(s);
    });
  };

  if (result.error) {
    finish((s) => {
      s.reviews = (s.reviews || 0) + 1;
      accumulateUsage(s, result);
      applyReviewOutcome(s, result, eff, cfg);
      health.writeResult(health.resolveHealthDir(process.env), sessionId, {
        ok: false, reason: result.error, model: eff.model, effectiveModel: eff.model, reviews: s.reviews
      });
    });
    return;
  }

  const frame = result.frame;
  finish((s) => {
    s.reviews = (s.reviews || 0) + 1;
    accumulateUsage(s, result);
    applyReviewOutcome(s, result, eff, cfg);
    health.writeResult(health.resolveHealthDir(process.env), sessionId, {
      ok: true, model: eff.model,
      effectiveModel: result.usedFallback ? (result.fallbackModel || eff.model) : eff.model,
      reviews: s.reviews
    });
    // 恢复信号：告警发过的会话（healthNotifiedAt 非空）恢复后，下一次 UPS 喊一声"已恢复"
    if (s.healthNotifiedAt) s.healthRecoveryPending = true;
  });

  if (frame.severity === 'none') {
    mutateStateExclusive(file, (s) => {
      applyDeliveryToState(s, false, cfg);
    });
    return;
  }

  const decision = decideAction(frame, current, cfg);
  if (decision.deliver === 'none') {
    mutateStateExclusive(file, (s) => {
      applyDeliveryToState(s, false, cfg);
    });
    return;
  }

  const prefix = prefixFor(frame.severity, decision.deferred === true);

  if (decision.deliver === 'queue') {
    let queued = false;
    mutateStateExclusive(file, (s) => {
      const note = `${prefix} ${frame.note}`;
      queued = enqueueNote(s, note, cfg, (reason) => bumpDrop(s, reason));
      if (queued && decision.deferred === true) s.deferred = (s.deferred || 0) + 1;
      // 队列满被丢弃时不计入 steer/deferred（不设"幻影冷却"）。
      applyDeliveryToState(s, false, cfg);
      s.lastAction = queued ? `queued:${frame.severity}` : `dropped:${frame.severity}`;
      // 历史记录（issue #102 可见性）：入队即记，事件标注 queued/dropped
      appendHistory({
        event: queued ? 'queued' : 'dropped:queue_overflow',
        severity: frame.severity,
        note: frame.note,
        sessionId: s.sessionId,
        mode: 'sync'
      });
    });
    return;
  }

  // deliver === 'block'：立即经 Stop 续跑送达。
  const reason = `${prefix} ${frame.note}${ADVISORY_SUFFIX}`;
  if (process.env.ZCODE_ADVISOR_DRY_RUN === '1') {
    // 演练模式不产出意见，也不得虚增 steer 计数/冷却。
    mutateStateExclusive(file, (s) => {
      s.lastAction = `would-block:${frame.severity}`;
      applyDeliveryToState(s, false, cfg);
    });
    return;
  }
  // emit 前最后复查 enabled：审查期间用户执行 /advisor-off 的，不再强制续跑。
  const preEmit = loadState(file);
  if (!preEmit || preEmit.enabled === false) {
    mutateStateExclusive(file, (s) => {
      applyDeliveryToState(s, false, cfg);
      s.lastAction = `skipped_disabled:${frame.severity}`;
    });
    return;
  }
  // 先 emit 后记账：emit 后被杀只会导致下轮重复审查（指针未推进），丢失更糟。
  emit({ decision: 'block', reason });
  mutateStateExclusive(file, (s) => {
    applyDeliveryToState(s, true, cfg);
    s.lastAction = `blocked:${frame.severity}`;
  });
}

// —— async 后台审查进程 ——
async function handleReviewWorker(args) {
  const idx = args.indexOf('--state');
  const file = idx !== -1 ? args[idx + 1] : '';
  if (!file) return;

  // --transcript：Stop 侧把转录快照到持久目录后传来的路径。
  // ZCode 的原 transcript_path 是每轮临时快照（Stop 返回即删），
  // worker 延后读取必然 no_transcript——快照优先。
  const snapIdx = args.indexOf('--transcript');
  const transcriptOverride = snapIdx !== -1 ? args[snapIdx + 1] : '';

  const cfg = loadConfig(PLUGIN_ROOT, process.env);
  const apiKeyInfo = resolveApiKey(cfg, process.env);
  const myPid = String(process.pid);
  // 认领锁：把锁内容改写为自己的 pid，结束时只有锁仍是自己 pid 才清除。
  try {
    fs.writeFileSync(lockPathFor(file), myPid, 'utf8');
  } catch (_) {
    return; // 锁被并发处理，退出
  }

  try {
    const state = loadState(file);
    if (!state) return;

    const stateDir = path.dirname(file);

    if (!state.enabled) return;
    // 门禁按会话级生效值评估：全局 key 缺失但本会话已覆盖 key 时照常审查。
    const gateReasons = gateWithSession(cfg, apiKeyInfo, state).reasons;
    if (gateReasons.length > 0) {
      mutateStateExclusive(file, (s) => {
        s.disabledReason = gateReasons.join(',');
      });
      return;
    }
    state.disabledReason = '';

    // 快照模式：ZCode 每轮给 hook 的转录是**本轮完整快照**且每轮重写，
    // 因此用快照时从 0 全量读（byteOffset 是针对持续追加文件的指针，跨轮不适用）。
    // 代价：与上游 dsh-advisor 的"只审增量"不同，这里每轮审整轮——
    // 换取的是 no_transcript 完全消失（该取舍已在 README 局限节声明）。
    const usingSnapshot = Boolean(transcriptOverride);
    const delta = readDelta(transcriptOverride || state.transcriptPath,
      usingSnapshot ? 0 : state.byteOffset,
      // 快照模式也应用 backfillLimitBytes：超长会话（数 MB 转录）不应整文件载入内存；
      // 超出上限时 readDelta 从尾部回读并丢弃首个残行，语义与持续文件路径一致。
      usingSnapshot
        ? { backfillLimitBytes: cfg.backfillLimitBytes }
        : {
            expectedHeadHash: state.lastHeadHash,
            backfillLimitBytes: cfg.backfillLimitBytes
          });
    if (delta.missing) {
      mutateStateExclusive(file, (s) => {
        bumpDrop(s, 'no_transcript');
      });
      return;
    }

    const rendered = renderDelta(delta.entries, {
      maxDeltaMessages: cfg.maxDeltaMessages,
      maxContextChars: cfg.maxContextChars,
      userChars: 4000,
      assistantChars: 4000,
      toolChars: 300,
      keepFirstUserMessage: true
    });

    if (rendered.count === 0) {
      // 零解析产率（完整行存在但全部不可解析）时留下 parse_empty 信号，见 sync 同款注释。
      if (delta.entries.length === 0 && delta.consumed > 0) {
        mutateStateExclusive(file, (s) => {
          s.byteOffset = delta.nextOffset;
          s.lastHeadHash = delta.headHash;
          bumpDrop(s, 'parse_empty');
        });
        return;
      }
      mutateStateExclusive(file, (s) => {
        s.byteOffset = delta.nextOffset;
        s.lastHeadHash = delta.headHash;
      });
      return;
    }

    const eff = effectiveApi(cfg, apiKeyInfo, state);
    const userContent = `以下是一轮对话增量（按时间顺序，可能被截断）。请按系统指令输出 JSON 判定。\n\n${rendered.text}`;
    const result = await reviewTurn(cfg, eff, userContent, mockAllowed(stateDir), { state });

    // 最终落盘：短临界区内重读最新状态、只写自己拥有的字段——
    // 审查期间 UPS/ctl 的修改（清队列、off、model set）不会被旧快照覆盖。
    mutateStateExclusive(file, (s) => {
      if (!usingSnapshot) {
        // 持续文件路径（Claude Code 同构宿主）：正常推进增量指针
        s.byteOffset = delta.nextOffset;
        s.lastHeadHash = delta.headHash;
      }
      // 快照模式：不推进指针、不改 transcriptPath——每轮快照独立全量审。
      s.reviews = (s.reviews || 0) + 1;
      s.lastActivity = new Date().toISOString();
      accumulateUsage(s, result);
      applyReviewOutcome(s, result, eff, cfg);

      if (result.error) {
        // 健康信标（M1）：审查失败 → down；lastSuccessAt 不更新（保持上次成功时间）。
        health.writeResult(health.resolveHealthDir(process.env), s.sessionId, {
          ok: false, reason: result.error, model: eff.model, effectiveModel: eff.model,
          reviews: s.reviews
        });
        return;
      }

      // 健康信标（M1）：审查成功 → ok。降级成功也算 ok，但 effectiveModel 用实际干活的模型。
      health.writeResult(health.resolveHealthDir(process.env), s.sessionId, {
        ok: true, model: eff.model,
        effectiveModel: result.usedFallback ? (result.fallbackModel || eff.model) : eff.model,
        reviews: s.reviews
      });
      // 恢复信号：告警发过的会话（healthNotifiedAt 非空）恢复后，下一次 UPS 喊一声"已恢复"
      if (s.healthNotifiedAt) s.healthRecoveryPending = true;

      const frame = result.frame;
      if (frame.severity === 'none') {
        applyDeliveryToState(s, false, cfg);
        return;
      }

      const decision = decideActionAsync(frame, s, cfg);
      if (decision.deliver === 'none') {
        applyDeliveryToState(s, false, cfg);
        return;
      }

      const prefix = prefixFor(frame.severity, decision.deferred === true);
      const note = `${prefix} ${frame.note}`;
      const queued = enqueueNote(s, note, cfg, (reason) => bumpDrop(s, reason));
      if (queued) {
        if (decision.deferred === true) s.deferred = (s.deferred || 0) + 1;
        // 入队成功才计 steer/冷却；nit 不算 steer；冷却期内的 deferred concern 不算。
        applyDeliveryToState(s, frame.severity !== 'nit' && decision.deferred !== true, cfg);
        s.lastAction = `queued:${frame.severity}`;
      } else {
        s.lastAction = `dropped:${frame.severity}`;
      }
      // 历史记录（issue #102 可见性）：async 模式入队即记
      appendHistory({
        event: queued ? 'queued' : 'dropped:queue_overflow',
        severity: frame.severity,
        note: frame.note,
        sessionId: s.sessionId,
        mode: 'async'
      });
    });
  } catch (err) {
    // worker 内任何异常：留下计数痕迹（此前版本此处静默消失），尽力落盘。
    try {
      mutateStateExclusive(file, (s) => {
        bumpDrop(s, 'worker_error');
        s.lastAction = `worker_error:${String(err).slice(0, 80)}`;
      });
    } catch (_) {}
  } finally {
    clearLockIfOwner(file, myPid);
  }
}

// ---------------- ctl（供 /advisor-* 命令调用） ----------------

async function handleCtl(args) {
  const cfg = loadConfig(PLUGIN_ROOT, process.env);
  const sub = args[0] || 'status';
  const stateDir = resolveStateDir(cfg);

  if (sub === 'doctor') {
    return ctlDoctor(cfg, args);
  }

  const idxState = args.indexOf('--state');
  const explicit = idxState !== -1 && args[idxState + 1];
  let file;
  if (explicit) {
    file = path.resolve(args[idxState + 1]);
  } else {
    const all = listStatePaths(stateDir);
    if (all.length === 0) {
      process.stdout.write(`advisor: 未找到会话状态（插件尚未在任何会话中挂载）。\n状态目录：${stateDir}\n`);
      return;
    }
    // 多会话并存时按 mtime 猜测曾误伤其他会话：要求显式 --state，或显式 --latest 接受回退。
    if (all.length > 1 && !args.includes('--latest')) {
      process.stdout.write(`advisor: 状态目录下有 ${all.length} 个会话，为避免误伤其他会话请显式指定目标：\n  --state "<状态文件路径>"（推荐，见会话内 [advisor] 注册行）\n  或 --latest（明确接受"最近会话"回退）\n`);
      return;
    }
    file = latestStatePath(stateDir);
  }

  if (!file || !loadState(file)) {
    process.stdout.write(`advisor: 未找到会话状态（插件尚未在任何会话中挂载）。\n状态目录：${stateDir}\n`);
    return;
  }

  if (sub === 'status') {
    const state = loadState(file);
    const apiKeyInfo = resolveApiKey(cfg, process.env);
    const { eff, reasons: gateReasons } = gateWithSession(cfg, apiKeyInfo, state);
    const lines = [];
    lines.push('advisor 状态');
    lines.push(`  会话: ${state.sessionId || '(未知)'}`);
    lines.push(`  启用: ${state.enabled ? '是' : `否${state.disabledReason ? '（' + state.disabledReason + '）' : ''}`}`);
    if (state.enabled && gateReasons.length > 0) {
      lines.push(`  门禁: 未满足 → ${gateReasons.join(',')}（审查不会运行）`);
    }
    lines.push(`  模式: ${cfg.reviewMode}`);
    lines.push(`  模型: ${eff.model}（${eff.modelSource === 'session-override' ? '本会话覆盖' : '全局默认'}）`);
    lines.push(`  API 来源: ${cfg.apiSourceLabel || (cfg.apiSource === 'zcode' ? 'ZCode 已维护' : '手动维护')}`);
    // 会话级覆盖详情：哪些键被本会话覆盖、生效 key 的掩码（state 里的 key 不回显明文）
    if (eff.hasOverride) {
      lines.push(`  会话覆盖: ${eff.overrides.join(' + ')}（/advisor-api reset 恢复全局）`);
    }
    lines.push(`  端点: ${eff.baseUrl}`);
    lines.push(`  生效 key: ${eff.apiKey ? maskKey(eff.apiKey) : '（无）'}`);
    lines.push(`  审查次数: ${state.reviews || 0} | steer 记录: ${state.steers || 0}（sync=实际送达；async=入队数） | 冷却剩余: ${state.immuneTurns || 0} 轮`);
    lines.push(`  顺延队列: ${(state.pendingNotes || []).length} 条 | 历史顺延: ${state.deferred || 0}`);
    lines.push(`  Token 累计: 输入 ${state.tokensIn || 0} / 输出 ${state.tokensOut || 0}`);
    // 降级（M4）可见性：配了备用模型才展示；用 primaryFailStreak 说明"主模型是否在坏"。
    // 这是「不静默掩盖」在 status 侧的落点——即便降级在兜，用户也能看到主模型有问题。
    const fbModel = resolveFallbackModel(cfg, state);
    if (fbModel) {
      const pf = state.primaryFailStreak;
      const pfDesc = pf && pf.count
        ? `主模型连续失败 ${pf.count} 次（原因 ${pf.reason}）`
        : '主模型最近正常';
      const usages = state.fallbackUsed
        ? `已降级 ${state.fallbackUsed} 次${state.fallbackLastModel ? `（最近用 ${state.fallbackLastModel}）` : ''}`
        : '未降级过';
      const modeNote = cfg.reviewMode === 'sync' ? '（sync 模式不生效）' : '';
      lines.push(`  备用模型: ${fbModel}${modeNote} | ${usages} | ${pfDesc}`);
    }
    const drops = state.dropped || {};
    const dropLine = Object.entries(drops).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
    if (dropLine) lines.push(`  Dropped: ${dropLine}`);

    // KD-I3 可见性（对齐上游 v0.5.4）：展示"最后一次"发生时间，并给出可操作提示。
    // 目的：让"审查在跑但从不产出"可被发现——只看计数无法判断是陈旧积压还是正在发生。
    const droppedAt = state.droppedAt || {};
    const stampLine = Object.entries(droppedAt)
      .filter(([k]) => (drops[k] || 0) > 0)
      .map(([k, t]) => `${k}@${String(t).replace(/\.\d+Z$/, 'Z')}`)
      .join(' ');
    if (stampLine) lines.push(`  最近丢弃: ${stampLine}`);

    // 针对最常见两类给出修复提示（与上游 KD-I3 的 warn 口径一致）
    const hints = [];
    if ((drops.llm_empty_response || 0) > 0) {
      hints.push('llm_empty_response：模型把输出预算耗在思考上 → 提高 maxTokens（思考型模型建议 4096）');
    }
    if ((drops.unparsed || 0) > 0) {
      hints.push('unparsed：回复无合法 JSON 帧 → 确认 proseFallback: true，或换格式更稳定的模型');
    }
    if ((drops.parse_empty || 0) > 0) {
      hints.push('parse_empty：转录有完整行但全部无法解析 → 转录格式与预期不符，请带样例反馈');
    }
    if ((drops.llm_timeout || 0) > 0) {
      hints.push('llm_timeout：审查超时 → 提高 reviewTimeoutMs（配置面板或 /advisor-setup；sync 模式上限 300s）');
    }
    for (const h of hints) lines.push(`  提示: ${h}`);

    for (const p of cfg.problems || []) lines.push(`  配置问题: ${p}`);
    // 告警按会话生效端点评估：会话把端点覆盖成 http:// 或把官方 key 指到第三方时
    // 必须能告警出来；全局告警也不应误报到已被覆盖的配置上。
    for (const w of configWarnings({ baseUrl: eff.baseUrl }, eff)) lines.push(`  配置警告: ${w}`);
    if (state.lastAction) lines.push(`  最近动作: ${state.lastAction}`);
    lines.push(`  最后活动: ${state.lastActivity || '(无)'}`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (sub === 'on') {
    // 门禁在临界区内按重读后的状态重算：锁外用旧快照算好再写回，并发
    // /advisor-api set 改了 sessionApi 时会用过期结果覆盖 disabledReason。
    let reasons = [];
    let enabledModel = '';
    mutateStateExclusive(file, (s) => {
      s.enabled = true;
      const r = gateWithSession(cfg, resolveApiKey(cfg, process.env), s);
      reasons = r.reasons;
      enabledModel = r.eff.model;
      s.disabledReason = reasons.length > 0 ? reasons.join(',') : '';
    });
    if (reasons.length > 0) {
      process.stdout.write(`advisor: 已置为启用，但配置门禁未满足（${reasons.join(',')}），审查不会运行。请检查 advisor.config.json、环境变量，或用 /advisor-api set 为本会话单独配置。\n`);
    } else {
      process.stdout.write(`advisor: 本会话已启用（模式 ${cfg.reviewMode}，模型 ${enabledModel}）。\n`);
    }
    return;
  }

  if (sub === 'off') {
    mutateStateExclusive(file, (s) => {
      s.enabled = false;
    });
    process.stdout.write('advisor: 本会话已停用（不影响其他会话）。\n');
    return;
  }

  if (sub === 'model') {
    const action = args[1] || '';
    if (action === 'set') {
      const model = args[2];
      if (!model) {
        process.stdout.write('advisor: 用法 model set <model-id>\n');
        return;
      }
      mutateStateExclusive(file, (s) => {
        s.sessionModel = model;
      });
      process.stdout.write(`advisor: 本会话审查模型已固定为 ${model}（下一轮审查起生效；若模型无效，将在 Dropped:llm_http_4xx 中体现）。全局默认仍是 ${cfg.model}。\n`);
      return;
    }
    if (action === 'reset') {
      mutateStateExclusive(file, (s) => {
        s.sessionModel = '';
      });
      process.stdout.write(`advisor: 已清除本会话覆盖，回到全局默认 ${cfg.model}。\n`);
      return;
    }
    const state = loadState(file);
    const eff = effectiveModel(cfg, state);
    process.stdout.write(`advisor: 当前审查模型 ${eff.model}（${eff.source === 'session-override' ? '本会话覆盖' : '全局默认'}）。修改：model set <model-id> | model reset\n`);
    return;
  }

  // 会话级 API 覆盖：set <baseUrl> <apiKey> [model:<id>]（键顺序可换，model: 前缀标识模型；
  // 两值缺省写 - 表示保留该项）| show | reset。key 只落 state 文件（0600），状态行只回显掩码。
  if (sub === 'api') {
    const action = args[1] || 'show';
    if (action === 'set') {
      const rest = args.slice(2).filter(Boolean);
      if (rest.length === 0) {
        process.stdout.write('advisor: 用法 api set <baseUrl|-> <apiKey|-> [model:<model-id>] [fallback:<model-id>]；- 表示保留该项现状\n');
        return;
      }
      let baseUrl = '';
      let apiKey = '';
      let model = '';
      let fallback = '';
      for (const tok of rest) {
        if (/^model:/i.test(tok)) model = tok.slice(6).trim();
        else if (/^fallback:/i.test(tok)) fallback = tok.slice(9).trim();
        else if (!baseUrl) baseUrl = tok.trim();
        else if (!apiKey) apiKey = tok.trim();
      }
      if (baseUrl === '-' || baseUrl === 'keep') baseUrl = '';
      if (apiKey === '-' || apiKey === 'keep') apiKey = '';
      if (!baseUrl && !apiKey && !model && !fallback) {
        process.stdout.write('advisor: 未提供任何要设置的值（- 表示保留现状）。\n');
        return;
      }
      // 归一化端点路径（与 reviewer.js 的 normalizeChatEndpoint 同规则）：填 /v1 基地址也能直接用
      const trimmed = baseUrl.replace(/\/+$/, '');
      const normalized = trimmed && !/\/chat\/completions$/i.test(trimmed) && !/\/messages$/i.test(trimmed)
        ? `${trimmed}/chat/completions`
        : trimmed;
      mutateStateExclusive(file, (s) => {
        if (!s.sessionApi || typeof s.sessionApi !== 'object') s.sessionApi = { baseUrl: '', apiKey: '', model: '' };
        if (normalized) s.sessionApi.baseUrl = normalized;
        if (apiKey) s.sessionApi.apiKey = apiKey;
        if (model) s.sessionModel = model; // 模型覆盖复用既有 sessionModel 通道
        // 会话级备用模型（M4）：独立字段，不放进 sessionApi（后者是"端点/key 覆盖"语义，
        // 且 fallbackEligibility 用它判断"是否覆盖了端点"）。
        if (fallback) s.sessionFallbackModel = fallback;
      });
      const parts = [];
      if (normalized) parts.push(`端点=${normalized}`);
      if (apiKey) parts.push(`key=${maskKey(apiKey)}`);
      if (model) parts.push(`模型=${model}`);
      if (fallback) parts.push(`备用模型=${fallback}`);
      // 占位符照单全收会让"回显成功"与"实际不生效"分叉：effectiveApi 会把
      // test-*/your-api-key 一类值过滤回落全局 key，这里必须当场点破。
      const placeholderHint = apiKey && isPlaceholderKey(apiKey)
        ? `。注意：该 key 形似占位符，审查时会回落全局 key（与 resolveApiKey 同一纪律）`
        : '';
      process.stdout.write(`advisor: 本会话已覆盖 ${parts.join('，')}（下一轮审查起生效；/advisor-api reset 恢复全局）${placeholderHint}。\n`);
      return;
    }
    if (action === 'reset') {
      mutateStateExclusive(file, (s) => {
        s.sessionApi = { baseUrl: '', apiKey: '', model: '' };
      });
      process.stdout.write('advisor: 已清除本会话的端点/key 覆盖，恢复跟随全局配置（模型覆盖用 /advisor-model reset 单独清除）。\n');
      return;
    }
    const state = loadState(file);
    const eff = effectiveApi(cfg, resolveApiKey(cfg, process.env), state);
    if (!eff.hasOverride) {
      process.stdout.write(`advisor: 本会话未覆盖端点/key，跟随全局配置（端点 ${cfg.baseUrl}，key ${eff.apiKey ? maskKey(eff.apiKey) : '（无）'}）。修改：api set <baseUrl|-> <apiKey|-> [model:<id>] | reset\n`);
      return;
    }
    process.stdout.write(`advisor: 本会话覆盖：${eff.overrides.join(' + ')}。生效端点 ${eff.baseUrl}，key ${eff.apiKey ? maskKey(eff.apiKey) : '（无）'}。修改：api set … | reset\n`);
    return;
  }

  process.stdout.write(`advisor: 未知子命令 ${sub}。可用：status | on | off | model [set <id>|reset] | api [set <baseUrl|-> <apiKey|-> [model:<id>]|show|reset] | doctor [--probe [--n 5]] [--ping] [--model <id>]\n`);
}

// 体检：展示配置解析链、key 来源（脱敏）、门禁与警告；--ping 用 max_tokens=1 的
// 最小请求实测端点/认证/模型可用性，便于 /advisor-setup 完成后即时验证。
async function ctlDoctor(cfg, args) {
  const apiKeyInfo = resolveApiKey(cfg, process.env);
  const lines = [];
  lines.push('advisor 体检');
  lines.push(`  配置来源: ${(cfg.configSources && cfg.configSources.length) ? cfg.configSources.join(' → ') : '(全部内置默认)'}`);
  lines.push(`  用户级配置: ${fs.existsSync(userConfigPath()) ? userConfigPath() : '不存在（/advisor-setup 可创建，跨升级保留）'}`);
  lines.push(`  API 来源: ${cfg.apiSourceLabel || (cfg.apiSource === 'zcode' ? 'ZCode 已维护' : '手动维护')}`);
  lines.push(`  端点: ${cfg.baseUrl}`);
  lines.push(`  模式: ${cfg.reviewMode} | 预算: maxTokens=${cfg.maxTokens}, 审查超时=${cfg.reviewTimeoutMs}ms`);
  const gateReasons = gate(cfg, apiKeyInfo);
  lines.push(`  门禁: ${gateReasons.length > 0 ? '未满足 → ' + gateReasons.join(',') : '满足'} | key 来源: ${apiKeyInfo.source || '(无)'}${apiKeyInfo.key ? `（${maskKey(apiKeyInfo.key)}）` : ''}`);
  for (const p of cfg.problems || []) lines.push(`  配置问题: ${p}`);
  for (const w of configWarnings(cfg, apiKeyInfo)) lines.push(`  配置警告: ${w}`);
  process.stdout.write(lines.join('\n') + '\n');

  if (!args.includes('--ping') && !args.includes('--probe')) return;

  const idxModel = args.indexOf('--model');
  const model = idxModel !== -1 && args[idxModel + 1] ? args[idxModel + 1] : cfg.model;
  if (gateReasons.length > 0) {
    process.stdout.write(`  Ping: 跳过（门禁未满足：${gateReasons.join(',')}）\n`);
    return;
  }

  // —— 能力探针（M3，推荐）——
  // 用**生产参数**（真实 maxTokens + 系统提示 + 代表性 delta）跑 N 次，
  // 输出通过率与耗时分布。修掉旧 ping 的误报：旧 ping 用 max_tokens=1，
  // 思考型模型会把它全烧在 reasoning 上（content 空、finish=length），
  // 而旧 ping 把 llm_empty_response 当正常 → 对「烧预算故障」判 OK（本次故障的误报源）。
  if (args.includes('--probe')) {
    const idxN = args.indexOf('--n');
    const n = idxN !== -1 && args[idxN + 1] ? Math.max(1, Math.min(50, parseInt(args[idxN + 1], 10) || 5)) : 5;
    const idxTo = args.indexOf('--timeout');
    const timeoutMs = idxTo !== -1 && args[idxTo + 1] ? Math.max(1000, parseInt(args[idxTo + 1], 10) || cfg.reviewTimeoutMs) : cfg.reviewTimeoutMs;
    if (model !== cfg.model) process.stdout.write(`  探针: 目标模型 ${model}（非配置模型）\n`);
    process.stdout.write(`  探针: 正在用生产参数测试 ${model} ×${n} …\n`);
    const stat = await probeModel(
      { baseUrl: cfg.baseUrl, model, apiKey: apiKeyInfo.key },
      {
        n,
        timeoutMs,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        maxNoteChars: cfg.maxNoteChars,
        proseFallback: cfg.proseFallback,
        systemPrompt: cfg.systemPrompt && cfg.systemPrompt.trim() ? cfg.systemPrompt : DEFAULT_SYSTEM_PROMPT
      }
    );
    process.stdout.write(renderProbeReport(stat) + '\n');
    return;
  }

  process.stdout.write(`  Ping: 正在测试 ${model} …\n`);
  const t0 = Date.now();
  const res = await callReviewer({
    baseUrl: cfg.baseUrl,
    model,
    apiKey: apiKeyInfo.key,
    systemPrompt: 'You are a health check.',
    userContent: 'ping',
    maxTokens: 1,
    temperature: 0,
    timeoutMs: 20000
  });
  if (!res.error || res.error === 'llm_empty_response') {
    process.stdout.write(`  Ping: OK（${Date.now() - t0}ms — 端点可达、认证与模型有效${res.error === 'llm_empty_response' ? '；响应体为空是 max_tokens=1 下的正常现象' : ''}）\n`);
  } else {
    process.stdout.write(`  Ping: 失败 → ${res.error}${res.detail ? `：${res.detail}` : ''}\n`);
  }
}

// ---------------- 入口 ----------------

async function main() {
  const argv = process.argv.slice(2);
  const event = argv[0] || '';

  if (event === 'ctl') {
    return handleCtl(argv.slice(1));
  }

  if (event === 'review-worker') {
    return handleReviewWorker(argv.slice(1));
  }

  const input = readStdinJson();
  const cfg = loadConfig(PLUGIN_ROOT, process.env);
  const apiKeyInfo = resolveApiKey(cfg, process.env);
  const stateDir = resolveStateDir(cfg);
  const sessionId = input.session_id || input.sessionId
    || (input.transcript_path ? `t-${hashId(input.transcript_path)}` : 'default');
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const ctx = { stateDir, sessionId, transcriptPath, cfg, apiKeyInfo, input };

  if (event === 'session-start') return onSessionStart(ctx);
  if (event === 'user-prompt-submit') return onUserPromptSubmit(ctx);
  if (event === 'stop') return onStop(ctx);
  // 未知事件：安静退出。
}

// 宿主以 `node advisor-hook.js <event>` 直接执行本文件（require.main === module 成立）；
// 守卫只是让测试可以 require 本模块（否则会挂死在读 stdin）。CLI 行为不变。
if (require.main === module) {
  main().catch((err) => {
    // 绝不因 advisor 的错误影响主会话：吞掉一切异常，空输出、exit 0。
    // ZCODE_ADVISOR_DEBUG=1 时把栈写到 stderr（hook 运行记录会捕获错误流），便于排查。
    try {
      if (process.env.ZCODE_ADVISOR_DEBUG === '1') {
        process.stderr.write(`[advisor] hook error: ${err && err.stack ? err.stack : String(err)}\n`);
      }
    } catch (_) {}
    process.exitCode = 0;
  });
}

// 仅供测试导出（test/log-review.test.js）；生产调用方全部走 CLI 入口。
module.exports = { reviewTurn, logReview, reviewBudgetMs, fallbackEligibility, fallbackReserveMs, resolveFallbackModel, applyReviewOutcome, degradeAlertLine, FALLBACK_TRIGGER_REASONS };
