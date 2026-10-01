'use strict';

const fs = require('fs');
const path = require('path');

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 忙等兜底（极老 Node 才会走到） */ }
  }
}

function sanitizeSessionId(sessionId) {
  const s = String(sessionId || '').trim();
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return cleaned || 'default';
}

function stateFilePath(stateDir, sessionId) {
  return path.join(stateDir, `sess-${sanitizeSessionId(sessionId)}.json`);
}

function freshState(sessionId, transcriptPath, startEnabled) {
  return {
    schema: 1,
    sessionId: String(sessionId || ''),
    transcriptPath: String(transcriptPath || ''),
    enabled: startEnabled !== false,
    disabledReason: '',
    pendingRegistration: true,
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
    tokensIn: 0,
    tokensOut: 0,
    sessionModel: '',
    lastAction: '',
    lastActivity: '',
    createdAt: new Date().toISOString()
  };
}

// 找不到就创建（幂等）。所有调用方都必须拿到一个可用 state，保证流程可继续。
function ensureState(stateDir, sessionId, transcriptPath, startEnabled) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = stateFilePath(stateDir, sessionId);
  if (fs.existsSync(file)) {
    const current = loadStateDetailed(file);
    if (current.status === 'ok') {
      const state = current.state;
      if (transcriptPath && state.transcriptPath !== transcriptPath) {
        // resume/compact 后宿主会换新的临时转录文件，旧 offset 不再有意义。
        // 必须落盘（临界区内），否则后续 loadState 读到的仍是旧路径/旧 offset。
        const updated = mutateStateExclusive(file, (s) => {
          s.transcriptPath = transcriptPath;
          s.byteOffset = 0;
          s.lastHeadHash = '';
        });
        return { state: updated || state, file, created: false };
      }
      return { state, file, created: false };
    }
    if (current.status === 'corrupt') {
      // 损坏的 state：先留尸（保留排查线索），再重建。
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) {}
    }
    // status === 'error'（读错误等）：尝试重建，失败则由 saveState 抛出由调用方降级。
  }
  const state = freshState(sessionId, transcriptPath, startEnabled);
  saveState(file, state);
  return { state, file, created: true };
}

function loadState(file) {
  const r = loadStateDetailed(file);
  return r.status === 'ok' ? r.state : null;
}

// 区分四种读取结果：ok / missing（不存在）/ corrupt（JSON 或 schema 损坏）/ error（IO 错误）。
// 调用方据此决定重建、留尸或放弃——"任何读错误都当不存在"曾导致 enabled 复活、计数清零。
function loadStateDetailed(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', state: null };
    return { status: 'error', state: null, detail: String(err).slice(0, 120) };
  }
  try {
    const state = JSON.parse(raw);
    if (state && state.schema === 1) return { status: 'ok', state };
    return { status: 'corrupt', state: null };
  } catch (_) {
    return { status: 'corrupt', state: null };
  }
}

// 原子写：tmp + rename。Windows 下 rename 可能因杀毒/索引器短暂持有句柄而 EPERM，
// 换新 tmp 名做有限重试；仍失败则抛给调用方（saveQuiet 负责降级）。
function saveState(file, state) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${attempt}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(tmp); } catch (_) {}
      sleepSync(30);
    }
  }
  throw lastErr || new Error('saveState failed');
}

// —— 跨进程短临界区写（修复多写者 read-modify-write 丢更新）——
// 所有状态写路径（UPS/ctl/Stop 父进程/worker 落盘）都必须经由本函数：
// 取 .wrlock → 重读最新 state → fn(state) 原地修改 → 校验锁仍属于自己 → 原子写回 → 释放。
// 写前后都校验锁属主：慢持有者（杀毒/索引器拖慢 IO）被对手按陈旧抢锁后，
// 原持有者不得再写回（否则双写者复活，丢更新回归）。
// 拿不到锁/属主丢失返回 null，由调用方决定降级（意见保留到下一轮）。
function mutateStateExclusive(file, fn, opts) {
  const retries = (opts && opts.retries) || 40;
  const staleMs = (opts && opts.staleMs) || 10000;
  const lock = `${file}.wrlock`;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(lock, myPid, { flag: 'wx' });
      got = true;
      break;
    } catch (_) {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.unlinkSync(lock); } catch (_) {}
        }
      } catch (_) {}
      sleepSync(25);
    }
  }
  if (!got) return null;
  const ownLock = () => {
    try {
      return fs.readFileSync(lock, 'utf8').trim() === myPid;
    } catch (_) {
      return false; // 锁消失 = 已被对手接管
    }
  };
  try {
    if (!ownLock()) return null;
    const r = loadStateDetailed(file);
    let state;
    if (r.status === 'ok') state = r.state;
    else if (r.status === 'missing') state = freshState('', '', true);
    else if (r.status === 'corrupt') {
      // 与 ensureState 同口径：留尸后重建，不清空真实数据还不留痕迹。
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) {}
      state = freshState('', '', true);
    } else {
      return null; // IO 错误：绝不以空状态覆盖
    }
    fn(state);
    if (!ownLock()) return null; // 临界区期间被抢：放弃本次写入
    saveState(file, state);
    return state;
  } finally {
    // 仅当锁仍属于自己时才清除（对手接管后不得误删其锁）。
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === myPid) fs.unlinkSync(lock);
    } catch (_) {}
  }
}

function latestStatePath(stateDir) {
  const all = listStatePaths(stateDir);
  return all.length > 0 ? all[all.length - 1] : '';
}

// 按 mtime 升序列出全部会话状态文件。
function listStatePaths(stateDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir)
      .filter((f) => /^sess-.*\.json$/.test(f))
      .map((f) => {
        const full = path.join(stateDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      });
  } catch (_) {
    return [];
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  return entries.map((e) => e.full);
}

// 家务清理：状态文件是纯计数器，过期即可删。
function pruneStates(stateDir, maxAgeDays, keep) {
  const limitAge = (maxAgeDays || 7) * 24 * 3600 * 1000;
  const limitKeep = keep || 50;
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir)
      .filter((f) => /^sess-.*\.json/.test(f))
      .map((f) => {
        const full = path.join(stateDir, f);
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

// —— 心跳健康告警（4a）：失败连击 failStreak ——
// 白名单语义：只有「审查本身失败」的原因计入 failStreak（llm_* 前缀统一匹配
// HTTP/超时/空响应等模型侧失败；解析、转录、台账写失败按精确名单）。
// busy/global_busy/queue_overflow/worker_error/spawn_failed 等表示「审查没跑成」
// 而非「审查失败」——冻结不改写 failStreak，避免并发堆积被误报为健康问题。
const FAIL_STREAK_REASONS_EXACT = ['unparsed', 'parse_empty', 'no_transcript', 'ledger_write_failed'];

function isFailStreakReason(reason) {
  const r = String(reason || '');
  return r.startsWith('llm_') || FAIL_STREAK_REASONS_EXACT.includes(r);
}

// 丢弃分类计数 + **最近一次发生时间**。
//
// 对齐上游 dsh-advisor v0.5.4 的 KD-I3 可见性语义（issue #102）：
// 上游为 EMPTY / UNPARSED 两类各自维护计数与 lastXxxTimestamp，让
// "advisor 在跑但从不说话" 可被发现，而不是只能开 debug 才看见。
// 这里用最小侵入的方式实现同等能力：保留原有 dropped[reason] 计数形状不变
// （既有 status 输出与测试依赖它），时间戳记入同级的 droppedAt[reason]。
// 同时维护 failStreak（4a）：同因连击累加，白名单异因切换重置，
// 非白名单原因冻结——UPS 侧据此在连续失败达到阈值时注入健康告警。
// failStreak.sinceTs 记录本轮连击的起点，告警消息据此显示"停摆约 X 小时"。
function bumpDrop(state, reason) {
  if (!reason) reason = 'unknown';
  state.dropped = state.dropped || {};
  state.dropped[reason] = (state.dropped[reason] || 0) + 1;
  // 最近一次该类别丢弃的时间（用于回答"最后一次空回复/解析失败是多久前"）
  state.droppedAt = state.droppedAt || {};
  state.droppedAt[reason] = new Date().toISOString();
  if (isFailStreakReason(reason)) {
    if (state.failStreak && state.failStreak.reason === reason) {
      state.failStreak.count = (state.failStreak.count || 0) + 1;
      // 防御：旧版本写入的 streak 无 sinceTs（升级横跨一次连击），补当前时间为停摆起点
      if (!state.failStreak.sinceTs) state.failStreak.sinceTs = new Date().toISOString();
    } else {
      state.failStreak = { reason, count: 1, sinceTs: new Date().toISOString() };
    }
  }
}

// —— 审查互斥锁（防同一会话并行审查堆积）——
// 生命周期：Stop（async 父进程）创建 → review-worker 认领（改写 pid）→ 完成后按 pid 清除；
// 陈旧锁超过 staleMs 可被下一个 Stop 抢走重建。
function lockPathFor(file) {
  return `${file}.lock`;
}

function createLock(file, staleMs) {
  const lock = lockPathFor(file);
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs < (staleMs || 600000)) return false; // 新鲜锁：已在审查
    try { fs.unlinkSync(lock); } catch (_) {}
  } catch (_) {
    // 不存在：正常路径
  }
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {
    return false; // 并发对手抢先创建
  }
}

function clearLock(file) {
  try { fs.unlinkSync(lockPathFor(file)); } catch (_) {}
}

// 仅当锁内容（pid）仍是自己时才清除——防止陈旧 worker 清掉继任者的锁。
function clearLockIfOwner(file, pid) {
  const lock = lockPathFor(file);
  try {
    if (fs.readFileSync(lock, 'utf8').trim() === String(pid)) {
      fs.unlinkSync(lock);
    }
  } catch (_) {}
}

// 全局在飞 worker 数（跨会话）：统计**新鲜**的审查锁（陈旧尸锁不计入，
// 否则一次崩溃残留的锁会在 staleMs 内让全局审查停摆）。
function countLocks(stateDir, staleMs) {
  const limit = staleMs || 600000;
  let n = 0;
  try {
    for (const f of fs.readdirSync(stateDir)) {
      if (!/^sess-.*\.json\.lock$/.test(f)) continue;
      try {
        const st = fs.statSync(path.join(stateDir, f));
        if (Date.now() - st.mtimeMs <= limit) n++;
      } catch (_) {}
    }
  } catch (_) {}
  return n;
}

module.exports = {
  ensureState, loadState, loadStateDetailed, saveState, mutateStateExclusive, latestStatePath, listStatePaths, stateFilePath,
  sanitizeSessionId, pruneStates, bumpDrop, isFailStreakReason, freshState, createLock, clearLock, clearLockIfOwner,
  lockPathFor, countLocks, sleepSync
};
