#!/usr/bin/env node
'use strict';

// zcode-advisor 输入框角标外挂（companion controller）。
// 原理与 zcode-plus 相同：ZCode 桌面版是 Electron 应用且无官方 UI 扩展机制，
// 本进程以 --remote-debugging-port 拉起 ZCode，经 Chrome DevTools Protocol 向页面
// 注入角标与设置面板脚本（input.js），并提供本机 API 供面板读写配置/拉取模型/Ping。
//
// 纪律：
// - 只监听 127.0.0.1；不改 ZCode 安装目录、不破坏签名、不干扰自动更新；
// - key 只写入用户级配置 ~/.zcode/advisor.config.json（与 /advisor-setup、配置面板同一文件）；
// - 不承诺对未来 ZCode 版本的兼容性（非公开接口，见 README 免责）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const { modelsUrl, parseModels } = require('./lib.cjs');
const { detectZcodePath, missingHint } = require('./zcode-path.cjs');
// 完整配置面板（GET /panel 返回；全局配置的 GUI 载体，见 panel.cjs 头注释）
const PANEL_HTML = require('./panel.cjs');

// —— 顾问意见历史读取 ——
// 为什么不复用 hooks/lib/history：发行包只随带 companion 四个文件（hooks/ 不存在），
// 跨目录 require 会静默失效。读取逻辑只有十几行，这里内联一份；
// 写入侧仍统一在 hooks/lib/history（单写多读，格式漂移风险由测试锁住）。
// 路径解析必须与 hooks/lib/history.js 一致（含 STATE_DIR 隔离分支），
// 否则设置 STATE_DIR 的部署里，写入与读取指向不同文件、面板永远空白。
function resolveHistoryFile() {
  if (process.env.ZCODE_ADVISOR_HISTORY) return process.env.ZCODE_ADVISOR_HISTORY;
  if (process.env.ZCODE_ADVISOR_STATE_DIR) return path.join(process.env.ZCODE_ADVISOR_STATE_DIR, 'advisor-history.jsonl');
  return path.join(os.homedir(), '.zcode', 'advisor-history.jsonl');
}
const HISTORY_FILE = resolveHistoryFile();

function readHistory(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : 50;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      try { out.push(JSON.parse(lines[i])); } catch (_) { /* 跳过坏行 */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

// —— 健康信标读取（M1）——
// 同样内联（发行包不含 hooks/，无法 require hooks/lib/health.js）。
// 路径解析与 hooks/lib/health.js 的 resolveHealthDir 必须一致（含 STATE_DIR 隔离），
// 且 deriveHealth 的判定语义必须与 health.js 一致——两侧漂移会让角标说谎。测试锁住。
function resolveHealthDir() {
  if (process.env.ZCODE_ADVISOR_HEALTH_DIR) return process.env.ZCODE_ADVISOR_HEALTH_DIR;
  if (process.env.ZCODE_ADVISOR_STATE_DIR) return process.env.ZCODE_ADVISOR_STATE_DIR;
  return path.join(os.homedir(), '.zcode');
}
const HEALTH_DIR = resolveHealthDir();

function staleThresholdMs(reviewBudgetMs) {
  const b = Number.isFinite(reviewBudgetMs) && reviewBudgetMs > 0 ? reviewBudgetMs : 480000;
  return Math.max(600000, b * 2);
}

// 与 health.js:deriveHealth 同语义。**无数据/陈旧一律 unknown，绝不回 ok**。
function deriveHealth(beacon, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : staleThresholdMs(o.reviewBudgetMs);
  if (!beacon || typeof beacon !== 'object') return 'unknown';
  const attempt = Date.parse(beacon.lastAttemptAt || '') || 0;
  const success = Date.parse(beacon.lastSuccessAt || '') || 0;
  if (!attempt) return 'unknown';
  if (now - attempt > staleMs) return 'unknown';
  const successFresh = success > 0 && (now - success) <= staleMs;
  if (successFresh && beacon.state === 'ok') return 'ok';
  // degraded 与 ok 同受新鲜度约束：降级成功也刷新 lastSuccessAt，故黄灯能亮本身就意味着近期有产出。
  // 不校验则「降级成功后持续崩溃」会永久黄灯，掩盖连续失败（M4 要消灭的静默掩盖之镜像）。
  if (successFresh && beacon.state === 'degraded') return 'degraded';
  return 'down';
}

// 读全部信标，取「最近活动」的一个（多会话并存时；不按 mtime 猜当前会话——
// controller 无从得知用户在哪个会话，故返回该条并附 sessionId 供 UI 标注）。
// 上限 cap：读取侧只关心最近活动，没必要解析上千个历史信标（该 handler 每 5s 被轮询）。
function readHealth(reviewBudgetMs, cap) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 50;
  try {
    if (!fs.existsSync(HEALTH_DIR)) return { state: 'unknown', beacon: null, candidates: 0 };
    const files = fs.readdirSync(HEALTH_DIR).filter((f) => /^advisor-health-.*\.json$/.test(f));
    const withMtime = files.map((f) => {
      const full = path.join(HEALTH_DIR, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      return { full, mtime };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    const beacons = [];
    for (const { full } of withMtime) {
      try {
        const b = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (b && typeof b === 'object') beacons.push(b);
      } catch (_) { /* 跳过坏文件 */ }
    }
    if (beacons.length === 0) return { state: 'unknown', beacon: null, candidates: 0 };
    // 与 hooks/lib/health.js:readBeacons 同一比较器（含 || 0 兜底，非法时间戳不得产生 NaN 排序）
    beacons.sort((a, b) => (Date.parse(b.lastAttemptAt || 0) || 0) - (Date.parse(a.lastAttemptAt || 0) || 0));
    const top = beacons[0];
    return {
      state: deriveHealth(top, { reviewBudgetMs }),
      beacon: {
        sessionId: top.sessionId || '',
        stateDir: top.stateDir || '',
        model: top.model || '',
        effectiveModel: top.effectiveModel || top.model || '',
        lastAttemptAt: top.lastAttemptAt || '',
        lastSuccessAt: top.lastSuccessAt || '',
        reason: top.reason || '',
        reviews: Number.isFinite(top.reviews) ? top.reviews : null
      },
      candidates: beacons.length
    };
  } catch (_) {
    return { state: 'unknown', beacon: null, candidates: 0 };
  }
}


const HOME = os.homedir();
const USER_CONFIG = process.env.ZCODE_ADVISOR_USER_CONFIG || path.join(HOME, '.zcode', 'advisor.config.json');
const COMPANION_CONFIG = process.env.ZCODE_ADVISOR_COMPANION_CONFIG || path.join(HOME, '.zcode', 'advisor-companion.json');
const LOG_FILE = process.env.ZCODE_ADVISOR_COMPANION_LOG || path.join(HOME, '.zcode', 'advisor-companion.log');
const CDP_PORT_RANGE = [9333, 9350];
const API_PORT_RANGE = [9420, 9429];
const CDP_LAUNCH_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 3000;

// 受监督模式（launchd 自启动注入 ZCODE_ADVISOR_SUPERVISED=1）。
// plist 用 KeepAlive{SuccessfulExit:false}：**只有非零退出才会被重启**。
// 因此受监督时「暂不可用」必须以非零码退出，否则进程一退就永久失去监督——
// 尤其「已有健康实例在跑」若照旧 exit(0)，launchd 会认为任务已完成，那个实例
// 之后死掉就再也没人把外挂拉起来（自启动形同虚设）。
// 退出码 3 与 launchd.cjs 的 RETRY_EXIT_CODE 一致，配 ThrottleInterval=30
// 把重试频率限制在 30s 一次（不会重启风暴）。
const SUPERVISED = process.env.ZCODE_ADVISOR_SUPERVISED === '1';
const RETRY_EXIT_CODE = 3;

// 退出码决策（纯函数，便于直接单测）。两类语义必须分开：
//   retry    = 本次没服务成功，但**稍后重试可能成功**（让位 / ZCode 未就绪 / 端口冲突）
//              → 受监督退 3（launchd 会重启）；否则退 code（调用方原语义，如 0=静默让位）
//   fatal    = 重试也不会好转，必须用户先动手（如 Node 版本过低）
//              → 受监督退 0（launchd 认为任务完成，停止重启，避免每 30s 刷日志）；
//                 否则退 code（调用方原语义，如 1=失败）
// 判错方向都有代价：retry 判成 fatal → 自启动再也不恢复；fatal 判成 retry → 无限重启刷日志。
function exitCodeFor(kind, supervised, fallbackCode) {
  if (kind === 'retry') return supervised ? RETRY_EXIT_CODE : fallbackCode;
  return supervised ? 0 : fallbackCode;
}

// 只写 stderr：launchd 的 StandardErrorPath 已指向同一日志文件，再调 log() 会重复落盘。
function exitRetryable(code, message) {
  if (message) console.error(message);
  process.exit(exitCodeFor('retry', SUPERVISED, code));
}

// 永久性失败退出（受监督时 exit 0 = 不再重启）。
function exitPermanent(code, message) {
  if (message) console.error(message);
  process.exit(exitCodeFor('fatal', SUPERVISED, code));
}

// stdout 是否已指向日志文件本身（launchd 的 StandardOutPath、启动器的 nohup >>LOG 都是）。
// 用 inode+device 比对而不是路径字符串：重定向可能经由符号链接或不同写法。
// 命中时 log() 不能再 appendFileSync，否则每行落盘两次（实测：日志里所有行成对出现）。
let stdoutIsLogFile = null;
function detectStdoutIsLogFile() {
  if (stdoutIsLogFile !== null) return stdoutIsLogFile;
  stdoutIsLogFile = false;
  try {
    const out = fs.fstatSync(1);
    const log = fs.statSync(LOG_FILE);
    stdoutIsLogFile = out.ino === log.ino && out.dev === log.dev;
  } catch (_) { /* 任一不可得 → 按未重定向处理（宁可多写一份也不丢日志） */ }
  return stdoutIsLogFile;
}

const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`;
  process.stdout.write(line + '\n');
  // 无窗口启动（vbs/nohup/launchd）时 stdout 不可见或已重定向到本文件：
  // 仅在 stdout **没有**指向日志文件时才补写一份（超 1MB 截断）。
  if (detectStdoutIsLogFile()) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1e6) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskKey = (k) => { const s = String(k || ''); return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`; };

// —— 单实例锁（服务租约）：面板重复点击/多入口同时启动时只保留一个 controller ——
//
// 语义是「**服务可用**的租约」，不是「进程活着」。旧实现只判 pid 存活且无 TTL，
// 出过一次真实故障：controller 附着的 ZCode 被关掉后，它变成僵尸——进程活着、
// 占着锁，但 rescan 找不到 CDP 目标且从不重建通道。用户再点图标时，新实例在
// acquireLock 就 exit(0)，既无窗口也无提示（表现为「点了没反应」），
// 且因为 acquireLock 在 ensureCdp 之前，永远走不到「重新拉起 ZCode」那步。
//
// 三处加固（范式抄自 auto-enable.cjs 的单飞锁，那边是仓库里唯一正确的实现）：
//   ① TTL：持锁超过 LOCK_TTL_MS 视为陈旧，允许接管（防 pid 复用永久阻塞）；
//   ② 心跳：持锁者周期刷新 started，证明「我还活着且在干活」——僵尸不再能续租；
//   ③ 原子接管：写唯一 tmp → rename → 回读确认是自己，避免两个实例同时持锁。
const LOCK_TTL_MS = 60 * 1000;        // 1 分钟：心跳每 20s 一次，三拍不跳即判心跳死亡
const LOCK_HEARTBEAT_MS = 20 * 1000;
// 僵尸宽限：进程活着、心跳正常，但**长时间没有 CDP 可用** → 判为僵尸租约，允许接管。
// 为什么不能只靠心跳：僵尸 controller 的 rescan 每 3s 跑一次、心跳也照跳，
// 只看心跳它永远「新鲜」。必须把「服务可用性」纳入租约判据。
// 3 分钟足以覆盖一次正常的 ZCode 重启 + CDP 重建（正常只需数秒），
// 又不会让用户点击后等太久（修②的自愈通常几秒内就恢复了，这里只是兜底）。
const LOCK_ZOMBIE_GRACE_MS = 3 * 60 * 1000;
const LOCK_FILE = path.join(os.tmpdir(), 'zcode-advisor-companion.lock');

function readLockInfo(lockFile) {
  try {
    const txt = fs.readFileSync(lockFile, 'utf8');
    const num = (re) => Number(((re.exec(txt) || [])[1]) || 0);
    return {
      pid: num(/(?:^|\n)pid=(\d+)/),
      started: num(/(?:^|\n)started=(\d+)/),
      // 服务可用性：持锁者当前附着的 CDP 端口（0 = 没有可用通道）。
      cdp: num(/(?:^|\n)cdp=(\d+)/),
      // 最近一次「有 CDP」的时间戳（从未有过则为持锁起始时间）。
      cdpSince: num(/(?:^|\n)cdpSince=(\d+)/)
    };
  } catch (_) {
    return { pid: 0, started: 0, cdp: 0, cdpSince: 0 };
  }
}

// 陈旧判定：无 started / 心跳超时 / pid 不存在 / 长期无 CDP（僵尸）→ 陈旧。
// kill(pid,0) 的 errno 语义要分清：EPERM = 存在但无权限（视为存活），ESRCH = 不存在。
function isStale(info) {
  if (!info.started) return true;
  if (Date.now() - info.started > LOCK_TTL_MS) return true;
  if (!info.pid) return true;
  let alive = false;
  try {
    process.kill(info.pid, 0);
    alive = true;
  } catch (err) {
    if (err && err.code === 'EPERM') alive = true;
  }
  if (!alive) return true;
  // 活着但长期无 CDP：僵尸租约（进程在跑、服务不可用）。
  if (info.cdp === 0 && info.cdpSince && Date.now() - info.cdpSince > LOCK_ZOMBIE_GRACE_MS) return true;
  return false;
}

function writeLock(lockFile, cdpPort) {
  const prev = readLockInfo(lockFile);
  const now = Date.now();
  // cdpSince 的维护：有 CDP 就刷新；没有则继承上一次的值（保留「最后一次有 CDP 的时刻」）。
  const cdpSince = cdpPort > 0 ? now : (prev.pid === process.pid && prev.cdpSince ? prev.cdpSince : now);
  const tmp = `${lockFile}.tmp-${process.pid}-${now}`;
  fs.writeFileSync(tmp, `pid=${process.pid}\nstarted=${now}\ncdp=${cdpPort || 0}\ncdpSince=${cdpSince}\n`, 'utf8');
  fs.renameSync(tmp, lockFile);
  return readLockInfo(lockFile).pid === process.pid;
}

let lockHeartbeat = null;
// 持锁者心跳：续租（刷新 started）并把当前 CDP 端口写进租约——证明服务确实可用。
function startLockHeartbeat(cdpPortRef) {
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  lockHeartbeat = setInterval(() => {
    try {
      const cur = readLockInfo(LOCK_FILE);
      if (cur.pid !== process.pid) { clearInterval(lockHeartbeat); lockHeartbeat = null; return; } // 已被接管，停止续租
      writeLock(LOCK_FILE, cdpPortRef.value);
    } catch (_) {}
  }, LOCK_HEARTBEAT_MS);
  if (lockHeartbeat.unref) lockHeartbeat.unref();
}

function acquireLock() {
  const cur = readLockInfo(LOCK_FILE);
  if (cur.pid && cur.pid !== process.pid) {
    if (!isStale(cur)) {
      log(`已有 companion 实例在运行（pid ${cur.pid}），本实例退出`);
      return false;
    }
    log(`检测到陈旧的 companion 锁（pid ${cur.pid}：心跳超时 / 进程不存在 / 长期无 CDP）——接管`);
  }
  try {
    if (!writeLock(LOCK_FILE, 0)) {
      log('锁竞争失败（已被其他实例接管），本实例退出');
      return false;
    }
  } catch (e) {
    // 写锁失败不应致命（如 tmpdir 只读）：记录后继续，行为退化为旧版（无锁保护）
    log(`写单实例锁失败（${String(e).slice(0, 80)}）——继续启动，但可能多实例`);
    return true;
  }
  process.on('exit', () => {
    try {
      if (readLockInfo(LOCK_FILE).pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (_) {}
  });
  return true;
}

// —— 外挂自身配置（zcodePath 等）——
function readCompanionConfig() {
  try {
    return JSON.parse(fs.readFileSync(COMPANION_CONFIG, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

// Spotlight 兜底：仅在 macOS 且候选链全部落空时调用（5s 超时，失败即放弃）。
function spotlightFindZcode() {
  if (process.platform !== 'darwin') return '';
  try {
    const out = execSync("mdfind \"kMDItemFSName == 'ZCode.app'\"", {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const first = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    return first || '';
  } catch (_) {
    return '';
  }
}

// 探测 ZCode 可执行文件（平台分支见 zcode-path.cjs，含 macOS .app 解析）。
function findZcodePath() {
  const cfg = readCompanionConfig();
  return detectZcodePath({
    platform: process.platform,
    env: process.env,
    config: cfg,
    deps: { fs, path, os, existsSync: fs.existsSync, statSync: fs.statSync, readFileSync: fs.readFileSync, homedir: os.homedir, mdfind: spotlightFindZcode }
  });
}

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 3000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function portReachable(port) {
  try {
    const v = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
    return !!(v && v.Browser);
  } catch (_) {
    return false;
  }
}

// —— CDP 附着 ——
// 依赖全局 WebSocket：Node 22+ 默认提供（v21 需 --experimental-websocket 标志）。
// 运行时版本守卫放在 main() 内（而非模块顶层），这样 require 冒烟校验/单测
// 仍能在低版本 Node 上安全加载本模块。
const attached = new Map(); // targetId -> WebSocket
const scriptIds = new Map(); // targetId -> [scriptId]（addScriptToEvaluateOnNewDocument 的句柄）
const pendingPersistent = new Set(); // 等待 Page.enable ack 后才注册持久脚本的 target
let injectSource = '';

// 补强通道：直接在当前文档执行一次（覆盖"附着时文档已存在"的场景）。
function injectInto(ws) {
  try {
    ws.send(JSON.stringify({ id: Date.now() % 1e7, method: 'Runtime.evaluate', params: { expression: injectSource, returnByValue: false, userGesture: true } }));
  } catch (_) {}
}

// 主通道：addScriptToEvaluateOnNewDocument —— 每次新文档创建时自动执行。
// 相比只靠 Page.loadEventFired，这条通道能覆盖页面导航与部分新窗口场景
// （原实现在新开窗口时可能漏注入）。幂等由注入脚本内的
// window.__zcodeAdvisorInjected 守卫保证，重复执行不会插出多个角标。
function addPersistentScript(ws) {
  try {
    ws.send(JSON.stringify({
      id: 3,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: { source: injectSource, runImmediately: false }
    }));
  } catch (_) {}
}

function attachTarget(target) {
  if (attached.has(target.id) || !target.webSocketDebuggerUrl) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  attached.set(target.id, ws);
  ws.addEventListener('open', () => {
    log(`已附着页面 ${target.title || target.url || target.id}`);
    try {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Page.enable' }));
      // 当前文档立即注入（不依赖 Page 域，Runtime.evaluate 即可）
      injectInto(ws);
      // 持久脚本的注册放到 Page.enable 的 ack 之后（见 message 处理），
      // 不依赖"CDP 按序处理同一连接消息"这一实现细节。
      pendingPersistent.add(target.id);
    } catch (_) {}
  });
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      // Page.enable 已生效 → 注册持久脚本（覆盖后续新建文档/新窗口）
      if (m.id === 2 && pendingPersistent.has(target.id)) {
        pendingPersistent.delete(target.id);
        addPersistentScript(ws);
      }
      // 记录 scriptId 便于排错（如宿主拒绝该命令）
      if (m.id === 3) {
        if (m.result && m.result.identifier) {
          const list = scriptIds.get(target.id) || [];
          list.push(m.result.identifier);
          scriptIds.set(target.id, list);
          // 成功也要留痕：否则"持久注入静默失效"时日志与正常情况无法区分
          log(`持久注入已注册（scriptId ${m.result.identifier}）：新窗口/导航后角标自动恢复`);
        } else {
          log(`warn: addScriptToEvaluateOnNewDocument 未返回 identifier：${JSON.stringify(m.result)}`);
        }
      }
      if (m.error && m.id === 3) {
        log(`warn: addScriptToEvaluateOnNewDocument 被拒绝：${m.error.message || JSON.stringify(m.error)}`);
      }
      if (m.method === 'Page.loadEventFired') injectInto(ws); // 刷新/导航后补注入
    } catch (_) {}
  });
  ws.addEventListener('close', () => { attached.delete(target.id); scriptIds.delete(target.id); pendingPersistent.delete(target.id); });
  ws.addEventListener('error', () => {});
}

// 当前附着的调试端口。0 = 尚未附着。
let currentPort = 0;
// 当前 CDP 端口的最新值，供锁心跳读取（心跳要证明「服务可用」）。
const cdpPortRef = { value: 0 };
// CDP 消失后开始计时的时刻（0 = 当前有 CDP）。用于判断是否该自愈重建。
let cdpLostSince = 0;
// 自愈宽限：CDP 消失超过此时长才尝试重建，避免 ZCode 正常重启（几秒）期间反复 spawn。
const CDP_SELFHEAL_GRACE_MS = 30 * 1000;
// 自愈节流：两次重建尝试的最小间隔，防止 ZCode 起不来时高频 spawn。
const CDP_SELFHEAL_COOLDOWN_MS = 60 * 1000;
let lastSelfHealAt = 0;

// 全端口段重扫：与 zcode-plus 等其他 CDP 外挂共存的关键。
// CDP 允许多客户端同时附着同一实例（✨ 与 🛡️ 在同一页面共存）；
// 谁先启动都行——对方重启 ZCode 到别的调试端口后，这里会自动跟随重新注入。
async function rescan() {
  for (let p = CDP_PORT_RANGE[0]; p <= CDP_PORT_RANGE[1]; p++) {
    let targets = null;
    try {
      targets = await fetchJson(`http://127.0.0.1:${p}/json/list`, 1200);
    } catch (_) {
      continue; // 该端口无 CDP
    }
    if (!Array.isArray(targets)) continue;
    if (currentPort !== p) {
      log(currentPort === 0 ? `附着调试实例（端口 ${p}）` : `调试实例切换：${currentPort} → ${p}，重新附着`);
      currentPort = p;
    }
    cdpPortRef.value = p;
    cdpLostSince = 0;
    for (const t of targets) {
      if (t.type === 'page' && t.webSocketDebuggerUrl) attachTarget(t);
    }
    return;
  }
  if (currentPort !== 0) {
    log('调试实例已消失（ZCode 被关闭/重启？），等待重新出现…');
    currentPort = 0;
  }
  cdpPortRef.value = 0;
  // 自愈：CDP 消失超过宽限期后，重新走 ensureCdp（会重新拉起带调试端口的 ZCode）。
  // 旧实现只打印「等待重新出现」——一旦被附着的 ZCode 死掉，本进程就永久空转：
  // 进程活着、占着单实例锁、却永远不恢复服务（实测故障：用户点图标「没反应」）。
  // 这里加上重建，配合带 CDP 标记的租约，僵尸态最多持续 GRACE+COOLDOWN。
  const now = Date.now();
  if (cdpLostSince === 0) cdpLostSince = now;
  const lostFor = now - cdpLostSince;
  if (lostFor > CDP_SELFHEAL_GRACE_MS && now - lastSelfHealAt > CDP_SELFHEAL_COOLDOWN_MS) {
    lastSelfHealAt = now;
    log(`CDP 已消失 ${Math.round(lostFor / 1000)}s，尝试重建调试通道…`);
    try {
      const p = await ensureCdp();
      cdpPortRef.value = p;
      cdpLostSince = 0;
      log(`调试通道已重建（端口 ${p}）`);
    } catch (e) {
      // ensureCdp 失败会 process.exit(1)；能走到这里说明是别的异常，记录后下轮再试
      log(`重建调试通道失败：${String(e).slice(0, 120)}（下轮重试）`);
    }
  }
}

// 宿主主实例探测：ZCode 是否正在运行（不论有无调试端口）。
// 用途：在没有可用调试端口时判断「是否已开着一个非调试模式的 ZCode」——
// 那种情况下 spawn 带 flag 的新实例是徒劳的（Electron 单实例语义会并入/丢弃新进程，
// 调试端口永远不会开），必须让用户先完全退出 ZCode，而不是静默死等 25s。
// 探测失败一律返回 false：宁可照旧尝试，也不要因探测本身出错而误拦启动。
function hostInstanceRunning(zcodePath) {
  const want = path.basename(String(zcodePath || 'ZCode')).replace(/\.exe$/i, '');
  if (!want) return false;
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return out.split('\n').some((l) => {
        const m = /^"([^"]+)"/.exec(l.trim());
        return m && m[1].replace(/\.exe$/i, '').toLowerCase() === want.toLowerCase();
      });
    }
    // macOS/Linux：comm 是完整可执行路径，取 basename 精确比对。
    // 用精确匹配而非包含匹配：ZCode 的 helper 进程（"ZCode Helper"）basename 不同，不会误判。
    const out = execSync('ps -Ao comm=', { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').some((line) => path.basename(line.trim()) === want);
  } catch (_) {
    return false;
  }
}

// spawn 失败的 errno 分类（纯函数，便于单测）。
//   fatal = 配置指向的路径根本不可执行（EACCES 无执行位 / ENOENT 不存在 / ENOTDIR
//           路径中有非目录）——重试一万次也一样，必须让用户改配置，否则受监督下
//           会变成每 30s 一次的崩溃重启循环。
//   retry = 其它（EMFILE 句柄耗尽、EAGAIN 等）——稍后重试可能成功，交给 launchd。
function classifySpawnError(code) {
  return code === 'EACCES' || code === 'ENOENT' || code === 'ENOTDIR' ? 'fatal' : 'retry';
}

async function ensureCdp() {
  const cfg = readCompanionConfig();
  // 已有可用调试端口（例如上次以外挂入口启动且进程还活着）：直接附着
  for (let p = CDP_PORT_RANGE[0]; p <= CDP_PORT_RANGE[1]; p++) {
    if (await portReachable(p)) {
      log(`发现已运行的调试实例（端口 ${p}），直接附着`);
      return p;
    }
  }
  const found = findZcodePath();
  const zcodePath = found.path || '';
  if (!zcodePath) {
    if (found.invalid) {
      console.error(`配置的 zcodePath 无效：${found.invalid.value}（解析为 ${found.invalid.resolved}，文件不存在）`);
    }
    // 可重试：ZCode 可能在登录之后才装好/才挂载，受监督时交给 launchd 稍后重试。
    exitRetryable(1, missingHint(process.platform, COMPANION_CONFIG));
  }
  log(`ZCode 可执行文件：${zcodePath}（来源：${found.source}）`);

  // 主实例预检：ZCode 已在运行（且没有调试端口，否则上面早附着上了）时，
  // 再 spawn 一个带 --remote-debugging-port 的实例**不会**让既有实例获得调试端口——
  // Electron 的单实例语义会把新进程并入/丢弃，调试端口永远不会开。
  // 旧实现对此毫不知情，照旧 spawn 然后死等 25s 才报错；日志里只留一句超时，
  // 用户看到的是「点了没反应」。这里提前识别，给出**可操作**的指引后立即失败。
  if (hostInstanceRunning(zcodePath)) {
    // 可重试：用户「完全退出 ZCode」后重启外挂即可自愈。受监督时让 launchd
    // 每 30s 重试一次——用户退出 ZCode 后无需再手动点图标，外挂会自己接上。
    // 受监督时会每 30s 重试，故只打一行（多行指引会随重试刷爆日志）；
    // 未受监督时是用户主动点击触发的单次失败，给出完整可操作指引。
    exitRetryable(1, SUPERVISED
      ? 'ZCode 已在运行但无调试端口，等待其完全退出后自动接管（受 launchd 监督，每 30s 重试）'
      : 'ZCode 已在运行，但它不是以调试模式启动的（当前实例没有 CDP 端口）。\n' +
        '角标/设置面板需要调试通道，而调试端口无法注入到已在运行的进程。\n' +
        '请先**完全退出 ZCode（含菜单栏图标）**，再重新打开「ZCode Advisor」。\n' +
        '（若你是直接双击 ZCode 打开的，请改用 ZCode Advisor 启动器。）'
    );
  }

  let port = cfg.port && cfg.port >= CDP_PORT_RANGE[0] && cfg.port <= CDP_PORT_RANGE[1] ? cfg.port : CDP_PORT_RANGE[0];
  for (; port <= CDP_PORT_RANGE[1]; port++) {
    try {
      // bind 预检：占用即顺延
      await fetchJson(`http://127.0.0.1:${port}/json/version`, 400);
    } catch (_) {
      break; // 端口空闲
    }
  }
  if (port > CDP_PORT_RANGE[1]) {
    exitRetryable(1, `调试端口 ${CDP_PORT_RANGE[0]}-${CDP_PORT_RANGE[1]} 全部占用（稍后重试；受监督时由 launchd 自动重试）`);
  }
  log(`以调试端口 ${port} 启动 ZCode：${zcodePath}`);
  // 启动 ZCode 的环境变量纪律（实测踩过）：
  //   父进程若带 ELECTRON_RUN_AS_NODE=1，ZCode 的 Electron 主二进制会被当成 Node
  //   解释器启动——报 "bad option: --remote-debugging-port" 并随即退出，CDP 永远起不来。
  //   （我们在 dsh 环境里正是这个变量被置位。）因此显式剥离该变量再启动。
  const childEnv = Object.assign({}, process.env);
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 同时清掉其它会干扰 Electron 语义的变量，避免同类问题再次出现。
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete childEnv.ELECTRON_ENABLE_LOGGING;

  // spawn 的 error 事件必须监听：Node 对未处理的 'error' 会**直接抛异常终止进程**。
  // 实测（用不可执行的 zcodePath 触发）：进程带着堆栈崩掉。未受监督时只是难看的崩溃；
  // 受监督时更糟——launchd 见非零退出就每 30s 重启，形成崩溃重启循环刷爆日志。
  // 这里捕获后按 errno 分类：可重试的交给 launchd 重试，永久性的退出 0 停止重启。
  const child = spawn(zcodePath, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    // macOS 上切到 app 的 MacOS 目录启动，与 zcode+ 的真机做法一致
    cwd: process.platform === 'darwin' ? path.dirname(zcodePath) : undefined,
    env: childEnv
  });
  const spawnError = new Promise((resolve) => {
    child.once('error', (err) => resolve(err));
  });
  child.unref();

  // 边等 CDP 就绪边观察 spawn 失败：spawn 失败时 CDP 永远不会就绪，必须提前退出。
  const deadline = Date.now() + CDP_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const err = await Promise.race([spawnError, sleep(700).then(() => null)]);
    if (err) {
      const code = err && err.code;
      if (classifySpawnError(code) === 'fatal') {
        // 配置的路径不可执行 / 不存在：重试也不会好转，需用户修正配置
        exitPermanent(1, `无法启动 ZCode（${code}）：${zcodePath}\n请检查 ${COMPANION_CONFIG} 中的 zcodePath 是否指向可执行文件。`);
      }
      exitRetryable(1, `启动 ZCode 失败（${code || err.message}）：${zcodePath}`);
    }
    if (await portReachable(port)) {
      log('CDP 通道就绪');
      return port;
    }
  }
  exitRetryable(1, '等待 CDP 通道超时。若 ZCode 已在运行（未带调试端口），请先完全退出 ZCode（含托盘），再运行本入口。');
}

// —— 用户级配置读写 ——
function readUserConfig() {
  try { return JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8')) || {}; } catch (_) { return {}; }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {}
}

// 配置文件跨进程 RMW 临界区。
// **锁协议的 vendored 双副本必须逐字一致**：本文件与 tools/config-bridge.js（本发行包
// 不含 hooks/，无法 require 共享，只能复制；test/static-guards.test.js 锁两副本的协议
// 标记防漂移）。写方全景：config-bridge writeUserConfig（桥接启动 + setup-server 面板
// 保存）、本文件 saveUserConfig（controller 面板保存）；auto-enable 仅「不存在则创建」。
//   协议：锁文件 <target>.lock，内容=持有者 pid，wx 抢建；持有者 pid 已死或锁 mtime>10s
//   → 接管；进入与写入前双查属主，仅属主清除；EEXIST 重试 40×25ms≈1s，EACCES/EROFS
//   等永久性失败立即放弃。
function withConfigLock(target, fn) {
  const lock = `${target}.lock`;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    try {
      fs.writeFileSync(lock, myPid, { flag: 'wx' });
      got = true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      let holder = '';
      try { holder = fs.readFileSync(lock, 'utf8').trim(); } catch (_) {}
      let stale = true;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch (_) {}
      const pid = parseInt(holder, 10);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
      }
      if (!alive || stale) { try { fs.unlinkSync(lock); } catch (_) {} }
      sleepSync(25);
    }
  }
  if (!got) return false;
  const ownLock = () => {
    try { return fs.readFileSync(lock, 'utf8').trim() === myPid; } catch (_) { return false; }
  };
  try {
    if (!ownLock()) return false;
    return fn();
  } finally {
    try { if (fs.readFileSync(lock, 'utf8').trim() === myPid) fs.unlinkSync(lock); } catch (_) {}
  }
}

function saveUserConfig(patch) {
  const allowed = {};
  for (const k of ['model', 'reviewMode', 'maxTokens', 'startEnabled', 'zcodeProvider']) {
    // 注意：v 必须在所有分支之前声明——曾把 startEnabled 分支写在 const v 之前，
    // 触发 TDZ（Cannot access 'v' before initialization），使**所有保存请求** 500。
    const v = patch[k];
    // startEnabled 是顾问总开关（新会话是否自动启用）：布尔处理
    if (k === 'startEnabled') {
      if (v === true || v === false) allowed[k] = v;
      else if (v === 'true') allowed[k] = true;
      else if (v === 'false') allowed[k] = false;
      continue;
    }
    if (k === 'maxTokens') {
      const mt = parseInt(v, 10);
      if (Number.isFinite(mt) && mt >= 64 && mt <= 16384) allowed[k] = mt;
    } else if (typeof v === 'string' && v.trim() && !/^\$\{/.test(v)) {
      allowed[k] = v.trim();
    }
  }
  // 读-合-写全程在跨进程临界区内：与 config-bridge 桥接启动写、setup-server 面板保存
  // 并发时不再互相覆盖（丢更新）。锁协议见上方 withConfigLock 注释。
  // 抢锁前先建目录：wx 建锁需要父目录存在（否则 ENOENT 被误判为永久性失败立即放弃）。
  fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true, mode: 0o700 });
  const outcome = withConfigLock(USER_CONFIG, () => {
    const merged = Object.assign({}, readUserConfig(), allowed);
    // 配置文件可能残留旧版手动 key/端点：写入时一并清掉，避免「手动 key 发往服务商端点」
    // 的密钥交叉面（0.2.17 起端点/key 只来自 ZCode 服务商，插件配置不参与解析）。
    // ⚠️ 这是**有意的破坏性迁移**：升级用户的 key 会从这里消失。必须留日志痕迹，
    // 否则用户只看到"我的 key 没了"却不知去哪了（日志同时给出替代位置）。
    const removedLegacy = [];
    for (const legacy of ['apiKey', 'baseUrl', 'apiSource', 'zcodeModel']) {
      if (Object.prototype.hasOwnProperty.call(merged, legacy)) {
        delete merged[legacy];
        removedLegacy.push(legacy);
      }
    }
    if (removedLegacy.length > 0) {
      log(`迁移 0.2.17：已从配置移除旧版手动键 [${removedLegacy.join(', ')}]；`
        + '端点与 key 现由 ZCode 服务商统一维护（设置 → 模型服务商），不要在插件配置里补回。');
    }
    // 目录 0700、文件 0600（与转录快照/意见历史同级；旧版此文件含明文 key）。
    const tmp = `${USER_CONFIG}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, USER_CONFIG); break; } catch (err) {
          if (i >= 2 || !err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
          sleepSync(30 * (i + 1)); // Windows 杀毒持有目标句柄时 rename EPERM（state.js 同款实证）
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    try { fs.chmodSync(USER_CONFIG, 0o600); } catch (_) {}
    return merged;
  });
  if (outcome === false) return { lockTimeout: true };
  return outcome;
}

// —— ZCode 已维护的第三方 API（0.2.17 起唯一审查来源）——
// 解析规则与 hooks/lib/config.js 的 readZcodeProviders 同源：provider.<id> =
// { name, kind, options: { baseURL, apiKey }, models: {...} }。独立实现是刻意的：
// companion 发行包只有本目录四个文件（无 hooks/），跨目录 require 会静默失效
// （与上方 readHistory 的先例同一理由）；规则若变更需两侧同步（测试锁住字段名）。
// id 以 builtin: 开头的是 ZCode 官方内置通道（bigmodel/z.ai）——审查通道不使用。
function zcodeConfigFile() {
  return process.env.ZCODE_ADVISOR_ZCODE_CONFIG
    || path.join(HOME, '.zcode', 'v2', 'config.json');
}

// 第二个数据源（与 hooks/lib/config.js 的 zcodeProviderConfigPath 同源）：
// 用户在 ZCode 界面新建的服务商只写在这里（实测：内网 workbuddy 的 providerId
// 是 'new-provider'，在 config.json 里完全不存在）——只读 config.json 会漏掉它们。
function zcodeProviderConfigFile() {
  return process.env.ZCODE_ADVISOR_ZCODE_PROVIDER_CONFIG
    || path.join(HOME, '.zcode', 'v2', 'provider_config.json');
}

// 审查通道可用的协议判定：config.json 侧是 'openai'/'openai-compatible'，
// provider_config.json 侧是 'openai-chat-completions'（同一协议的另一枚举名，界面显示为
// openai-compatible）。三者都认；'anthropic'/'anthropic-messages' 走 /v1/messages，
// 由 normalizeMessagesEndpoint + ping/fetch 的协议分支处理。
function isOpenAiCompatibleKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return k === 'openai' || k === 'openai-compatible' || k === 'openai-chat-completions';
}

function isAnthropicKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return k === 'anthropic' || k === 'anthropic-messages';
}

// 归一化协议标识（与 hooks/lib/config.js 的 protocolOf 同源）：
// 'openai' | 'anthropic'；未知协议返回空串 → 判为 ineligible，不产出凭据。
function protocolOf(kind) {
  if (isOpenAiCompatibleKind(kind)) return 'openai';
  if (isAnthropicKind(kind)) return 'anthropic';
  return '';
}

function isUsableKind(kind) {
  return Boolean(protocolOf(kind));
}

function readProviderConfigRules() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(zcodeProviderConfigFile(), 'utf8')); } catch (_) { return []; }
  const rules = (((raw || {}).config || {}).providerConfigRules || {}).providerRules;
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const e of rules) {
    if (!e || typeof e !== 'object') continue;
    const c = e.config && typeof e.config === 'object' ? e.config : {};
    const api = c.api && typeof c.api === 'object' ? c.api : {};
    const acc = c.access && typeof c.access === 'object' ? c.access : {};
    const id = String(e.providerId || '').trim();
    if (!id) continue;
    const models = Array.isArray(c.personalModelIds) ? c.personalModelIds.map(String)
      : (Array.isArray(c.modelOrder) ? c.modelOrder.map(String) : []);
    out.push({
      id,
      name: String(e.providerName || ''),
      kind: String(api.type || ''),
      baseURL: String(api.baseUrl || '').trim(),
      apiKey: String(acc.apiKey || '').trim(),
      models,
      eligible: isUsableKind(api.type),
      protocol: protocolOf(api.type),
      official: false,
      source: 'provider_config'
    });
  }
  return out;
}

function readZcodeProviders() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(zcodeConfigFile(), 'utf8')); } catch (_) { raw = null; }
  const map = (raw && raw.provider && typeof raw.provider === 'object') ? raw.provider : {};
  const out = [];
  for (const [id, p] of Object.entries(map)) {
    if (!p || typeof p !== 'object') continue;
    const opts = p.options && typeof p.options === 'object' ? p.options : {};
    out.push({
      id,
      name: String(p.name || ''),
      kind: String(p.kind || ''),
      baseURL: String(opts.baseURL || '').trim(),
      apiKey: String(opts.apiKey || '').trim(),
      models: p.models && typeof p.models === 'object' ? Object.keys(p.models) : [],
      eligible: isUsableKind(p.kind),
      protocol: protocolOf(p.kind),
      official: id.startsWith('builtin:'),
      source: 'config'
    });
  }
  // 合并第二个源。⚠️ 两源有 ID 重叠（实测 4 个）：端点/key 实测相同，
  // 但 provider_config 的模型清单更全 → 重叠项**补全模型**（并集），不整体替换，
  // 以免丢掉 config.json 侧的 official/source 标记与既有顺序。
  const byId = new Map(out.map((p) => [p.id, p]));
  for (const p of readProviderConfigRules()) {
    const exist = byId.get(p.id);
    if (exist) {
      const merged = exist.models.slice();
      for (const m of p.models) if (!merged.includes(m)) merged.push(m);
      exist.models = merged;
      if (!exist.baseURL && p.baseURL) exist.baseURL = p.baseURL;
      if (!exist.apiKey && p.apiKey) exist.apiKey = p.apiKey;
      continue;
    }
    byId.set(p.id, p);
    out.push(p);
  }
  return out;
}

function pickZcodeProvider(want) {
  const w = String(want || '').trim();
  if (!w) return null;
  const all = readZcodeProviders();
  return all.find((p) => p.id === w) || all.find((p) => p.name && p.name === w) || null;
}

// 把面板载荷/已存配置解析为一次真实调用的 {baseUrl, apiKey, model}。
// 与 hook 侧 resolveProviderTarget 同一规则（两侧独立实现、字段名被测试锁住）：
// 服务商必须是非官方 + 协议受支持（OpenAI 兼容或 Anthropic）+ 端点/key 齐备，否则不产出任何凭据
// （调用方按 error 字段失败返回，绝不回退到硬编码端点——防密钥交叉）。
// key 不出进程：页面只需要模型/端点展示，永远拿不到 apiKey 明文。
function effectiveTarget(body) {
  const cfg = readUserConfig();
  const b = body || {};
  const providerWant = String(b.zcodeProvider || cfg.zcodeProvider || '').trim();
  const modelWant = String(b.model || cfg.model || '').trim();
  let prov = pickZcodeProvider(providerWant);
  let auto = false;
  if (!prov && !providerWant) {
    const usable = readZcodeProviders().filter((p) => !p.official && p.eligible && p.baseURL && p.apiKey);
    prov = (modelWant && usable.find((p) => p.models.includes(modelWant))) || usable[0] || null;
    auto = Boolean(prov);
  }
  const model = String(modelWant || (prov && prov.models[0]) || '').trim();
  const usable = Boolean(prov && !prov.official && prov.eligible && prov.baseURL && prov.apiKey);
  // 分层原因：先判「服务商本身能不能用」（usable），再判「模型是否定得下来」（model）。
  // 分开的原因是「从端点拉取模型」这条路径**恰恰用于模型还没定下来的时候**——
  // 端点/key 必须给得出去，否则用户永远拉不到清单（曾把两者混在 baseUrl 的赋值里，
  // 导致 model 为空时 baseUrl 也被清空，拉取功能整体失效）。
  let reason = '';
  if (!prov) reason = providerWant ? 'provider_not_found' : 'provider_missing';
  else if (prov.official) reason = 'provider_official';
  else if (!prov.eligible) reason = 'provider_ineligible';
  else if (!prov.baseURL || !prov.apiKey) reason = 'provider_incomplete';
  else if (!model) reason = 'no_model';
  return {
    // 凭据随「服务商可用」给出（不含 model 条件）；真正发起审查调用的一方自己保证 model 非空。
    baseUrl: usable ? prov.baseURL : '',
    apiKey: usable ? prov.apiKey : '',
    model,
    // 协议随凭据一起给出：ping/fetchModels 据此选请求构造（OpenAI 头 vs x-api-key+anthropic-version）。
    protocol: usable ? (prov.protocol || 'openai') : '',
    providerId: prov ? prov.id : '',
    providerName: prov ? (prov.name || prov.id) : '',
    providerFound: Boolean(prov),
    providerUsable: usable,
    providerAuto: auto,
    providerError: reason || ''
  };
}

// —— 会话级状态（跨进程读写 hook 侧状态文件）——
// 信标带 stateDir + sessionId（hooks/lib/health.js writeAttempt/writeResult 下发），
// 据此定位 hook 的状态文件 sess-<id>.json，支撑角标的「本会话启用开关 / 当前模型（含会话覆盖）」。
// 多会话归属：controller 无从得知用户当前在哪个会话，取「最近活动」信标并在 UI 标注
// （与 /api/health 同一语义）；多会话并行时的开关作用于最近活动的那一个。
function sanitizeSessionIdForState(sessionId) {
  const s = String(sessionId || '').trim();
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return cleaned || 'default';
}

// 信标是否可用：sessionId 与 stateDir 齐备，且 stateDir 确实指向**该会话的状态文件**。
// 为什么必须校验 stateDir（0.2.20 修）：0.2.19 及更早把 stateDir 错写成 healthDir（~/.zcode），
// 于是 controller 拿到它去找 sess-*.json 必然找不到 → hasSession:false →
// 角标「使用全局默认 / 固定此模型」**恒灰**。
// 只按"字段存在"判定的话，升级用户的旧信标仍会被接受，表现为"升了版却没修复"——
// 正是用户实测报障的样子。因此这里要求 stateDir 目录里**真的有本会话的状态文件**，
// 否则视为旧信标跳过（继续找更新的那一个）。
function beaconUsable(b) {
  if (!b || !b.sessionId || !b.stateDir) return false;
  try {
    const f = path.join(String(b.stateDir), `sess-${sanitizeSessionIdForState(b.sessionId)}.json`);
    return fs.existsSync(f);
  } catch (_) {
    return false;
  }
}

function locateLatestSessionBeacon() {
  try {
    if (!fs.existsSync(HEALTH_DIR)) return null;
    const files = fs.readdirSync(HEALTH_DIR).filter((f) => /^advisor-health-.*\.json$/.test(f));
    const withMtime = files.map((f) => {
      const full = path.join(HEALTH_DIR, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      return { full, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const { full } of withMtime.slice(0, 20)) {
      try {
        const b = JSON.parse(fs.readFileSync(full, 'utf8'));
        // 只接受 stateDir 确实指向本会话状态文件的信标。旧代码把 stateDir 写成 healthDir
        // （~/.zcode），那种信标一律跳过——否则升级用户会一直看到"按钮恒灰"。
        // 不做"兜底返回失效信标"：那会让下游误以为存在会话（readSessionSnapshot 仍会
        // hasSession:false），徒增两处语义分叉。
        if (beaconUsable(b)) return b;
      } catch (_) { /* 跳过坏文件/旧格式信标 */ }
    }
  } catch (_) {}
  return null;
}

// 旧版（≤0.2.16）把会话级端点/API key 明文写在 state.sessionApi 里。该覆盖面已废弃，
// 但 controller 的两个写入口（toggleSessionEnabled / setSessionTarget）是「读整个对象、
// 改几个字段、整对象写回」——不剥掉的话旧明文 key 会被永久保留在盘上。
// 与 hook 侧 hooks/lib/state.js 的 stripLegacySecrets 同一规则（两侧独立进程，各自实现）。
function stripLegacySecrets(st) {
  if (st && typeof st === 'object' && st.sessionApi !== undefined) delete st.sessionApi;
  return st;
}

// 读取最近活动会话的状态快照（enabled / 会话级服务商与模型），供角标展示与开关初始态。
function readSessionSnapshot() {
  const b = locateLatestSessionBeacon();
  if (!b) return { ok: true, hasSession: false };
  const stateFile = path.join(String(b.stateDir), `sess-${sanitizeSessionIdForState(b.sessionId)}.json`);
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  stripLegacySecrets(st);
  return {
    ok: true,
    hasSession: Boolean(st && typeof st === 'object'),
    sessionId: String(b.sessionId || ''),
    stateFile,
    enabled: st ? st.enabled !== false : true,
    sessionProvider: st ? String(st.sessionProvider || '') : '',
    sessionModel: st ? String(st.sessionModel || '') : ''
  };
}

// 切换最近活动会话的启用开关。与 hook 的 ctl on/off（mutateStateExclusive）同款
// <file>.wrlock 锁协议互斥：wx 抢建、陈旧接管（10s）、属主校验——两侧不会互相覆盖。
// hook 侧语义对齐：off 只置 enabled=false（不写 disabledReason，门禁原因由审查链自算）。
function toggleSessionEnabled(enabled) {
  const want = enabled !== false;
  const b = locateLatestSessionBeacon();
  if (!b) {
    return { ok: false, error: 'no_session', hint: '没有可操作的会话——先在 ZCode 里打开一个会话并让它跑起来（信标尚不存在）' };
  }
  const stateFile = path.join(String(b.stateDir), `sess-${sanitizeSessionIdForState(b.sessionId)}.json`);
  const lock = `${stateFile}.wrlock`;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    try {
      fs.writeFileSync(lock, myPid, { flag: 'wx' });
      got = true;
    } catch (_) {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lock); } catch (_) {} }
      } catch (_) {}
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch (_) {}
    }
  }
  if (!got) return { ok: false, error: 'lock_timeout', hint: '会话状态正被审查进程写入，请稍后重试' };
  const ownLock = () => { try { return fs.readFileSync(lock, 'utf8').trim() === myPid; } catch (_) { return false; } };
  try {
    if (!ownLock()) return { ok: false, error: 'lock_timeout', hint: '会话状态正被审查进程写入，请稍后重试' };
    let st;
    try {
      st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (_) {
      return { ok: false, error: 'state_unreadable', hint: '会话状态文件不可读（可能尚未生成）：' + stateFile };
    }
    if (!st || typeof st !== 'object') {
      return { ok: false, error: 'state_unreadable', hint: '会话状态文件内容异常：' + stateFile };
    }
    stripLegacySecrets(st);
    st.enabled = want;
    if (want) st.disabledReason = '';
    const tmp = `${stateFile}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { ok: false, error: 'state_write_failed', hint: String(err && err.message || err).slice(0, 120) };
    }
    return { ok: true, enabled: want, sessionId: String(b.sessionId || ''), sessionProvider: String(st.sessionProvider || ''), sessionModel: String(st.sessionModel || '') };
  } finally {
    try { if (fs.readFileSync(lock, 'utf8').trim() === myPid) fs.unlinkSync(lock); } catch (_) {}
  }
}

// 设置/重置最近活动会话的会话级审查目标（角标面板「本会话模型」入口）。
// 与 /advisor-model set|reset（mutateStateExclusive）同款 wrlock 互斥、同一落点：
// 只写 state.sessionProvider / state.sessionModel，审查链下一轮 resolveTarget 即取到
// （会话覆盖 > 全局）。空串 = reset 该项（恢复跟随全局）。
// 端点/key 不在本函数职责内——它们永远由服务商解析得到，状态文件不落任何 key。
function setSessionTarget(provider, model) {
  const wantProvider = String(provider || '').trim();
  const wantModel = String(model || '').trim();
  const b = locateLatestSessionBeacon();
  if (!b) {
    return { ok: false, error: 'no_session', hint: '没有可操作的会话——先在 ZCode 里打开一个会话并让它跑起来（信标尚不存在）' };
  }
  const stateFile = path.join(String(b.stateDir), `sess-${sanitizeSessionIdForState(b.sessionId)}.json`);
  const lock = `${stateFile}.wrlock`;
  const myPid = String(process.pid);
  let got = false;
  for (let i = 0; i < 40 && !got; i++) {
    try {
      fs.writeFileSync(lock, myPid, { flag: 'wx' });
      got = true;
    } catch (_) {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lock); } catch (_) {} }
      } catch (_) {}
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch (_) {}
    }
  }
  if (!got) return { ok: false, error: 'lock_timeout', hint: '会话状态正被审查进程写入，请稍后重试' };
  const ownLock = () => { try { return fs.readFileSync(lock, 'utf8').trim() === myPid; } catch (_) { return false; } };
  try {
    if (!ownLock()) return { ok: false, error: 'lock_timeout', hint: '会话状态正被审查进程写入，请稍后重试' };
    let st;
    try {
      st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (_) {
      return { ok: false, error: 'state_unreadable', hint: '会话状态文件不可读（可能尚未生成）：' + stateFile };
    }
    if (!st || typeof st !== 'object') {
      return { ok: false, error: 'state_unreadable', hint: '会话状态文件内容异常：' + stateFile };
    }
    stripLegacySecrets(st);
    st.sessionProvider = wantProvider; // 空 = 该项 reset（恢复跟随全局）
    st.sessionModel = wantModel;
    const tmp = `${stateFile}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { ok: false, error: 'state_write_failed', hint: String(err && err.message || err).slice(0, 120) };
    }
    return { ok: true, sessionProvider: wantProvider, sessionModel: wantModel, sessionId: String(b.sessionId || '') };
  } finally {
    try { if (fs.readFileSync(lock, 'utf8').trim() === myPid) fs.unlinkSync(lock); } catch (_) {}
  }
}

// —— 本机 API ——
// CORS 放行任意来源：真正的访问控制是共享令牌（X-Advisor-Token，只存在于注入脚本
// 与 controller 内存中）。这样无论 ZCode 页面用 file:// 还是自定义协议都能访问面板 API。
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Advisor-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

// 端点归一化（与 hooks/lib/reviewer.js 的 normalizeChatEndpoint 保持同一规则）。
// 为什么这里也需要：配置面板的 placeholder 引导用户填 `https://…/v1` 这类基地址，
// 但早期实现直接 POST baseUrl —— 请求打到 `/v1` 本身，端点返回 404，
// 用户看到的是误导性的「模型 id 或端点路径不对」（实测复现）。
// 两处独立实现是刻意的：controller 与 hook 各自是独立进程，不共享模块加载路径；
// 规则若变更需同步修改（本地已有测试覆盖两端）。
function normalizeChatEndpoint(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  // 填的是 Anthropic 端点形态：换成 OpenAI 路径，不拼出不存在的 /messages/chat/completions
  if (/\/messages$/i.test(u)) return `${u.replace(/\/messages$/i, '')}/chat/completions`;
  return `${u}/chat/completions`;
}

// Anthropic 端点归一化（与 hooks/lib/reviewer.js 的 normalizeMessagesEndpoint 同规则）。
// 真机实测：ZCode 里 6 个 anthropic 服务商的 baseURL 都不含 /v1（api.z.ai/api/anthropic、
// open.bigmodel.cn/api/anthropic、内网 192.168.50.139:8088 …），真实路径是 + /v1/messages
//（探测：+ /v1/messages → 401 鉴权层；+ /messages → 404）。只有 baseURL 已含 /v1 时才只补 /messages。
function normalizeMessagesEndpoint(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/messages$/i.test(u)) return u;
  if (/\/chat\/completions$/i.test(u)) return `${u.replace(/\/chat\/completions$/i, '')}/messages`;
  if (/\/v\d+$/i.test(u)) return `${u}/messages`;
  return `${u}/v1/messages`;
}

// /v1/messages 必填头（缺失端点返回 400）
const ANTHROPIC_VERSION = '2023-06-01';

async function ping(body) {
  const t = effectiveTarget(body);
  // 服务商不可用时按审查侧同一语义失败，绝不把空端点替换成硬编码默认
  // （那会把服务商 key 发到别的端点——密钥交叉）。
  if (!t.providerUsable || !t.model) {
    const hints = {
      provider_missing: 'ZCode 里没有可用的第三方服务商（需 OpenAI 兼容或 Anthropic 协议且已填端点与 key）',
      provider_not_found: 'ZCode 配置里找不到所选服务商，请刷新列表或重新选择',
      provider_official: 'ZCode 官方内置通道不用于审查，请选择第三方服务商',
      provider_ineligible: '该服务商协议既非 OpenAI 兼容、也非 Anthropic，审查通道不可用',
      provider_incomplete: '服务商的端点/key 缺一，Ping 已中止',
      no_model: '该服务商未登记模型，请在 ZCode 设置里添加'
    };
    return { ok: false, error: t.providerError || 'provider_unusable', hint: hints[t.providerError] || '' };
  }
  // 协议分支（与 hook 侧 callReviewer 同一语义）：anthropic 服务商走 /v1/messages，
  // 头部用 x-api-key + anthropic-version（缺失 anthropic-version 端点直接 400），
  // system 走顶层字段。若这里仍按 OpenAI 发，用户会看到误导性的「模型 id 或端点路径不对」。
  const anthropic = t.protocol === 'anthropic';
  const baseUrl = anthropic ? normalizeMessagesEndpoint(t.baseUrl) : normalizeChatEndpoint(t.baseUrl);
  const model = t.model;
  const apiKey = t.apiKey;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try {
      r = await fetch(baseUrl, {
        method: 'POST',
        headers: anthropic
          ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        // 请求体两种协议在此处同形（model + 单条 user + max_tokens/temperature/stream）；
        // 差异全在头部与端点路径。
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, stream: false }),
        signal: ctl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const hint = r.status === 401 || r.status === 403 ? 'key 无效或无权限' : (r.status === 404 || r.status === 400 ? '模型 id 或端点路径不对' : '');
      return { ok: false, error: `llm_http_${r.status}`, hint, endpoint: baseUrl };
    }
    const note = '；响应体为空是 max_tokens=1 下的正常现象';
    return { ok: true, ms: Date.now() - t0, note, provider: t.providerName, model, protocol: t.protocol || 'openai' };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return { ok: false, error: aborted ? 'llm_timeout' : 'llm_error', hint: aborted ? '端点无响应（超时）' : '网络失败' };
  }
}

// 模型清单。两条路径：
// - 默认：ZCode 配置里该服务商的**登记清单**（页面展示即所配）；
// - body.zcodeFetch=true：绕过登记清单直接请求服务商端点 /models 拿实时全量
//   （背景：用户实测 8788 网关登记 2 个、端点实际 23 个，登记清单可能严重滞后）。
async function fetchModels(body) {
  const t = effectiveTarget(body);
  if (!t.providerUsable) {
    const hints = {
      provider_missing: 'ZCode 里没有可用的第三方服务商（需 OpenAI 兼容或 Anthropic 协议且已填端点与 key）',
      provider_not_found: 'ZCode 配置里找不到所选服务商，请刷新列表或重新选择',
      provider_official: 'ZCode 官方内置通道不用于审查，请选择第三方服务商',
      provider_ineligible: '该服务商协议既非 OpenAI 兼容、也非 Anthropic，审查通道不可用',
      provider_incomplete: '服务商的端点/key 缺一，无法拉取模型'
    };
    return { ok: false, error: t.providerError || 'provider_unusable', hint: hints[t.providerError] || '' };
  }
  if (body && body.zcodeFetch) {
    // anthropic 服务商的 baseURL 不含 /v1（见 normalizeMessagesEndpoint 的实测说明），
    // 其模型清单在 /v1/models（真机探测：/models → 404，/v1/models → 200）。
    // modelsUrl 只补 /models，这里按协议先归一到「含 /v1 的基地址」再交给它。
    const url = t.protocol === 'anthropic'
      ? modelsUrl(normalizeMessagesEndpoint(t.baseUrl).replace(/\/messages$/i, ''))
      : modelsUrl(t.baseUrl);
    if (!url) return { ok: false, error: 'baseUrl 为空' };
    let r;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      // /models 在两种协议下都存在，但鉴权头不同：anthropic 用 x-api-key（Bearer 会被拒）。
      const hdrs = t.protocol === 'anthropic'
        ? { 'x-api-key': t.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
        : { Authorization: `Bearer ${t.apiKey}` };
      r = await fetch(url, { headers: hdrs, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    try {
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? '服务商 key 无效' : '该端点可能不提供 /models';
        return { ok: false, error: `http_${r.status}`, hint };
      }
      const parsed = parseModels(await r.json());
      if (!parsed.ok && parsed.error === 'unexpected_envelope') parsed.hint = '响应信封无法识别';
      return parsed;
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
      return { ok: false, error: aborted ? 'models_timeout' : 'models_error', hint: '拉取失败：' + (err && err.message || err).slice(0, 80) };
    }
  }
  // 登记清单：当前选中项排前（多模型服务商不再只剩一项）
  const prov = pickZcodeProvider(t.providerId) || pickZcodeProvider(body && body.zcodeProvider);
  const all = (prov && prov.models) || [];
  if (!t.model && all.length === 0) return { ok: false, error: 'no_models', hint: '该服务商未配置模型，请在 ZCode 设置里添加，或点「从端点拉取」' };
  const models = t.model ? [t.model, ...all.filter((m) => m !== t.model)] : all.slice();
  return { ok: true, models, source: 'zcode', provider: t.providerName };
}

function startApi(cdpPort, apiPort, token) {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const done = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    // 完整配置面板（全局配置的 GUI 载体：API 来源/端点/key/模型/刷新/拉取/Ping/保存）。
    // 本身不含敏感数据、不校验令牌；页面 JS 从 URL hash 读令牌调 API——hash 不进
    // 服务器日志、不落 referer，令牌仍只在本机浏览器进程内流转。
    if (req.method === 'GET' && (req.url === '/panel' || req.url === '/panel/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PANEL_HTML);
      return;
    }
    // 共享令牌校验：令牌只存在于注入的页面脚本与 controller 内存中，
    // 防止本机其他网页（无令牌）驱动本接口改写配置。
    if ((req.headers['x-advisor-token'] || '') !== token) return done(403, { ok: false, error: 'bad_token' });

    const readBody = () => new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    });

    try {
      if (req.method === 'GET' && req.url === '/api/config') {
        const c = readUserConfig();
        const t = effectiveTarget({});
        return done(200, {
          ok: true,
          config: {
            // 全局审查目标（0.2.17）：服务商 + 模型。端点/key 来自服务商解析，不落配置。
            zcodeProvider: c.zcodeProvider || '',
            providerName: t.providerName,
            providerAuto: t.providerAuto,
            providerUsable: t.providerUsable,
            providerError: t.providerError || '',
            model: t.model || '',
            reviewMode: c.reviewMode || 'async',
            maxTokens: c.maxTokens || 4096,
            enabled: c.startEnabled !== false
          },
          cdpPort
        });
      }
      // ZCode 已维护的服务商列表（审查来源的数据源）。只回传 id/名称/协议/端点/模型清单——
      // apiKey 明文永不出进程。official 标记官方内置通道（审查不使用，面板置灰展示）。
      if (req.method === 'GET' && req.url === '/api/zcode-providers') {
        const providers = readZcodeProviders().map((p) => ({
          id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL,
          models: p.models, eligible: p.eligible, official: p.official, protocol: p.protocol, hasApiKey: Boolean(p.apiKey)
        }));
        return done(200, { ok: true, providers, file: zcodeConfigFile() });
      }
      if (req.method === 'POST' && req.url === '/api/config') {
        const body = await readBody();
        const r = saveUserConfig(body);
        // 锁超时必须以失败态呈现：保存不会「下次再补」，静默 ok:true 会让用户以为存上了。
        if (r && r.lockTimeout) {
          return done(503, { ok: false, error: '配置文件正被其他进程写入，请等几秒重试；若持续出现，删除 ~/.zcode/advisor.config.json.lock 后再试' });
        }
        return done(200, { ok: true, file: USER_CONFIG });
      }
      if (req.method === 'POST' && req.url === '/api/models') {
        const body = await readBody();
        return done(200, await fetchModels(body));
      }
      // 最近活动会话的快照（enabled / 会话级服务商与模型）：角标面板展示与开关初始态。
      // 注意归属语义：是「最近活动的会话」，不一定是用户正看着的那个（controller 无法
      // 感知焦点）；多会话并行时 UI 必须标注会话 id，避免把另一个会话的开关当自己的。
      if (req.method === 'GET' && req.url === '/api/session') {
        return done(200, readSessionSnapshot());
      }
      if (req.method === 'POST' && req.url === '/api/session-toggle') {
        const body = await readBody();
        return done(200, toggleSessionEnabled(body && body.enabled));
      }
      // 会话级审查目标（角标面板「本会话模型」）：provider/model 传空串 = 该项 reset 恢复全局。
      // 与 /advisor-model set|reset 同一落点（state.sessionProvider / state.sessionModel）。
      if (req.method === 'POST' && req.url === '/api/session-target') {
        const body = await readBody();
        return done(200, setSessionTarget(body && body.provider, body && body.model));
      }
      if (req.method === 'POST' && req.url === '/api/ping') {
        const body = await readBody();
        return done(200, await ping(body));
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        return done(200, { ok: true, attachedPages: attached.size, cdpPort });
      }
      // 顾问意见历史（issue #102 可见性）：读 JSONL 追加日志，新的在前
      if (req.method === 'GET' && req.url === '/api/history') {
        return done(200, { ok: true, history: readHistory(50), file: HISTORY_FILE });
      }
      // 健康态（M1）：读信标派生 ok/degraded/down/unknown，供顶部角标着色。
      // 无信标 = unknown（绝不回 ok）。预算算式与 hooks/lib/config.js 的归一/钳制保持一致：
      // sync 上限 300s、async 上限 600s——否则两侧 STALE 不同源，同一信标一侧判 ok、一侧判 unknown。
      if (req.method === 'GET' && req.url === '/api/health') {
        const c = readUserConfig();
        const rawTimeout = Number.isFinite(c.reviewTimeoutMs) && c.reviewTimeoutMs >= 1000 ? c.reviewTimeoutMs : 240000;
        const mode = c.reviewMode === 'sync' ? 'sync' : 'async';
        const timeoutMs = mode === 'sync'
          ? Math.min(rawTimeout, 300000)   // SYNC_TIMEOUT_CAP_MS，同 config.js
          : Math.min(rawTimeout, 600000);  // async 上界，同 config.js
        const reviewBudgetMs = mode === 'sync' ? timeoutMs : timeoutMs * 2;
        const h = readHealth(reviewBudgetMs);
        return done(200, {
          ok: true,
          state: h.state,
          beacon: h.beacon,
          candidates: h.candidates,
          dir: HEALTH_DIR,
          staleMs: staleThresholdMs(reviewBudgetMs)
        });
      }
      return done(404, { ok: false, error: 'not_found' });
    } catch (err) {
      return done(500, { ok: false, error: String(err).slice(0, 200) });
    }
  });
  server.on('error', (err) => {
    // 可重试：端口占用等瞬时冲突，重试通常能换到空闲端口（受监督时由 launchd 重启）。
    exitRetryable(1, `API 服务启动失败：${err && err.message}`);
  });
  server.listen(apiPort, '127.0.0.1', () => {
    log(`本机 API 就绪：http://127.0.0.1:${apiPort}/api/status`);
  });
  return server;
}

// 在 API_PORT_RANGE 内探测一个空闲端口（bind 预检，存在极小 TOCTOU 窗口，可接受）
function pickFreePort(port) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function pickApiPort() {
  for (let p = API_PORT_RANGE[0]; p <= API_PORT_RANGE[1]; p++) {
    if (await pickFreePort(p)) return p;
  }
  throw new Error(`API 端口 ${API_PORT_RANGE[0]}-${API_PORT_RANGE[1]} 全部占用`);
}

async function main() {
  // 版本守卫：依赖全局 WebSocket（Node 22+ 默认提供，v21 需 --experimental-websocket）。
  // 放在这里而非模块顶层，使 require（冒烟校验/单测）不受影响。
  if (typeof WebSocket !== 'function') {
    const major = parseInt(String(process.versions.node).split('.')[0], 10);
    // 永久性失败：升 Node 之前重试多少次都不会成功，受监督时必须 exit 0
    // （否则 launchd 每 30s 重启一个注定失败的进程，白白刷日志）。
    exitPermanent(1,
      `zcode-advisor companion 需要 Node 22 及以上（当前 ${process.versions.node}）。\n` +
      (major < 22 ? '原因：依赖全局 WebSocket，Node 21 需 --experimental-websocket，22 起默认提供。\n' : '') +
      '请升级 Node 后重试（审查 hook 本身仍只需 Node ≥ 18）。'
    );
  }

  // 已有健康实例在跑 → 本次让位。
  // 未受监督：exit 0（旧行为，双击启动器时静默让位，不弹窗、不打印）。
  // 受监督：必须退 3——否则 launchd 认为任务已完成、不再重启，而那个「已有实例」
  // 之后死掉就再没人把外挂拉起来（自启动形同虚设）。
  if (!acquireLock()) {
    exitRetryable(0, SUPERVISED ? '已有健康的 companion 实例在运行，本次让位（稍后重试以便接管）' : '');
  }
  injectSource = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  log('zcode-advisor 输入框角标外挂启动');

  // 插件自动启用（幂等）：通过 ZCode 官方 CLI 注册/安装/启用审查插件。
  // 这是「双击安装包后自动开启」的执行点——zip/tar.gz 用户没有安装器，
  // 靠这里在每次外挂启动时确保插件处于启用状态（失败只记日志，不阻断角标）。
  try {
    const autoEnable = path.join(__dirname, 'auto-enable.cjs');
    if (fs.existsSync(autoEnable)) {
      const env2 = Object.assign({}, process.env);
      delete env2.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(process.execPath, [autoEnable], { env: env2, timeout: 150000 });
      const out = String((r.stdout || '') + (r.stderr || '')).trim();
      for (const line of out.split('\n').filter((l) => l.includes('✓') || l.includes('✗'))) log(line.replace(/^.*\[(auto-enable)\] /, '[$1] '));
      if (r.status !== 0) log(`自动启用未完全成功（status=${r.status}），详见 ${LOG_FILE}`);
    }
  } catch (_) { /* 自动启用失败不阻断外挂 */ }

  const cdpPort = await ensureCdp();
  // 锁心跳：把「当前 CDP 端口」写进租约，证明服务可用（僵尸租约靠它被识别）。
  cdpPortRef.value = cdpPort;
  startLockHeartbeat(cdpPortRef);
  const apiPort = await pickApiPort();
  const token = crypto.randomBytes(16).toString('hex');
  // 角标固定位置：'composer'（输入框工具栏右侧）或 'topbar'（任务窗口上边）。
  // 通过 companion 配置的 anchorMode 下发（默认 composer），用户二选一改配置即可，无需改代码。
  const cfg = readCompanionConfig();
  const anchorMode = cfg.anchorMode === 'topbar' ? 'topbar' : 'composer';
  injectSource = injectSource
    .replace(/__API_PORT__/g, String(apiPort))
    .replace(/__TOKEN__/g, token)
    .replace(/__ANCHOR_MODE__/g, anchorMode);
  log(`角标位置：${anchorMode === 'topbar' ? '任务窗口上边' : '输入框工具栏右侧'}（可在 ${COMPANION_CONFIG} 用 "anchorMode" 切换）`);
  startApi(cdpPort, apiPort, token);
  log('每 3 秒全端口段重扫并保持角标注入（Ctrl+C 退出；与其他 CDP 外挂如 zcode-plus 可共存）');
  await rescan();
  setInterval(() => rescan(), POLL_INTERVAL_MS);
}

// 仅在被直接执行时启动；被 require（构建期冒烟校验、单测）时只加载模块。
if (require.main === module) {
  main().catch((err) => {
    console.error(`companion 异常退出：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { findZcodePath, normalizeChatEndpoint, normalizeMessagesEndpoint, ping, fetchModels, main, saveUserConfig, readHistory, resolveHistoryFile, readZcodeProviders, pickZcodeProvider, effectiveTarget, deriveHealth, staleThresholdMs, readHealth, HEALTH_DIR, startApi,
  readSessionSnapshot, toggleSessionEnabled, setSessionTarget,
  // 供单测直接验证单实例锁与主实例探测（不启动进程）
  _internal: { readLockInfo, isStale, writeLock, acquireLock, hostInstanceRunning, exitCodeFor, classifySpawnError, RETRY_EXIT_CODE, SUPERVISED, LOCK_FILE, LOCK_TTL_MS, LOCK_ZOMBIE_GRACE_MS } };
