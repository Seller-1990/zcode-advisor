#!/usr/bin/env node
'use strict';

// 插件自动启用（独立脚本，供安装器与 controller 调用）。
//
// 目的：满足「双击安装包安装后，打开 ZCode 插件即自动开启」——
// 安装器（NSIS ExecWait / install.sh / controller 启动）调用本脚本，
// 通过 ZCode **官方 CLI**（plugins marketplace add|install|enable）完成
// 注册/安装/启用，不修改宿主私有数据文件。
//
// 幂等：可重复运行（CLI 对已注册/已安装/已启用是幂等提示）。
// 失败不抛出：退出码非 0 并打印原因，由调用方决定是否提示用户。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LOG = process.env.ZCODE_ADVISOR_COMPANION_LOG
  || path.join(os.homedir(), '.zcode', 'advisor-companion.log');

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [auto-enable] ${a.join(' ')}`;
  // **只写一份**：调用方（.app 启动器 / controller / NSIS）通常已把 stdout
  // 重定向到同一 LOG，若这里再写 stdout 会与文件写冲突造成每行重复
  // （实测：日志中每条 auto-enable 记录都出现两次）。
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch (_) {
    // 日志不可写时退到 stderr（调用方通常也重定向了），不影响主流程
    try { process.stderr.write(line + '\n'); } catch (_) {}
  }
}

// ── 1) 定位插件市场目录（含 .claude-plugin/marketplace.json）──
// 候选与 controller 的运行布局一一对应：
//   Windows 安装布局：$INSTDIR\auto-enable.cjs + $INSTDIR\plugin\
//   macOS .app 布局：Resources\auto-enable.cjs + Resources\plugin\
//   仓库工作树：tools/companion + 仓库根（即市场根）
function findPluginPayload() {
  const candidates = [
    path.join(__dirname, 'plugin'),
    path.join(__dirname, '..', 'plugin'),
    path.join(__dirname, '..', '..')
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return dir;
    } catch (_) {}
  }
  return null;
}

// ── 2) 定位 ZCode 与其 CLI ──
// 复用 zcode-path.cjs 的探测（与 controller 同一份候选链），
// CLI 位于 <ZCode 安装目录>/Resources/glm/zcode.cjs（mac 实测；Windows 同构布局）。
function findZcodeCli() {
  try {
    const zp = require('./zcode-path.cjs');
    // **必须传 deps**：detectZcodePath 通过注入的 fs/statSync/readFileSync 判定
    // 「可执行文件是否存在」。不传时 isRunnableFile 恒为 false，
    // 整条探测链静默返回空 → 自动启用失效（真机测试发现：干净机器上 .app
    // 日志只有"未找到 ZCode CLI"，而本机 /Applications/ZCode.app 明明存在）。
    const found = zp.detectZcodePath({
      platform: process.platform,
      env: process.env,
      config: {},
      deps: {
        fs, path, os,
        existsSync: fs.existsSync,
        statSync: fs.statSync,
        readFileSync: fs.readFileSync,
        homedir: os.homedir
      }
    });
    if (!found || !found.path) return null;
    // found.path 可能是 .app 内部可执行（macOS：<app>/Contents/MacOS/ZCode）
    // 或 Windows 的 ZCode.exe。CLI 相对它上溯 1~3 层尝试。
    const exeDir = path.dirname(found.path);
    const candidates = [
      path.join(exeDir, '..', 'Resources', 'glm', 'zcode.cjs'),            // mac：Contents/Resources
      path.join(exeDir, 'resources', 'glm', 'zcode.cjs'),                  // win 常见：安装目录\resources
      path.join(exeDir, '..', 'resources', 'glm', 'zcode.cjs'),            // win 变体
      path.join(exeDir, 'glm', 'zcode.cjs')                                // 兜底
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    log(`已找到 ZCode（${found.path}）但其 CLI（zcode.cjs）未在预期位置`);
    return null;
  } catch (_) {
    return null;
  }
}

// ── 3) 通过官方 CLI 注册/安装/启用 ──
// ── 单飞锁（single-flight）──
// 两个调用点会在同一次启动中**并行**跑到这里：
//   ① .app 启动器（packagers.cjs 的 MAC_APP_LAUNCHER）
//   ② controller 启动时（controller.cjs 的自动启用）
// 实测 11:08:45（启动器）与 11:08:50（controller）各跑了一套
// marketplace add/update + install + enable —— 并发的 install/enable
// 在干净机器上可能互相踩（同一个缓存目录被两个进程同时改写）。
// 用 mkdir 原子锁保证只跑一套；后来者看到锁直接退出（0 = 净结果已达成）。
//
// 两个已知隐患（代码评审指出，均已处理）：
// ① **接管必须原子**：陈旧锁的"改写 info"若用普通 writeFileSync，两个进程同时
//    判定陈旧时会都以为自己接管成功，于是并发跑 CLI（正是锁要防的事）。
//    做法：各自写**唯一临时文件**，再 rename 到 info——rename 在同一文件系统内
//    原子，只有一个能成功，成功者回读确认 pid 是自己后才算持锁。
// ② **不能只看 pid 存活**：pid 会被系统复用，`kill(pid,0)` 命中无关进程时
//    会误判"持锁者仍在运行"→ 每次启动都跳过 → 干净机器上插件**永远装不上
//    且无重试**。因此加 **TTL**：持锁超过 LOCK_TTL_MS 一律视为陈旧（正常一次
//    启用只需数秒），并把 pid 存活仅作为辅助判断。
//    （另有 zcode-advisor 自检：TTL 远大于单次启用耗时，不会误杀正常持锁。）
const LOCK_TTL_MS = 5 * 60 * 1000;   // 5 分钟：单次启用只需数秒，超时必属异常

function readLockInfo(info) {
  try {
    const txt = fs.readFileSync(info, 'utf8');
    return {
      pid: Number(((/(?:^|\n)pid=(\d+)/.exec(txt) || [])[1]) || 0),
      started: Number(((/(?:^|\n)started=(\d+)/.exec(txt) || [])[1]) || 0)
    };
  } catch (_) {
    return { pid: 0, started: 0 };
  }
}

// 判断锁是否陈旧：无有效 started → 陈旧；超过 TTL → 陈旧；
// 仅当 pid 存活**且**未超时才认为有效（避免 pid 复用造成永久阻塞）。
function isStale(info) {
  const now = Date.now();
  if (!info.started) return true;
  if (now - info.started > LOCK_TTL_MS) return true;
  if (!info.pid) return true;
  // 注意 errno 语义（实测）：kill(pid,0) 对**存在但无权限**的进程抛 EPERM，
  // 只有 ESRCH 才代表进程不存在。早期实现把任何异常都当"已死"，
  // 会把存活的持锁者误判为陈旧而接管（并发风险）。
  try {
    process.kill(info.pid, 0);
    return false;                       // 存活
  } catch (err) {
    if (err && err.code === 'EPERM') return false;   // 存在，只是无权限
    return true;                        // ESRCH 等 → 不存在
  }
}

// 原子接管：写唯一临时文件 → rename 覆盖 info → 回读确认是自己的 pid。
// rename 在同一文件系统原子；两个竞争者只有一个的 rename 最终可见，
// 且各自回读能识别"被对方覆盖"从而放弃。
function tryTakeOver(lockDir, info) {
  const tmp = `${info}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `pid=${process.pid}\nstarted=${Date.now()}\n`, 'utf8');
    fs.renameSync(tmp, info);
    const back = readLockInfo(info);
    if (back.pid === process.pid) return true;
    return false;   // 被其他进程覆盖，让给它
  } catch (_) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return false;
  }
}

function acquireSingleFlight() {
  const lockDir = path.join(os.homedir(), '.zcode', 'advisor-auto-enable.lock');
  const info = path.join(lockDir, 'info');
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    fs.writeFileSync(info, `pid=${process.pid}\nstarted=${Date.now()}\n`, 'utf8');
    return { lockDir, acquired: true };
  } catch (_) {
    const cur = readLockInfo(info);
    if (!isStale(cur)) return { lockDir, acquired: false, holder: String(cur.pid || '') };
    // 陈旧：原子接管（只有一个进程能成功）
    if (tryTakeOver(lockDir, info)) return { lockDir, acquired: true, stale: true };
    const after = readLockInfo(info);
    return { lockDir, acquired: false, holder: String(after.pid || '') };
  }
}

function main() {
  if (process.env.ZCODE_ADVISOR_NO_AUTO_ENABLE === '1') {
    log('ZCODE_ADVISOR_NO_AUTO_ENABLE=1，跳过自动启用');
    return 0;
  }

  // 单飞：另一个实例正在跑就不重复执行（0 = 结果由它达成）
  const flight = acquireSingleFlight();
  if (!flight.acquired) {
    log(`已有自动启用实例在运行（pid ${flight.holder || '未知'}），本次跳过以免并发踩踏`);
    return 0;
  }
  if (flight.stale) log('发现陈旧自动启用锁（持锁进程已退出），接管');
  const releaseFlight = () => { try { fs.rmSync(flight.lockDir, { recursive: true, force: true }); } catch (_) {} };
  process.on('exit', releaseFlight);

  try {
    return runEnable();
  } finally {
    releaseFlight();
  }
}

// 幂等快路径：若插件已启用且缓存版本与包内一致，则无需跑完整的
// marketplace add/update + install + enable（四次 CLI 调用，数秒）。
// 为什么需要：单飞锁只能防**并发**，防不了**串行重复**——
// .app 启动器先跑完（约 5 秒）并释放锁，controller 稍后才启动，
// 于是又完整跑一遍（实测日志 11:16:12 与 11:16:17 各一套）。
// 这既浪费几秒，也会无谓改写宿主缓存目录。
// 语义：确保「至少 payload 这个版本」被安装启用，**绝不降级**。
//
// 为什么要有「不降级」：.app 内嵌的是**打包时**的插件快照。用户从仓库装了更新的
// 版本（如 0.2.11）后，只要点一次旧 .app（内嵌 0.2.9），旧实现就会
// marketplace add(.app/plugin) → update → install，把市场源改指 .app 并把 0.2.9
// 装回去，之后 payload 与已装都是 0.2.9、走幂等快路径，**新版本被永久钉死**。
// （实测故障：0.2.11 的 P0 修复与 UI 改动全部失效，用户看到的是旧界面。）
// 因此这里只认「已装 >= payload」为已就绪；只有真正升级时才动 marketplace。
function parseSemver(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;   // 任一不可解析 → 视为相等（保守：走原逻辑）
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

// 纯决策：给定 `plugins list` 输出与包内版本，判断是否已就绪（可跳过安装）。
// 抽成纯函数是为了能直接单测——「不降级」这条判据一旦写错，用户新装的版本会被
// 旧 .app 反复覆盖回快照版本（真机故障），必须有测试锁住。
function isReadyFromList(out, pkgVersion) {
  if (!/zcode-advisor@\S+\s+\[enabled\]/.test(out)) return false;
  if (!pkgVersion) return true;
  // 已装版本从 cache 路径解析：`…/zcode-advisor/<ver>`
  const installed = ((/zcode-advisor\/(\d+\.\d+\.\d+)/.exec(out) || [])[1]) || '';
  if (installed) return cmpSemver(installed, pkgVersion) >= 0;  // 已装 >= 包内 → 就绪（不降级）
  return out.includes(`zcode-advisor/${pkgVersion}`);           // 解析不出 → 退回精确匹配
}

function alreadyEnabled(cli, nodeBin, payload) {
  try {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const out = execFileSync(nodeBin, [cli, 'plugins', 'list'], {
      encoding: 'utf8', timeout: 60000, env
    });
    // 版本也要一致：包升级后必须重装，否则仍跑旧代码
    let pkgVersion = '';
    try {
      pkgVersion = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version || '';
    } catch (_) {}
    const ready = isReadyFromList(out, pkgVersion);
    if (ready && pkgVersion && !out.includes(`zcode-advisor/${pkgVersion}`)) {
      log(`已装版本不低于包内 ${pkgVersion}——跳过（不降级）`);
    }
    return ready;
  } catch (_) {
    return false;
  }
}

// 实际的启用流程（由 main 在持有单飞锁后调用）
function runEnable() {
  const payload = findPluginPayload();
  if (!payload) {
    log('未找到插件市场目录（.claude-plugin/marketplace.json）——跳过自动启用');
    return 1;
  }

  const cli = findZcodeCli();
  if (!cli) {
    log('未找到 ZCode CLI（zcode.cjs）——跳过自动启用（可在 ZCode 内手动安装插件）');
    return 1;
  }

  // 运行 CLI 的 node：安装器/controller 传入的进程即合适的 node（可能是内嵌运行时）
  const nodeBin = process.execPath;

  // 幂等快路径：已启用且版本一致 → 直接返回（避免串行重复跑完整流程）
  if (alreadyEnabled(cli, nodeBin, payload)) {
    log('插件已启用且版本一致，跳过（幂等快路径）');
    return 0;
  }

  log(`插件市场：${payload}`);
  log(`ZCode CLI：${cli}`);

  const steps = [
    ['plugins', 'marketplace', 'add', payload],
    // 必须 update：宿主把市场内容快照到自己的缓存目录，install 从快照拷贝。
    // 不 update 会装出旧代码（实测踩过：修复未进入宿主 cache，顾问仍空转）。
    ['plugins', 'marketplace', 'update', 'zcode-advisor-local'],
    ['plugins', 'install', 'zcode-advisor'],
    ['plugins', 'enable', 'zcode-advisor']
  ];
  for (const args of steps) {
    try {
      // 剥离 ELECTRON_RUN_AS_NODE：否则宿主包装器被当作 Node 解释器（报 bad option）
      const env = Object.assign({}, process.env);
      delete env.ELECTRON_RUN_AS_NODE;
      execFileSync(nodeBin, [cli, ...args], { stdio: 'ignore', timeout: 120000, env });
      log(`✓ ${args.join(' ')}`);
    } catch (err) {
      const detail = String((err && err.stderr) || err && err.message || err).slice(0, 160);
      log(`✗ 步骤失败（${args.join(' ')}）：${detail}`);
      return 1;
    }
  }

  // 用户级配置模板（若尚无）——保证首次审查即可用
  const cfg = process.env.ZCODE_ADVISOR_USER_CONFIG
    || path.join(os.homedir(), '.zcode', 'advisor.config.json');
  if (!fs.existsSync(cfg)) {
    try {
      fs.mkdirSync(path.dirname(cfg), { recursive: true, mode: 0o700 });
      // 'wx'：existsSync 检查与写入之间有窗口，被并发创建时放弃（避免整文件覆盖）；
      // 0600：该文件随后会由面板写入 API key，初始权限就不放宽。
      fs.writeFileSync(cfg, JSON.stringify({
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-5.3-flash',
        apiKey: ''
      }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      log(`✓ 已生成用户级配置：${cfg}（请在设置面板填 API key）`);
    } catch (_) {}
  }

  log('✓ 插件已注册、安装并启用——新开 ZCode 会话即自动挂载审查');
  return 0;
}

// 只在被直接执行时跑主流程；被 require（单测）时只加载函数。
// 早期是无条件 `process.exitCode = main()`——require 会真的去跑 CLI 安装流程。
if (require.main === module) process.exitCode = main();

// 供单测验证「不降级」判据（避免真跑 CLI）
module.exports = { cmpSemver, parseSemver, alreadyEnabled, isReadyFromList, findPluginPayload };
