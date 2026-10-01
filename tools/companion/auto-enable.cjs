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
function acquireSingleFlight() {
  const lockDir = path.join(os.homedir(), '.zcode', 'advisor-auto-enable.lock');
  const info = path.join(lockDir, 'info');
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    fs.writeFileSync(info, `pid=${process.pid}\nstarted=${Date.now()}\n`, 'utf8');
    return { lockDir, acquired: true };
  } catch (_) {
    // 锁已存在：判断持锁进程是否还活着
    let pid = '';
    try { pid = (/(?:^|\n)pid=(\d+)/.exec(fs.readFileSync(info, 'utf8')) || [])[1] || ''; } catch (_) {}
    const alive = pid && (() => { try { process.kill(Number(pid), 0); return true; } catch (_) { return false; } })();
    if (alive) return { lockDir, acquired: false, holder: pid };
    // 陈旧锁（崩溃/被 kill）：接管
    try {
      fs.writeFileSync(info, `pid=${process.pid}\nstarted=${Date.now()}\n`, 'utf8');
      return { lockDir, acquired: true, stale: true };
    } catch (_) {
      return { lockDir, acquired: false, holder: pid };
    }
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
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-5.3-flash',
        apiKey: ''
      }, null, 2) + '\n', 'utf8');
      log(`✓ 已生成用户级配置：${cfg}（请在设置面板填 API key）`);
    } catch (_) {}
  }

  log('✓ 插件已注册、安装并启用——新开 ZCode 会话即自动挂载审查');
  return 0;
}

process.exitCode = main();
