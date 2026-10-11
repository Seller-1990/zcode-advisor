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
    // —— 降级（fallback，M4）——
    // primaryFailStreak：只记「触发 fallback 的主模型失败」。fallback 成功清 failStreak
    // （系统可用）但**不清它**——否则降级成功会把主模型劣化掩盖掉、告警永不触发。
    primaryFailStreak: null,
    fallbackUsed: 0,
    fallbackLastAt: '',
    fallbackLastModel: '',
    // 降级告警走独立阶梯（不与停摆告警共计数，否则两类故障互相压制对方的提醒间隔）。
    degradeNotifiedAt: '',
    degradeAlertCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    // 会话级审查目标覆盖（角标面板 / /advisor-model 写入）。两者独立可空：
    // - sessionProvider：本会话用哪个 ZCode 第三方服务商（''= 跟随全局）
    // - sessionModel：本会话用哪个模型（''= 跟随全局/服务商清单首项）
    // 0.2.17 起端点/key 一律由服务商解析得到，状态文件不再落任何 key 明文。
    sessionProvider: '',
    sessionModel: '',
    lastAction: '',
    lastActivity: '',
    createdAt: new Date().toISOString()
  };
}

// 找不到就创建（幂等）。所有调用方都必须拿到一个可用 state，保证流程可继续。
function ensureState(stateDir, sessionId, transcriptPath, startEnabled) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // 目录已存在时 mkdirSync 的 mode 不生效：state 目录含会话转录路径与审查计数，
  // 历史遗留的宽权限目录在此收紧（失败不阻断——只读文件系统下尽力而为）。
  try { fs.chmodSync(stateDir, 0o700); } catch (_) {}
  const file = stateFilePath(stateDir, sessionId);
  if (!fs.existsSync(file)) {
    const created = freshState(sessionId, transcriptPath, startEnabled);
    // 排他创建：existsSync 与落盘之间有窗口，对手（并发会话 / ctl / Stop / worker）
    // 可能已在此刻建好并写入了自己的状态（含"关闭"与待处理笔记）。
    // 用 link 而非 rename 落盘：目标已存在即 EEXIST，绝不覆盖 —— 窗口内让位给对手。
    if (createStateExclusive(file, created)) return { state: created, file, created: true };
    // 落到这里 = 对手先创建：继续往下读，采纳对手的状态（不写自己的 freshState）。
  }
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
  // status === 'missing'（existsSync 之后被对手删掉）或 'error'（读错误）：重建，
  // 失败则由 saveState 抛出，由调用方降级。
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
// 0.2.17 迁移：旧版把会话级端点/API key 明文写在 state.sessionApi 里（0600 落盘）。
// 该覆盖面已废弃，但旧文件不会被自动重写——只要有一次读-改-写，明文 key 就会继续留在盘上。
// 因此在**读取时**就剥掉该字段（下一次 saveState 落盘即为干净内容），避免升级用户长期留明文。
function stripLegacySecrets(state) {
  if (state && typeof state === 'object' && state.sessionApi !== undefined) delete state.sessionApi;
  return state;
}

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
    if (state && state.schema === 1) return { status: 'ok', state: stripLegacySecrets(state) };
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
      // state 含会话转录路径与审查计数：0600 落盘，不依赖 umask（历史版本曾含明文 key）。
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      // rename 后文件 inode 来自 tmp（恒 0600）；此 chmod 是针对异常文件系统的
      // 纵深防御（正常 POSIX 下为 no-op，失败静默不影响主流程）。
      try { fs.chmodSync(file, 0o600); } catch (_) {}
      return;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(tmp); } catch (_) {}
      sleepSync(30);
    }
  }
  throw lastErr || new Error('saveState failed');
}

// 排他创建（"只建不改"）：写唯一 tmp → link 到目标。目标已存在则 EEXIST，绝不覆盖。
// 存在的意义：rename 会静默覆盖目标，而「先 existsSync 再 saveState」在并发会话/ctl/worker
// 之间会丢掉对手刚写入的决定（enabled 复活、笔记清零）。创建方必须走本函数，修改方走
// mutateStateExclusive。成功返回 true，目标已存在返回 false；不支持硬链接的文件系统退回
// 'wx' 独占打开（同样不覆盖已存在文件）。写失败不吞异常，交由调用方降级。
function createStateExclusive(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-excl`;
  let created = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
      created = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      // 目标文件系统不支持硬链接（少数挂载/网络盘）：退回独占打开，语义相同。
      let fd = null;
      try {
        fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(state, null, 2));
        created = true;
      } catch (err2) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (_) {}
          fd = null;
          // 半写文件不留盘：读取方会把它当损坏并留尸，反而多一份垃圾。
          try { fs.unlinkSync(file); } catch (_) {}
        }
        if (err2 && err2.code === 'EEXIST') return false;
        throw err2;
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  if (created) { try { fs.chmodSync(file, 0o600); } catch (_) {} }
  return created;
}

// 锁属主是否仍活着：**只有 ESRCH（进程不存在）算已死**，其余 errno 一律保守算活。
// 误判方向不对称：把死属主当活 ⇒ 最多多等一次 mtime 兜底（staleMs 10s）；把活属主当死
// ⇒ 删掉活持有者的锁 ⇒ 双写者复活（正是 R24 要防的丢写方向）。
// 不能只认 EPERM：libuv 在 Windows 把 access denied 映射成 EACCES，不是 POSIX 的 EPERM。
function lockOwnerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return Boolean(err) && err.code !== 'ESRCH'; }
}

// 读锁属主 pid：只认纯数字内容。'wx' 创建与写入内容之间有一个极短空窗，此刻读到的空内容
// 不是「死属主」，必须留给 mtime 规则——否则会删掉活持有者刚建的锁，双写者复活。
function readLockOwner(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

// —— 通用跨进程短临界区 ——
// 取 lockFile 的排他短租约（'wx' 创建 → 陈旧按 mtime 或属主存活接管 → 归属校验），临界区内只做
// 同步文件操作。fn(ownLock) 的返回值即本函数返回值；拿不到锁返回 null，由调用方降级。
// 是否在临界区中途失去锁由调用方用 ownLock() 判定：慢持有者（杀毒/索引器拖慢 IO）被
// 对手按陈旧抢锁后必须能自己发现并放弃写入。
function withExclusiveLock(lockFile, fn, opts) {
  const retries = (opts && opts.retries) || 40;
  const staleMs = (opts && opts.staleMs) || 10000;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(lockFile, myPid, { flag: 'wx' });
      got = true;
      break;
    } catch (_) {
      // 陈旧判定 = mtime 超 staleMs（原规则）**或属主进程已死**（R24：崩溃/被 KILL 的持锁者残留）。
      // 只看 mtime 会让残留锁把随后 staleMs(默认 10s) 内的所有写挡在门外，而重试预算只有
      // retries×25ms≈1s ⇒ 写全部返回 null 被静默丢弃（实测：属主已死的残留锁 1140ms 后丢写、
      // 状态文件未变）。属主存活时不抢，保住「慢持有者」原语义。
      try {
        const st = fs.statSync(lockFile);
        let stale = Date.now() - st.mtimeMs > staleMs;
        if (!stale) {
          const owner = readLockOwner(lockFile);
          // 只回收「别人的、已死的」锁；自己的 pid 交给 mtime 规则（避免与重入调用打架）。
          // 删前重读一次属主，防止把刚接管者的新锁删掉。
          if (owner !== null && owner !== process.pid && !lockOwnerAlive(owner)
              && readLockOwner(lockFile) === owner) {
            stale = true;
          }
        }
        if (stale) {
          try { fs.unlinkSync(lockFile); } catch (_) {}
        }
      } catch (_) {}
      sleepSync(25);
    }
  }
  if (!got) return null;
  const ownLock = () => {
    try {
      return fs.readFileSync(lockFile, 'utf8').trim() === myPid;
    } catch (_) {
      return false; // 锁消失 = 已被对手接管
    }
  };
  try {
    if (!ownLock()) return null;
    return fn(ownLock);
  } finally {
    // 仅当锁仍属于自己时才清除（对手接管后不得误删其锁）。
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === myPid) fs.unlinkSync(lockFile);
    } catch (_) {}
  }
}

// —— 跨进程短临界区写（修复多写者 read-modify-write 丢更新）——
// 所有状态写路径（UPS/ctl/Stop 父进程/worker 落盘）都必须经由本函数：
// 取 .wrlock → 重读最新 state → fn(state) 原地修改 → 校验锁仍属于自己 → 原子写回 → 释放。
// 写前后都校验锁属主：慢持有者（杀毒/索引器拖慢 IO）被对手按陈旧抢锁后，
// 原持有者不得再写回（否则双写者复活，丢更新回归）。
// 拿不到锁/属主丢失返回 null，由调用方决定降级（意见保留到下一轮）。
function mutateStateExclusive(file, fn, opts) {
  return withExclusiveLock(`${file}.wrlock`, (ownLock) => {
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
  }, opts);
}

// —— 全局在飞 worker 名额（R04）——
// 「先数后取」（countLocks → createLock）在跨进程并发下会各自看到 limit-1 把锁而同时放行：
// 每个会话的锁文件不同，createLock 都会成功，于是 N 个进程一起开工，全局上限形同虚设
// （实测 limit=1、8 进程：自然窗口 4 轮里 3 轮超限、最多 6/8；放大 readdir 窗口后 8/8）。
// 这里把「数 + 取」放进 stateDir 级临界区（复用 .wrlock 短租约协议）——临界区只做一次
// readdir 加一次排他创建，耗时可忽略，且不产生 sess-* 命名的文件（不干扰 countLocks/
// listStatePaths/pruneStates 的匹配口径）。
// 拿不到临界区（目录不可写、竞争超时）→ 退回先数后取：宁可偶发超限，也不让审查停摆。
function admitGlobalWorker(file, stateDir, staleMs, limit) {
  const max = limit || 4;
  const gated = withExclusiveLock(path.join(stateDir, '.global-workers.lock'), () => {
    if (countLocks(stateDir, staleMs) >= max) return 'global_busy';
    return createLock(file, staleMs) ? 'ok' : 'busy';
  });
  if (gated) return gated;
  if (countLocks(stateDir, staleMs) >= max) return 'global_busy';
  return createLock(file, staleMs) ? 'ok' : 'busy';
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
      .filter((f) => /^sess-.*\.json$/.test(f))
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
// 同时维护 failStreak（4a）：**跨原因累计**连续失败，非白名单原因冻结——
// UPS 侧据此在连续失败达到阈值时注入健康告警。
// failStreak.sinceTs 记录本轮连击的起点，告警消息据此显示"停摆约 X 小时"。
// 「跨原因」是关键：白名单原因（llm_* 前缀 + 解析/转录类）都表示"审查本身失败"，
// 若按原因字符串重置连击，则 404/empty/unparsed 交替出现时每次都被重置为新连击，
// 计数永远到不了阈值 → 端点持续劣化却不告警（漏报）。reason 记最近一次用于归因。
function bumpDrop(state, reason) {
  if (!reason) reason = 'unknown';
  state.dropped = state.dropped || {};
  state.dropped[reason] = (state.dropped[reason] || 0) + 1;
  // 最近一次该类别丢弃的时间（用于回答"最后一次空回复/解析失败是多久前"）
  state.droppedAt = state.droppedAt || {};
  state.droppedAt[reason] = new Date().toISOString();
  if (isFailStreakReason(reason)) {
    if (state.failStreak) {
      state.failStreak.count = (state.failStreak.count || 0) + 1;
      state.failStreak.reason = reason; // 归因用最近原因；连击次数与起点不因原因变化而重置
      if (!state.failStreak.sinceTs) state.failStreak.sinceTs = new Date().toISOString();
    } else {
      state.failStreak = { reason, count: 1, sinceTs: new Date().toISOString() };
      // 新连击（此前已恢复）：告警阶梯从第 1 次开始
      state.healthAlertCount = 0;
    }
  }
}

// 主模型失败连击（M4）：与 failStreak 分开维护。
// 为什么必须分开：fallback 成功后清 failStreak（系统可用，不该再喊停摆），
// 但主模型劣化仍在继续——若连它一起清，降级成功会把主模型故障**完全掩盖**，
// 用户永远收不到「主模型一直在坏」的提醒。
// 同样**跨原因累计**：白名单三兄弟（llm_empty_response/unparsed/llm_http_404）交替出现
// 是端点劣化的常见形态，若按原因重置则永远到不了阈值 → 降级告警漏报。
// 清零路径在调用方（applyReviewOutcome）：主模型本轮自己成功时置 null（恢复语义）。
function bumpPrimaryFailStreak(state, reason) {
  if (!reason) reason = 'unknown';
  if (state.primaryFailStreak) {
    state.primaryFailStreak.count = (state.primaryFailStreak.count || 0) + 1;
    state.primaryFailStreak.reason = reason;
    if (!state.primaryFailStreak.sinceTs) state.primaryFailStreak.sinceTs = new Date().toISOString();
  } else {
    state.primaryFailStreak = { reason, count: 1, sinceTs: new Date().toISOString() };
    state.degradeAlertCount = 0; // 新一轮劣化：告警阶梯从第 1 次开始
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
  ensureState, loadState, loadStateDetailed, saveState, mutateStateExclusive, withExclusiveLock, latestStatePath, listStatePaths, stateFilePath,
  sanitizeSessionId, pruneStates, bumpDrop, bumpPrimaryFailStreak, isFailStreakReason, freshState, createLock, clearLock, clearLockIfOwner,
  lockPathFor, countLocks, admitGlobalWorker, sleepSync, lockOwnerAlive, readLockOwner
};
