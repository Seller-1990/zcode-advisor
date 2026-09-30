'use strict';

// 严重级路由（纯函数，便于单测）。语义与 dsh-advisor 对齐：
// - nit        → 顺延队列，下一条用户消息提交时以 additionalContext 送达（不唤醒主模型）。
// - concern    → sync：立即经 Stop block 送达（受 immuneTurns 冷却约束）；async：入队顺延，
//                冷却期内标记 deferred。
// - blocker    → 立即送达（不受冷却约束——继续明显在浪费工作；async 下为入队顺延）。
// - 同一轮内已连续 steer 达 maxBlocksPerTurn → 一律降级为顺延（纵深防御；
//   正常流程下 stop_hook_active 跳过续跑轮，此上限通常不会触达）。
function decideAction(frame, state, cfg) {
  const severity = frame.severity;
  if (severity === 'none') return { deliver: 'none' };

  const overSteerLimit = (state.consecutiveSteers || 0) >= (cfg.maxBlocksPerTurn || 2);
  const inCooldown = (state.immuneTurns || 0) > 0;

  if (severity === 'nit') return { deliver: 'queue' };

  if (severity === 'concern') {
    if (overSteerLimit || inCooldown) return { deliver: 'queue', deferred: true };
    return { deliver: 'block' };
  }

  if (severity === 'blocker') {
    if (overSteerLimit) return { deliver: 'queue', deferred: true };
    return { deliver: 'block' };
  }

  return { deliver: 'none' };
}

// 异步模式的路由（review-worker 内使用）：没有"立即 block"通道，
// 全部落入顺延队列、下一条用户消息提交时送达。concern 在冷却期内标记 deferred；
// blocker 不受冷却约束。
// 冷却语义（与 sync 的差异如实声明）：sync 在 block 真正发出时进入冷却；
// async 在"入队成功"时进入冷却——入队后若会话终止未送达，冷却已消耗，
// 这是无投递回执下的近似。deferred（冷却期内的 concern）不算送达、不进冷却。
function decideActionAsync(frame, state, cfg) {
  const severity = frame.severity;
  if (severity === 'none') return { deliver: 'none' };

  if (severity === 'nit') return { deliver: 'queue', deferred: false };
  if (severity === 'concern') {
    const inCooldown = (state.immuneTurns || 0) > 0;
    return { deliver: 'queue', deferred: inCooldown };
  }
  if (severity === 'blocker') return { deliver: 'queue', deferred: false };
  return { deliver: 'none' };
}

function prefixFor(severity, deferred) {
  return deferred ? `[advisor:${severity}:deferred]` : `[advisor:${severity}]`;
}

// 送达后的状态推进：steer 设冷却，普通审查按轮递减冷却。
function applyDeliveryToState(state, delivered, cfg) {
  if (delivered) {
    state.immuneTurns = Math.max(0, cfg.immuneTurns || 0);
    state.consecutiveSteers = (state.consecutiveSteers || 0) + 1;
    state.steers = (state.steers || 0) + 1;
  } else {
    state.immuneTurns = Math.max(0, (state.immuneTurns || 0) - 1);
  }
}

// 顺延入队。返回 false 表示队列已满被丢弃（调用方不得将其计为 steer/deferred）。
function enqueueNote(state, note, cfg, bumpDrop) {
  state.pendingNotes = Array.isArray(state.pendingNotes) ? state.pendingNotes : [];
  if (state.pendingNotes.length >= (cfg.pendingNotesCap || 5)) {
    if (typeof bumpDrop === 'function') bumpDrop('queue_overflow');
    return false;
  }
  state.pendingNotes.push(note);
  return true;
}

module.exports = { decideAction, decideActionAsync, prefixFor, applyDeliveryToState, enqueueNote };
