'use strict';

// 健康信标（out-of-band 可见性，M1）。
//
// 目的：让「顾问是否在正常运行」对**用户**可见。此前所有输出（意见、健康告警）
// 都只走 additionalContext——那是单向喂给**主模型**的通道，用户看不到（M0 实测确认）。
// 本模块是唯一面向用户的健康数据源：hook 侧写信标，companion（controller + 角标）读信标着色。
//
// 设计要点：
// - **双时间戳**：`lastAttemptAt`（Stop 父进程在 spawn 前写）与 `lastSuccessAt`（worker 完成时写）。
//   单时间戳无法区分「审查没跑」与「跑了没结果」——worker 被强杀时只更新前者，据此可判 down。
// - **按会话分文件**：多会话并存时避免互相覆盖；读取侧取「最近活动」的那一个并标注 sessionId。
// - **原子写**：tmp + rename，防读到半截 JSON；目录 0700 / 文件 0600（含会话 id 与模型名）。
// - **绝不抛错**：信标是辅助功能，任何失败只静默返回，绝不影响主流程（与 history 同纪律）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 与 history.js / state.js 同一套隔离约定：测试与多 profile 用 ZCODE_ADVISOR_STATE_DIR，
// 否则退回用户主目录下的 .zcode。
function resolveHealthDir(env) {
  const e = env || process.env;
  if (e.ZCODE_ADVISOR_HEALTH_DIR) return e.ZCODE_ADVISOR_HEALTH_DIR;
  if (e.ZCODE_ADVISOR_STATE_DIR) return e.ZCODE_ADVISOR_STATE_DIR;
  return path.join(os.homedir(), '.zcode');
}

function sanitizeId(sessionId) {
  const s = String(sessionId || '').trim();
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return cleaned || 'default';
}

function beaconPath(dir, sessionId) {
  return path.join(dir, `advisor-health-${sanitizeId(sessionId)}.json`);
}

function readBeaconFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 读取 + 合并写：信标是「同一会话多字段分次写」，不能整覆盖——Stop 写 attempt 后
// worker 再写 result，若 result 用整对象覆盖会丢掉 attempt（反之亦然）。
// rename 在 Windows 上可能被索引器/杀毒临时占用（EPERM），故做有限重试（与 state.js 同策略）；
// 写 tmp 失败时 unlink 残留 tmp，避免反复失败累积垃圾文件。
function mergeBeacon(file, patch) {
  const dir = path.dirname(file);
  try {
    // 目录存在则跳过 mkdir（热路径：每次写都 mkdir 无谓损耗）；不存在再建并补 0700。
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try { fs.chmodSync(dir, 0o700); } catch (_) {} // 历史目录可能是 0755，补正（文件名含会话 id）
    }
    const prev = readBeaconFile(file) || {};
    const next = Object.assign({}, prev, patch);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try { fs.renameSync(tmp, file); lastErr = null; break; } catch (e) {
        lastErr = e;
        // 忙等退避：Atomic 的 sleepSync 优先，退回同步自旋（不与主流程引入异步）
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch (_) {}
      }
    }
    if (lastErr) { try { fs.unlinkSync(tmp); } catch (_) {} return null; }
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    return next;
  } catch (_) {
    return null;
  }
}

// Stop 父进程在 spawn worker 前调用：记录「本轮尝试了审查」。
function writeAttempt(dir, sessionId, info) {
  const i = info || {};
  return mergeBeacon(beaconPath(dir, sessionId), {
    sessionId: String(sessionId || ''),
    lastAttemptAt: new Date().toISOString(),
    model: String(i.model || ''),
    effectiveModel: String(i.effectiveModel || i.model || '')
  });
}

// worker 完成审查时调用：记录结果。成功写 lastSuccessAt；失败只更新 state/reason
// （lastSuccessAt 保持上一次成功时间——「有尝试无成功」正是 down 的判据）。
// degraded（黄）：审查靠备用模型完成——服务未中断，但主模型在劣化。它**优先于 ok**：
// 调用方可能同时传 ok:true（本次确有产出）与 degraded:true（非主模型产出），
// 此时角标必须显示黄（降级可见），不能因 ok 而显示绿（那会把持续劣化藏起来）。
function writeResult(dir, sessionId, result) {
  const r = result || {};
  const patch = {
    sessionId: String(sessionId || ''),
    state: r.degraded ? 'degraded' : (r.ok ? 'ok' : 'down'),
    reason: String(r.reason || ''),
    model: String(r.model || ''),
    effectiveModel: String(r.effectiveModel || r.model || '')
  };
  if (Number.isFinite(r.reviews)) patch.reviews = r.reviews;
  if (r.ok) patch.lastSuccessAt = new Date().toISOString();
  return mergeBeacon(beaconPath(dir, sessionId), patch);
}

// 读目录下全部信标（新的在前）。任何失败返回 []。
// 上限 maxRead=50：读取侧只关心「最近活动」，没必要把上千个历史信标全解析。
function readBeacons(dir, maxRead) {
  const cap = Number.isFinite(maxRead) && maxRead > 0 ? maxRead : 50;
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^advisor-health-.*\.json$/.test(f))
      .map((f) => path.join(dir, f));
    // 先按 mtime 预筛，避免对全部文件做同步读+解析（历史信标无界增长时这是热路径）
    const withMtime = files.map((f) => {
      let mtime = 0;
      try { mtime = fs.statSync(f).mtimeMs; } catch (_) {}
      return { f, mtime };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, cap);
    const out = [];
    for (const { f } of withMtime) {
      const b = readBeaconFile(f);
      if (b && typeof b === 'object') out.push(b);
    }
    out.sort((a, b) => (Date.parse(b.lastAttemptAt || 0) || 0) - (Date.parse(a.lastAttemptAt || 0) || 0));
    return out;
  } catch (_) {
    return [];
  }
}

// 信标回收：信标按会话分文件、只增不减，长期使用会在 ~/.zcode 累积成千上万个，
// 拖慢读取侧（每 5s 全目录扫描）。与 state 同纪律：超龄删除 + 只留最近 keep 个。
function pruneBeacons(dir, maxAgeDays, keep) {
  const limitAge = (maxAgeDays || 7) * 24 * 3600 * 1000;
  const limitKeep = keep || 50;
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((f) => /^advisor-health-.*\.json$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { full, mtime };
      });
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (now - e.mtime > limitAge) {
      try { fs.unlinkSync(e.full); } catch (_) {}
    }
  }
  const kept = entries.filter((e) => fs.existsSync(e.full)).sort((a, b) => b.mtime - a.mtime);
  for (const e of kept.slice(limitKeep)) {
    try { fs.unlinkSync(e.full); } catch (_) {}
  }
}

// 陈旧阈值：一个正常运行的慢审查最坏生命周期 = reviewBudgetMs，取 2× 与 10 分钟的下界，
// 避免把「正在跑的慢审查」误判为陈旧。
function staleThresholdMs(reviewBudgetMs) {
  const b = Number.isFinite(reviewBudgetMs) && reviewBudgetMs > 0 ? reviewBudgetMs : 480000;
  return Math.max(600000, b * 2);
}

// 由信标派生健康态。**绝不把「无数据/陈旧」当成 ok**——指示器失效时显示未知，
// 否则用户会把「指示器死了」误读为「顾问健康」。
// 返回 'ok' | 'degraded' | 'down' | 'unknown'。
function deriveHealth(beacon, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : staleThresholdMs(o.reviewBudgetMs);
  if (!beacon || typeof beacon !== 'object') return 'unknown';

  const attempt = Date.parse(beacon.lastAttemptAt || '') || 0;
  const success = Date.parse(beacon.lastSuccessAt || '') || 0;
  if (!attempt) return 'unknown'; // 从未跑过审查 → 未知（不是 ok）
  if (now - attempt > staleMs) return 'unknown'; // 陈旧 → 未知

  // 有尝试且在近 STALE 内：看最近成功是否新鲜
  const successFresh = success > 0 && (now - success) <= staleMs;
  if (successFresh && beacon.state === 'ok') return 'ok';
  if (beacon.state === 'degraded') return 'degraded';
  // 有尝试、无新鲜成功 → down（含 worker 崩溃：attempt 更新、success 停留）
  return 'down';
}

module.exports = {
  resolveHealthDir, beaconPath, writeAttempt, writeResult,
  readBeacons, deriveHealth, staleThresholdMs, pruneBeacons
};
