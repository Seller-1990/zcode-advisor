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
const { spawn } = require('child_process');
const { modelsUrl, parseModels } = require('./lib.cjs');

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

function detectZcodePath() {
  const cfg = readCompanionConfig();
  const candidates = [
    process.env.ZCODE_ADVISOR_ZCODE_PATH,
    cfg.zcodePath,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe'),
    'C:\\Program Files\\ZCode\\ZCode.exe',
    'C:\\Program Files (x86)\\ZCode\\ZCode.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return '';
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
const attached = new Map(); // targetId -> WebSocket
let injectSource = '';

function injectInto(ws) {
  try {
    ws.send(JSON.stringify({ id: Date.now() % 1e7, method: 'Runtime.evaluate', params: { expression: injectSource, returnByValue: false, userGesture: true } }));
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
      injectInto(ws);
    } catch (_) {}
  });
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.method === 'Page.loadEventFired') injectInto(ws); // 刷新后重注入
    } catch (_) {}
  });
  ws.addEventListener('close', () => attached.delete(target.id));
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
  const zcodePath = detectZcodePath();
  if (!zcodePath) {
    console.error('未找到 ZCode.exe。请在 ' + COMPANION_CONFIG + ' 中填写：\n  { "zcodePath": "C:/Users/<你>/AppData/Local/Programs/ZCode/ZCode.exe" }');
    process.exit(1);
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
    console.error(`调试端口 ${CDP_PORT_RANGE[0]}-${CDP_PORT_RANGE[1]} 全部占用`);
    process.exit(1);
  }
  log(`以调试端口 ${port} 启动 ZCode：${zcodePath}`);
  spawn(zcodePath, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
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

function saveUserConfig(patch) {
  const allowed = {};
  for (const k of ['apiKey', 'model', 'baseUrl', 'reviewMode', 'maxTokens']) {
    const v = patch[k];
    if (k === 'maxTokens') {
      const mt = parseInt(v, 10);
      if (Number.isFinite(mt) && mt >= 64 && mt <= 16384) allowed[k] = mt;
    } else if (typeof v === 'string' && v.trim() && !/^\$\{/.test(v)) {
      allowed[k] = v.trim();
    }
  }
  const merged = Object.assign({}, readUserConfig(), allowed);
  fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
  const tmp = `${USER_CONFIG}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, USER_CONFIG);
  return merged;
}

// —— 本机 API ——
// CORS 放行任意来源：真正的访问控制是共享令牌（X-Advisor-Token，只存在于注入脚本
// 与 controller 内存中）。这样无论 ZCode 页面用 file:// 还是自定义协议都能访问面板 API。
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Advisor-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

async function ping(body) {
  const cfg = readUserConfig();
  const baseUrl = body.baseUrl || cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const model = body.model || cfg.model || 'glm-5.3-flash';
  const apiKey = body.apiKey || cfg.apiKey || '';
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, stream: false }),
      signal: ctl.signal
    });
    clearTimeout(t);
    if (!r.ok) {
      const hint = r.status === 401 || r.status === 403 ? 'key 无效或无权限' : (r.status === 404 || r.status === 400 ? '模型 id 或端点路径不对' : '');
      return { ok: false, error: `llm_http_${r.status}`, hint };
    }
    const note = '；响应体为空是 max_tokens=1 下的正常现象';
    return { ok: true, ms: Date.now() - t0, note };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return { ok: false, error: aborted ? 'llm_timeout' : 'llm_error', hint: aborted ? '端点无响应（超时）' : '网络失败' };
  }
}

async function fetchModels(body) {
  const cfg = readUserConfig();
  const baseUrl = body.baseUrl || cfg.baseUrl || '';
  const apiKey = body.apiKey || cfg.apiKey || '';
  const url = modelsUrl(baseUrl);
  if (!url) return { ok: false, error: 'baseUrl 为空' };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
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
            maxTokens: c.maxTokens || 2048, keyMasked: c.apiKey ? maskKey(c.apiKey) : '（未设置）'
          },
          cdpPort
        });
      }
      if (req.method === 'POST' && req.url === '/api/config') {
        const body = await readBody();
        saveUserConfig(body);
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
  acquireLock();
  injectSource = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  log('zcode-advisor 输入框角标外挂启动');
  const cdpPort = await ensureCdp();
  const apiPort = await pickApiPort();
  const token = crypto.randomBytes(16).toString('hex');
  injectSource = injectSource.replace(/__API_PORT__/g, String(apiPort)).replace(/__TOKEN__/g, token);
  startApi(cdpPort, apiPort, token);
  log('每 3 秒全端口段重扫并保持角标注入（Ctrl+C 退出；与其他 CDP 外挂如 zcode-plus 可共存）');
  await rescan();
  setInterval(() => rescan(), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error(`companion 异常退出：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
