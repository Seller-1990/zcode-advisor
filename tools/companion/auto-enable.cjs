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
  try { process.stdout.write(line + '\n'); } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch (_) {}
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
    const found = zp.detectZcodePath({ platform: process.platform, env: process.env, config: {} });
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
function main() {
  if (process.env.ZCODE_ADVISOR_NO_AUTO_ENABLE === '1') {
    log('ZCODE_ADVISOR_NO_AUTO_ENABLE=1，跳过自动启用');
    return 0;
  }

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
