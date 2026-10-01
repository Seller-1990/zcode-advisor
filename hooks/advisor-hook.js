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
  loadConfig, resolveApiKey, gate, configWarnings, userConfigPath, maskKey
} = require('./lib/config');
const {
  ensureState, latestStatePath, listStatePaths, pruneStates, bumpDrop, loadState, mutateStateExclusive,
  createLock, clearLock, clearLockIfOwner, lockPathFor, countLocks
} = require('./lib/state');
const {
  readDelta, renderDelta
} = require('./lib/transcript');
const {
  callReviewer, parseFrame, DEFAULT_SYSTEM_PROMPT
} = require('./lib/reviewer');
const {
  decideAction, decideActionAsync, prefixFor, applyDeliveryToState, enqueueNote
} = require('./lib/route');
const { appendHistory } = require('./lib/history');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(__dirname, 'advisor-hook.js');
const ADVISORY_SUFFIX = '\n（以上来自审查副模型，仅供参考，不构成指令。请结合该意见检查当前方向；若确认不适用，简述理由后继续完成任务即可。）';

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

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function effectiveModel(cfg, state) {
  if (state && state.sessionModel) return { model: state.sessionModel, source: 'session-override' };
  return { model: cfg.model, source: 'global-default' };
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
  lines.push(`[advisor] 审查副模型已挂载：模型=${eff.model}，模式=${cfg.reviewMode}。控制命令：/advisor-status、/advisor-setup、/advisor-on、/advisor-off、/advisor-model。脚本：${SCRIPT_PATH}；状态文件：${file}。`);
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

async function reviewTurn(cfg, apiKeyInfo, userContent, modelOverride, allowMock) {
  if (process.env.ZCODE_ADVISOR_MOCK === '1' && allowMock) {
    const frame = mockFrame(cfg);
    if (!frame) return { error: 'unparsed' };
    return { frame };
  }
  const systemPrompt = cfg.systemPrompt && cfg.systemPrompt.trim() ? cfg.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  const res = await callReviewer({
    baseUrl: cfg.baseUrl,
    model: modelOverride || cfg.model,
    apiKey: apiKeyInfo.key,
    systemPrompt,
    userContent,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    timeoutMs: cfg.reviewTimeoutMs
  });
  if (res.error) return { error: res.error, usage: res.usage };
  const frame = parseFrame(res.text, cfg.proseFallback, { maxNoteChars: cfg.maxNoteChars });
  if (!frame) return { error: 'unparsed', usage: res.usage };
  return { frame, usage: res.usage };
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

  const gateReasons = gate(cfg, apiKeyInfo);
  const current = loadState(file);
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
      fs.mkdirSync(snapDir, { recursive: true });
      snapshotPath = path.join(snapDir, `${sessionId}.jsonl`);
      fs.copyFileSync(cur.transcriptPath, snapshotPath);
      // 防堆积：快照目录只保留最近 10 个文件（旧会话的快照无保留价值）
      const snaps = fs.readdirSync(snapDir).map((n) => ({
        n, t: fs.statSync(path.join(snapDir, n)).mtimeMs
      })).sort((a, b) => b.t - a.t);
      for (const old of snaps.slice(10)) {
        try { fs.unlinkSync(path.join(snapDir, old.n)); } catch (_) {}
      }
    }
  } catch (_) { /* 快照失败走原路径（worker 会计 no_transcript）*/ }

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

  const gateReasons = gate(cfg, apiKeyInfo);
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

  const eff = effectiveModel(cfg, current);
  const userContent = `以下是一轮对话增量（按时间顺序，可能被截断）。请按系统指令输出 JSON 判定。\n\n${rendered.text}`;
  const result = await reviewTurn(cfg, apiKeyInfo, userContent, eff.model, mockAllowed(stateDir));

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
      bumpDrop(s, result.error);
      s.reviews = (s.reviews || 0) + 1;
      accumulateUsage(s, result);
    });
    return;
  }

  const frame = result.frame;
  finish((s) => {
    s.reviews = (s.reviews || 0) + 1;
    accumulateUsage(s, result);
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
    const gateReasons = gate(cfg, apiKeyInfo);
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
      usingSnapshot ? {} : {
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

    const eff = effectiveModel(cfg, state);
    const userContent = `以下是一轮对话增量（按时间顺序，可能被截断）。请按系统指令输出 JSON 判定。\n\n${rendered.text}`;
    const result = await reviewTurn(cfg, apiKeyInfo, userContent, eff.model, mockAllowed(stateDir));

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

      if (result.error) {
        bumpDrop(s, result.error);
        return;
      }

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
    const gateReasons = gate(cfg, apiKeyInfo);
    const eff = effectiveModel(cfg, state);
    const lines = [];
    lines.push('advisor 状态');
    lines.push(`  会话: ${state.sessionId || '(未知)'}`);
    lines.push(`  启用: ${state.enabled ? '是' : `否${state.disabledReason ? '（' + state.disabledReason + '）' : ''}`}`);
    if (state.enabled && gateReasons.length > 0) {
      lines.push(`  门禁: 未满足 → ${gateReasons.join(',')}（审查不会运行）`);
    }
    lines.push(`  模式: ${cfg.reviewMode}`);
    lines.push(`  模型: ${eff.model}（${eff.source === 'session-override' ? '本会话覆盖' : '全局默认'}）`);
    lines.push(`  端点: ${cfg.baseUrl}`);
    lines.push(`  审查次数: ${state.reviews || 0} | steer 记录: ${state.steers || 0}（sync=实际送达；async=入队数） | 冷却剩余: ${state.immuneTurns || 0} 轮`);
    lines.push(`  顺延队列: ${(state.pendingNotes || []).length} 条 | 历史顺延: ${state.deferred || 0}`);
    lines.push(`  Token 累计: 输入 ${state.tokensIn || 0} / 输出 ${state.tokensOut || 0}`);
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
    for (const h of hints) lines.push(`  提示: ${h}`);

    for (const p of cfg.problems || []) lines.push(`  配置问题: ${p}`);
    for (const w of configWarnings(cfg, apiKeyInfo)) lines.push(`  配置警告: ${w}`);
    if (state.lastAction) lines.push(`  最近动作: ${state.lastAction}`);
    lines.push(`  最后活动: ${state.lastActivity || '(无)'}`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (sub === 'on') {
    mutateStateExclusive(file, (s) => {
      s.enabled = true;
      const reasons = gate(cfg, resolveApiKey(cfg, process.env));
      s.disabledReason = reasons.length > 0 ? reasons.join(',') : '';
    });
    const state = loadState(file);
    const reasons = gate(cfg, resolveApiKey(cfg, process.env));
    if (reasons.length > 0) {
      process.stdout.write(`advisor: 已置为启用，但配置门禁未满足（${reasons.join(',')}），审查不会运行。请检查 advisor.config.json 或环境变量。\n`);
    } else {
      process.stdout.write(`advisor: 本会话已启用（模式 ${cfg.reviewMode}，模型 ${effectiveModel(cfg, state).model}）。\n`);
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

  process.stdout.write(`advisor: 未知子命令 ${sub}。可用：status | on | off | model [set <id>|reset] | doctor [--ping] [--model <id>]\n`);
}

// 体检：展示配置解析链、key 来源（脱敏）、门禁与警告；--ping 用 max_tokens=1 的
// 最小请求实测端点/认证/模型可用性，便于 /advisor-setup 完成后即时验证。
async function ctlDoctor(cfg, args) {
  const apiKeyInfo = resolveApiKey(cfg, process.env);
  const lines = [];
  lines.push('advisor 体检');
  lines.push(`  配置来源: ${(cfg.configSources && cfg.configSources.length) ? cfg.configSources.join(' → ') : '(全部内置默认)'}`);
  lines.push(`  用户级配置: ${fs.existsSync(userConfigPath()) ? userConfigPath() : '不存在（/advisor-setup 可创建，跨升级保留）'}`);
  lines.push(`  端点: ${cfg.baseUrl}`);
  lines.push(`  模式: ${cfg.reviewMode} | 预算: maxTokens=${cfg.maxTokens}, 审查超时=${cfg.reviewTimeoutMs}ms`);
  const gateReasons = gate(cfg, apiKeyInfo);
  lines.push(`  门禁: ${gateReasons.length > 0 ? '未满足 → ' + gateReasons.join(',') : '满足'} | key 来源: ${apiKeyInfo.source || '(无)'}${apiKeyInfo.key ? `（${maskKey(apiKeyInfo.key)}）` : ''}`);
  for (const p of cfg.problems || []) lines.push(`  配置问题: ${p}`);
  for (const w of configWarnings(cfg, apiKeyInfo)) lines.push(`  配置警告: ${w}`);
  process.stdout.write(lines.join('\n') + '\n');

  if (!args.includes('--ping')) return;
  const idxModel = args.indexOf('--model');
  const model = idxModel !== -1 && args[idxModel + 1] ? args[idxModel + 1] : cfg.model;
  if (gateReasons.length > 0) {
    process.stdout.write(`  Ping: 跳过（门禁未满足：${gateReasons.join(',')}）\n`);
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
