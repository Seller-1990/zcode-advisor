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
  if (beacon.state === 'degraded') return 'degraded';
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

const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`;
  process.stdout.write(line + '\n');
  // 无窗口启动（vbs/nohup）时 stdout 不可见：同步落盘一份供排错（超 1MB 截断）。
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1e6) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskKey = (k) => { const s = String(k || ''); return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`; };

// —— 单实例锁：面板重复点击/多入口同时启动时只保留一个 controller ——
function acquireLock() {
  const lockFile = path.join(os.tmpdir(), 'zcode-advisor-companion.lock');
  try {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // 活着的实例 → 抛错前返回；不存在 → 走 stale 分支
      log(`已有 companion 实例在运行（pid ${pid}），本实例退出`);
      process.exit(0);
    }
  } catch (_) { /* 进程不存在或无锁文件：继续 */ }
  try {
    fs.writeFileSync(lockFile, String(process.pid));
    process.on('exit', () => {
      try {
        if (parseInt(fs.readFileSync(lockFile, 'utf8'), 10) === process.pid) fs.unlinkSync(lockFile);
      } catch (_) {}
    });
  } catch (_) {}
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
    for (const t of targets) {
      if (t.type === 'page' && t.webSocketDebuggerUrl) attachTarget(t);
    }
    return;
  }
  if (currentPort !== 0) {
    log('调试实例已消失（ZCode 被关闭/重启？），等待重新出现…');
    currentPort = 0;
  }
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
    console.error(missingHint(process.platform, COMPANION_CONFIG));
    process.exit(1);
  }
  log(`ZCode 可执行文件：${zcodePath}（来源：${found.source}）`);
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
    console.error(`调试端口 ${CDP_PORT_RANGE[0]}-${CDP_PORT_RANGE[1]} 全部占用`);
    process.exit(1);
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

  spawn(zcodePath, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    // macOS 上切到 app 的 MacOS 目录启动，与 zcode+ 的真机做法一致
    cwd: process.platform === 'darwin' ? path.dirname(zcodePath) : undefined,
    env: childEnv
  }).unref();
  const deadline = Date.now() + CDP_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portReachable(port)) {
      log('CDP 通道就绪');
      return port;
    }
    await sleep(700);
  }
  console.error('等待 CDP 通道超时。若 ZCode 已在运行（未带调试端口），请先完全退出 ZCode（含托盘），再运行本入口。');
  process.exit(1);
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
  for (const k of ['apiKey', 'model', 'baseUrl', 'reviewMode', 'maxTokens', 'startEnabled',
    'apiSource', 'zcodeProvider', 'zcodeModel']) {
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
    } else if (k === 'apiSource') {
      // API 获取方式只认 manual/zcode；切换到 zcode 时清掉手动字段由「只合并非空」语义自然保留，
      // 用户回切 manual 时原手动配置仍在。
      const s = String(v || '').trim().toLowerCase();
      if (s === 'manual' || s === 'zcode') allowed[k] = s;
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
    // 配置含明文 apiKey：目录 0700、文件 0600（与转录快照/意见历史同级）。
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

// —— ZCode 已维护的第三方 API（apiSource=zcode 的数据源）——
// 解析规则与 hooks/lib/config.js 的 readZcodeProviders 同源：provider.<id> =
// { name, kind, options: { baseURL, apiKey }, models: {...} }。独立实现是刻意的：
// companion 发行包只有本目录四个文件（无 hooks/），跨目录 require 会静默失效
// （与上方 readHistory 的先例同一理由）；规则若变更需两侧同步（测试锁住字段名）。
function zcodeConfigFile() {
  return process.env.ZCODE_ADVISOR_ZCODE_CONFIG
    || path.join(HOME, '.zcode', 'v2', 'config.json');
}

function readZcodeProviders() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(zcodeConfigFile(), 'utf8')); } catch (_) { return []; }
  const map = raw && raw.provider && typeof raw.provider === 'object' ? raw.provider : {};
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
      eligible: p.kind === 'openai' || p.kind === 'openai-compatible'
    });
  }
  return out;
}

function pickZcodeProvider(want) {
  const w = String(want || '').trim();
  if (!w) return null;
  const all = readZcodeProviders();
  return all.find((p) => p.id === w) || all.find((p) => p.name && p.name === w) || null;
}

// 把面板保存载荷/已存配置解析为一次真实调用的 {baseUrl, apiKey, model}。
// manual：与旧逻辑一致，body 优先、已存配置兜底；zcode：从 ZCode provider 现读，
// key 不出进程——页面只需要模型/端点展示，永远拿不到 apiKey 明文。
function effectiveTarget(body) {
  const cfg = readUserConfig();
  const b = body || {};
  const apiSource = String(b.apiSource || cfg.apiSource || 'manual').trim().toLowerCase();
  if (apiSource !== 'zcode') {
    return {
      apiSource: 'manual',
      baseUrl: String(b.baseUrl || cfg.baseUrl || '').trim(),
      apiKey: String(b.apiKey || cfg.apiKey || '').trim(),
      model: String(b.model || cfg.model || '').trim()
    };
  }
  const prov = pickZcodeProvider(b.zcodeProvider || cfg.zcodeProvider || '');
  const model = String(b.zcodeModel || cfg.zcodeModel || (prov && prov.models[0]) || '').trim();
  // 与审查侧 applyZcodeSource 同一规则：provider 缺失/非 OpenAI 兼容/端点或 key
  // 缺一 → 不产出任何凭据（调用方按 error 字段失败返回）。否则 Ping 用一组、
  // 审查用另一组，或把手动 key 发往服务商端点（密钥交叉）。
  const usable = Boolean(prov && prov.eligible && prov.baseURL && prov.apiKey);
  const reason = !prov ? 'provider_missing'
    : (!prov.eligible ? 'provider_ineligible'
      : (!prov.baseURL || !prov.apiKey ? 'provider_incomplete' : ''));
  return {
    apiSource: 'zcode',
    baseUrl: usable ? prov.baseURL : '',
    apiKey: usable ? prov.apiKey : '',
    model,
    providerName: prov ? (prov.name || prov.id) : '',
    providerFound: Boolean(prov),
    providerUsable: usable,
    providerError: reason || ''
  };
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
  if (/\/messages$/i.test(u)) return u;   // Anthropic 协议端点不改写
  return `${u}/chat/completions`;
}

async function ping(body) {
  const t = effectiveTarget(body);
  // zcode 模式 provider 不可用时按审查侧同一语义失败，绝不把空端点替换成
  // 硬编码默认（那会把服务商 key 发到智谱官方端点）。
  if (t.apiSource === 'zcode' && !t.providerUsable) {
    const hints = {
      provider_missing: 'ZCode 配置里找不到所选服务商，请重新选择',
      provider_ineligible: '该服务商协议非 OpenAI 兼容，审查通道不可用',
      provider_incomplete: 'provider 的 baseURL/apiKey 缺一，为避免密钥与端点交叉使用，Ping 已中止'
    };
    return { ok: false, error: t.providerError, hint: hints[t.providerError] || '' };
  }
  const baseUrl = normalizeChatEndpoint(t.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  const model = t.model || 'glm-5.3-flash';
  const apiKey = t.apiKey || '';
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try {
      r = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
    return { ok: true, ms: Date.now() - t0, note };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return { ok: false, error: aborted ? 'llm_timeout' : 'llm_error', hint: aborted ? '端点无响应（超时）' : '网络失败' };
  }
}

async function fetchModels(body) {
  const t = effectiveTarget(body);
  // zcode 模式：模型列表直接来自 ZCode provider 数据，无需请求端点 /models。
  if (t.apiSource === 'zcode') {
    if (!t.providerUsable) {
      const hints = {
        provider_missing: 'ZCode 配置里找不到所选服务商，请重新选择',
        provider_ineligible: '该服务商协议非 OpenAI 兼容，审查通道不可用',
        provider_incomplete: 'provider 的 baseURL/apiKey 缺一，已按审查侧同一规则中止'
      };
      return { ok: false, error: t.providerError, hint: hints[t.providerError] || '' };
    }
    if (!t.model) return { ok: false, error: 'no_models', hint: '该服务商未配置模型，请在 ZCode 设置里添加' };
    // 整表返回（当前选中项排前）：多模型服务商不再只剩一项
    const prov = pickZcodeProvider(body && (body.zcodeProvider || readUserConfig().zcodeProvider) || '');
    const all = (prov && prov.models) || [];
    const models = [t.model, ...all.filter((m) => m !== t.model)];
    return { ok: true, models, source: 'zcode' };
  }
  const url = modelsUrl(t.baseUrl);
  if (!url) return { ok: false, error: 'baseUrl 为空' };
  let r;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    r = await fetch(url, { headers: { Authorization: `Bearer ${t.apiKey}` }, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  try {
    if (!r.ok) {
      const hint = r.status === 401 || r.status === 403 ? 'key 无效' : '该端点可能不提供 /models，请手动输入模型 id';
      return { ok: false, error: `http_${r.status}`, hint };
    }
    const parsed = parseModels(await r.json());
    if (!parsed.ok && parsed.error === 'unexpected_envelope') parsed.hint = '响应信封无法识别，请手动输入模型 id';
    return parsed;
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return { ok: false, error: aborted ? 'models_timeout' : 'models_error', hint: '拉取失败，请手动输入模型 id' };
  }
}

function startApi(cdpPort, apiPort, token) {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const done = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
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
        return done(200, {
          ok: true,
          config: {
            model: c.model || '', baseUrl: c.baseUrl || '', reviewMode: c.reviewMode || 'async',
            maxTokens: c.maxTokens || 4096, keyMasked: c.apiKey ? maskKey(c.apiKey) : '（未设置）',
            enabled: c.startEnabled !== false,
            apiSource: c.apiSource === 'zcode' ? 'zcode' : 'manual',
            zcodeProvider: c.zcodeProvider || '', zcodeModel: c.zcodeModel || ''
          },
          cdpPort
        });
      }
      // ZCode 已维护的第三方 API 列表（apiSource=zcode 的选择数据源）。
      // 只回传 id/名称/协议/端点/模型清单——apiKey 明文永不出进程。
      if (req.method === 'GET' && req.url === '/api/zcode-providers') {
        const providers = readZcodeProviders().map((p) => ({
          id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL,
          models: p.models, eligible: p.eligible, hasApiKey: Boolean(p.apiKey)
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
    console.error(`API 服务启动失败：${err && err.message}`);
    process.exit(1);
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
    console.error(
      `zcode-advisor companion 需要 Node 22 及以上（当前 ${process.versions.node}）。\n` +
      (major < 22 ? '原因：依赖全局 WebSocket，Node 21 需 --experimental-websocket，22 起默认提供。\n' : '') +
      '请升级 Node 后重试（审查 hook 本身仍只需 Node ≥ 18）。'
    );
    process.exit(1);
  }

  acquireLock();
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

module.exports = { findZcodePath, normalizeChatEndpoint, main, saveUserConfig, readHistory, resolveHistoryFile, readZcodeProviders, effectiveTarget, deriveHealth, staleThresholdMs, readHealth, HEALTH_DIR, startApi };
