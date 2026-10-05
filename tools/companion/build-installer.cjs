#!/usr/bin/env node
'use strict';

// 发行包构建脚本（零第三方依赖，macOS 与 Windows 均可运行）。
//
// 产物（dist/）：
//   ZCodeAdvisor-<ver>-win-x64.zip           绿色包（内含 install.cmd，创建桌面/开始菜单图标）
//   ZCodeAdvisor-<ver>-macos-<arch>.tar.gz   install.sh 生成 ~/Applications/ZCode Advisor.app
//
// 用法：
//   node tools/companion/build-installer.cjs [--mac-arch=x64|arm64|both] [--skip-win] [--skip-mac]
//                                            [--no-embed-node]
//
// 与旧版的关键差异：归档不再调用 `powershell Compress-Archive` 或 `SystemRoot\System32\tar.exe`
// （这两条路径在 macOS 上不存在，实测 powershell ENOENT），改为 tools/companion/archive.cjs
// 的自研 ZIP/TAR 实现；构建完成后用系统 `unzip` / `tar` 反向校验产物。
//
// 内嵌 Node：从 nodejs.org 下载官方发行包并抽出二进制。
//   注意：受限网络下 nodejs.org 可能直连不通，需设置代理环境变量，例如
//     export https_proxy=http://127.0.0.1:7897
//   并在本脚本前加 NODE_USE_ENV_PROXY=1（Node ≥ 22）或改用 NODE_DIST_MIRROR 指向可达镜像。
//
// 杀软友好纪律（不得回退）：不做自解压 setup.exe、不改进程名、不做隐藏启动。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ROOT, VERSION, COMPANION_FILES } = require('./build-meta.cjs');
const { buildZip, buildTarGz, readZipEntries, readTarGz, extractFromTarGz, extractFromZip } = require('./archive.cjs');
const { makeIco, makeIcns } = require('./icon.cjs');
const P = require('./packagers.cjs');
const T = require('./install-templates.cjs');

const DIST = path.join(ROOT, 'dist');
const COMPANION_DIR = path.join(ROOT, 'tools', 'companion');
const NODE_DIST_MIRROR = (process.env.NODE_DIST_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '');
const NODE_EMBED_VERSION = process.env.NODE_EMBED_VERSION || null;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------- 参数 ----------------

function parseArgs(argv) {
  const opts = {
    macArch: process.arch === 'arm64' ? 'arm64' : 'x64',
    skipWin: false, skipMac: false, embedNode: true,
    installer: true // 额外产出 NSIS setup.exe 与 DMG（工具不可用时自动跳过并说明）
  };
  for (const a of argv) {
    if (a.startsWith('--mac-arch=')) {
      const v = a.split('=')[1];
      if (!['x64', 'arm64', 'both'].includes(v)) throw new Error(`--mac-arch 只支持 x64|arm64|both，收到：${v}`);
      opts.macArch = v;
    } else if (a === '--skip-win') opts.skipWin = true;
    else if (a === '--skip-mac') opts.skipMac = true;
    else if (a === '--no-embed-node') opts.embedNode = false;
    else if (a === '--no-installer') opts.installer = false;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

const log = (...a) => console.log('[build]', ...a);
const warn = (...a) => console.warn('[build][警告]', ...a);

// ---------------- 工具 ----------------

function stageDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

// 把「插件 payload」（.zcode-plugin/hooks/commands 等）递归写入 dest/plugin/。
// 安装器会在安装后/首次启动时调用 auto-enable.cjs，通过 ZCode 官方 CLI 注册并启用——
// 这是「双击安装包后自动开启」的载体：没有这份 payload，安装器无从安装插件本体。
function stagePluginPayload(dest) {
  const payloadRoot = path.join(dest, 'plugin');
  // **必须与 .zcode-plugin/plugin.json 的声明一致**：mcpServers 声明 config-bridge 从
  // ${CLAUDE_PLUGIN_ROOT}/tools/config-bridge.js 启动，缺 tools/ 则设置表单桥接失效
  // （仓库内副本已修，payload 这一份曾漏修——同一 bug 的第二份拷贝）。
  const items = [
    '.zcode-plugin', '.claude-plugin', 'hooks', 'commands', 'tools',
    'package.json', 'README.md', 'advisor.config.example.json'
  ];
  for (const item of items) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(payloadRoot, item);
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
  // **改写 marketplace.json 的 source 为 './'**：
  // 仓库根的清单写的是 './plugins/zcode-advisor'（仓库布局：根目录下有 plugins/ 子目录），
  // 但 payload 自身就是插件本体（.zcode-plugin/hooks/commands/tools 直接在其下），
  // 没有 plugins/ 子目录。不改写则宿主报
  //   plugin_marketplace_invalid: Unsupported or missing plugin source: ./plugins/zcode-advisor
  // 导致 install 失败、自动启用落空（干净机器真机测试发现，CI 不覆盖安装环节）。
  for (const rel of ['.claude-plugin/marketplace.json', '.zcode-plugin/marketplace.json']) {
    const mf = path.join(payloadRoot, rel);
    try {
      if (!fs.existsSync(mf)) continue;
      const doc = JSON.parse(fs.readFileSync(mf, 'utf8'));
      let changed = false;
      for (const pl of doc.plugins || []) {
        if (pl && typeof pl.source === 'string' && pl.source !== './') { pl.source = './'; changed = true; }
      }
      if (changed) fs.writeFileSync(mf, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } catch (_) { /* 改写失败不阻断构建，安装时会给出明确错误 */ }
  }

  // auto-enable 脚本本身也要随包（安装器/controller 调它）
  fs.copyFileSync(path.join(COMPANION_DIR, 'auto-enable.cjs'), path.join(payloadRoot, 'auto-enable.cjs'));
  return payloadRoot;
}

// 递归收集目录为归档条目（相对 base），保留可执行位
function collectEntries(base, relPrefix, mode) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      const rel = path.join(relPrefix, path.relative(base, full)).split(path.sep).join('/');
      if (st.isDirectory()) walk(full);
      else out.push({ path: rel, data: fs.readFileSync(full), mode: (st.mode & 0o777) || mode });
    }
  };
  walk(base);
  return out;
}

async function download(url) {
  // 大文件（Node 发行包 30~60MB）在连续请求时可能因连接复用/代理抖动而失败，
  // 实测同一 URL 单独请求可成功、连续请求会 `fetch failed`。故做有限重试，
  // 并显式禁用 keep-alive 以强制每条请求使用独立连接。
  const MAX_TRIES = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { Connection: 'close' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error(`空响应：${url}`);
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_TRIES) {
        const backoff = 1500 * attempt;
        warn(`下载失败（第 ${attempt}/${MAX_TRIES} 次）：${err.message}；${backoff}ms 后重试`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// 已解压内容的缓存目录（避免每次构建重复下载 ~30MB）
const CACHE_DIR = path.join(DIST, '.cache');

async function fetchEmbeddedNodeBinary(platform, arch) {
  const key = `${platform}-${arch}`;
  const cachePath = path.join(CACHE_DIR, `node-${key}`);
  if (fs.existsSync(cachePath)) {
    log(`复用缓存的 Node 运行时（${key}）`);
    return fs.readFileSync(cachePath);
  }

  const version = NODE_EMBED_VERSION || await resolveLatestLtsVersion();
  const fileName = platform === 'win'
    ? `node-${version}-win-${arch}.zip`
    : `node-${version}-darwin-${arch}.tar.gz`;
  const innerPath = platform === 'win' ? 'node.exe' : 'bin/node';
  const url = `${NODE_DIST_MIRROR}/${version}/${fileName}`;

  log(`下载官方 Node 运行时：${url}`);
  const buf = await download(url);
  const binary = platform === 'win' ? extractFromZip(buf, innerPath) : extractFromTarGz(buf, innerPath);
  if (!binary || binary.length === 0) {
    throw new Error(`从 ${fileName} 中未取到 ${innerPath}`);
  }
  stageDir(CACHE_DIR);
  fs.writeFileSync(cachePath, binary);
  log(`已提取 ${innerPath}（${(binary.length / 1048576).toFixed(1)} MB）`);
  return binary;
}

async function resolveLatestLtsVersion() {
  const index = JSON.parse((await download(`${NODE_DIST_MIRROR}/index.json`)).toString('utf8'));
  // 取最新 LTS；没有 LTS 标记时退回首条
  const lts = index.find((v) => v.lts);
  const picked = lts || index[0];
  if (!picked) throw new Error('index.json 中未找到任何 Node 版本');
  return picked.version;
}

// ---------------- Windows 产物 ----------------

async function buildWin(opts) {
  const entries = [];
  const mode = 0o644;

  for (const f of COMPANION_FILES) {
    entries.push({ path: f, data: fs.readFileSync(path.join(COMPANION_DIR, f)), mode });
  }
  entries.push({ path: 'install-shortcut.vbs', data: Buffer.from(T.INSTALL_SHORTCUT_VBS, 'utf8'), mode });
  entries.push({ path: 'install.cmd', data: Buffer.from(T.INSTALL_CMD, 'utf8'), mode });
  entries.push({ path: 'advisor.ico', data: makeIco(), mode });

  let embedded = false;
  if (opts.embedNode) {
    try {
      const exe = await fetchEmbeddedNodeBinary('win', 'x64');
      entries.push({ path: 'bin/node.exe', data: exe, mode: 0o755 });
      embedded = true;
    } catch (err) {
      warn(`Windows 内嵌 Node 获取失败：${String(err.message).slice(0, 160)}`);
      warn('该包缺少 bin\\node.exe，README-install.txt 中已写明补救步骤。');
    }
  }
  // README 需在确定是否内嵌之后生成（未内嵌时包含补救说明）
  entries.push({ path: 'README-install.txt', data: Buffer.from(T.winReadme(embedded), 'utf8'), mode });

  // **插件 payload + auto-enable 必须打进 Windows 包**：
  // NSIS 安装脚本会 ExecWait 调 $INSTDIR\auto-enable.cjs，
  // 缺它则安装后自动启用静默失效（Windows 全形态都无法启用插件）。
  const pluginRootWin = stagePluginPayload(path.join(DIST, '.stage-win-payload'));
  entries.push(...collectEntries(pluginRootWin, 'plugin', 0o644));
  entries.push({ path: 'auto-enable.cjs', data: fs.readFileSync(path.join(COMPANION_DIR, 'auto-enable.cjs')), mode });
  entries.push({ path: 'tools/sync-plugin-dir.cjs', data: fs.readFileSync(path.join(ROOT, 'tools', 'sync-plugin-dir.cjs')), mode });
  entries.push(...collectEntries(path.join(ROOT, 'hooks'), 'hooks', 0o644));

  const zip = buildZip(entries);
  const out = path.join(DIST, `ZCodeAdvisor-${VERSION}-win-x64.zip`);
  fs.writeFileSync(out, zip);
  log(`产物：${path.basename(out)}（${(zip.length / 1048576).toFixed(1)} MB，内嵌 Node：${embedded ? '是' : '否'}）`);

  const results = [{ path: out, kind: 'zip' }];

  // 额外产出 NSIS 安装器（标准安装体验）。工具缺失/崩溃时明确跳过，不算失败。
  // **在独立子进程中执行**：实测 makensis 崩溃（SIGABRT）会干扰同进程内随后的
  // hdiutil 调用，导致 DMG 无辜失败——隔离后两者互不影响。
  if (opts.installer) {
    try {
      const stage = stageDir(path.join(DIST, '.stage-win-nsis'));
      for (const e of entries) {
        const dest = path.join(stage, e.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.data);
        if (e.mode === 0o755 || e.path === 'bin/node.exe') {
          try { fs.chmodSync(dest, 0o755); } catch (_) {}
        }
      }
      const setupPath = path.join(DIST, `ZCodeAdvisor-${VERSION}-win-x64-setup.exe`);
      // .nsi 会写到 srcDir 的父目录（packagers.cjs 的相对路径设计），
      // workDir 仅承载临时产物，不再决定脚本位置。
      const workDir = path.join(DIST, '.stage-win-nsis-build');
      const r = runNsisInChildProcess({ workDir, stage, iconPath: path.join(stage, 'advisor.ico'), setupPath });
      if (r.ok) {
        log(`产物：${path.basename(setupPath)}（${(r.bytes / 1048576).toFixed(1)} MB，NSIS 安装器）`);
        results.push({ path: setupPath, kind: 'exe' });
      } else {
        warn(`跳过 NSIS 安装器：${r.reason}`);
      }
    } catch (err) {
      warn(`NSIS 安装器构建失败（不影响绿色包）：${String(err.message).slice(0, 200)}`);
    }
  }

  return results;
}

// 在独立子进程中生成 NSIS 安装器，stdout 回传 JSON 结果。
// 隔离原因见调用处注释（makensis 崩溃会污染父进程）。
function runNsisInChildProcess(o) {
  const runner = `
    const P = require(${JSON.stringify(path.join(COMPANION_DIR, 'packagers.cjs'))});
    const r = P.buildNsisInstaller({
      workDir: ${JSON.stringify(o.workDir)},
      srcDir: ${JSON.stringify(o.stage)},
      iconPath: ${JSON.stringify(o.iconPath)},
      version: ${JSON.stringify(VERSION)},
      outFile: ${JSON.stringify(o.setupPath)}
    });
    process.stdout.write(JSON.stringify(r));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.trim() || '{}');
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim().slice(0, 200);
    return { ok: false, reason: `NSIS 子进程失败${stderr ? `：${stderr}` : `：${err.message}`}` };
  }
}

// ---------------- macOS 产物 ----------------

async function buildMac(arch, opts) {
  const entries = [];
  const mode = 0o644;

  for (const f of COMPANION_FILES) {
    entries.push({ path: f, data: fs.readFileSync(path.join(COMPANION_DIR, f)), mode });
  }
  // install.sh 的 cp 清单由依赖闭包注入，并做版本号占位替换
  const installSh = T.MAC_INSTALL_SH(COMPANION_FILES).replace(/__VERSION__/g, VERSION);
  entries.push({ path: 'install.sh', data: Buffer.from(installSh, 'utf8'), mode: 0o755 });
  entries.push({ path: 'advisor.icns', data: makeIcns(), mode });

  let embedded = false;
  if (opts.embedNode) {
    try {
      const bin = await fetchEmbeddedNodeBinary('mac', arch);
      entries.push({ path: 'bin/node', data: bin, mode: 0o755 });
      embedded = true;
    } catch (err) {
      warn(`macOS(${arch}) 内嵌 Node 获取失败：${String(err.message).slice(0, 200)}`);
      warn('该包将回退到系统 Node（install.sh 会提示），或可换用 NODE_DIST_MIRROR / 设置代理后重试。');
    }
  }

  // 插件 payload + 自动启用脚本（.app 首次启动时调用，实现"装完自动开启"）
  const pluginRoot = stagePluginPayload(path.join(DIST, `.stage-mac-payload-${arch}`));
  entries.push(...collectEntries(pluginRoot, 'plugin', 0o644));
  entries.push({ path: 'auto-enable.cjs', data: fs.readFileSync(path.join(COMPANION_DIR, 'auto-enable.cjs')), mode: 0o755 });
  // launchd 自启动模块：不被 controller require（是独立 CLI），不在闭包推导里，须显式打包。
  entries.push({ path: 'launchd.cjs', data: fs.readFileSync(path.join(COMPANION_DIR, 'launchd.cjs')), mode: 0o755 });

  entries.push({ path: 'README-install.txt', data: Buffer.from(T.macReadme(embedded), 'utf8'), mode });
  entries.push({ path: 'BUILD-INFO.txt', data: Buffer.from(T.MAC_BUILD_INFO(arch, embedded), 'utf8'), mode });

  const tgz = buildTarGz(entries);
  const out = path.join(DIST, `ZCodeAdvisor-${VERSION}-macos-${arch}.tar.gz`);
  fs.writeFileSync(out, tgz);
  log(`产物：${path.basename(out)}（${(tgz.length / 1048576).toFixed(1)} MB，内嵌 Node：${embedded ? '是' : '否'}）`);

  const results = [{ path: out, kind: 'targz' }];

  // 额外产出 DMG（macOS 标准分发形态：内含自包含 .app，拖入 Applications 即装）。
  if (opts.installer) {
    if (process.platform !== 'darwin') {
      warn(`跳过 DMG（arch=${arch}）：DMG 只能在 macOS 上构建`);
    } else {
      try {
        const stage = stageDir(path.join(DIST, `.stage-mac-dmg-${arch}`));
        const runtimeFiles = COMPANION_FILES;
        const nodeEntry = entries.find((e) => e.path === 'bin/node');
        // .app 自包含：运行时与控制器都在包内（不依赖 Application Support）。
        // 临时文件放在 stage 之外的构建目录，避免被一起打进 DMG 根目录。
        let nodeBinPath = '';
        if (nodeEntry) {
          const tmpDir = stageDir(path.join(DIST, '.stage-mac-runtime'));
          nodeBinPath = path.join(tmpDir, `node-${arch}`);
          fs.writeFileSync(nodeBinPath, nodeEntry.data);
          fs.chmodSync(nodeBinPath, 0o755);
        }
        P.stageMacApp({
          destDir: stage,
          version: VERSION,
          runtimeFiles,
          companionDir: COMPANION_DIR,
          nodeBinPath,
          icnsBuf: makeIcns(),
          // 必须跟随当前 arch——硬编码 x64 会让 arm64 DMG 缺插件（且 verifyDmg 不校验）。
          // 语义：stageMacApp 执行 cpSync(pluginDir, Resources/app/plugin)，
          // 即把 pluginDir **整体拷为** plugin/。因此必须传 pluginRoot
          // （= <stage>/plugin，其下直接是 .claude-plugin/hooks/…），
          // 传父目录会得到 plugin/plugin/… 的嵌套，verifyDmg 会（正确地）拒绝。
          pluginDir: pluginRoot
        });
        const dmgPath = path.join(DIST, `ZCodeAdvisor-${VERSION}-macos-${arch}.dmg`);
        const r = P.buildDmg({
          stageDir: stage,
          outFile: dmgPath,
          volumeName: `ZCode Advisor ${VERSION}`,
          version: VERSION
        });
        if (r.ok) {
          log(`产物：${path.basename(dmgPath)}（${(r.bytes / 1048576).toFixed(1)} MB，DMG 安装包）`);
          results.push({ path: dmgPath, kind: 'dmg', expectNode: !!nodeEntry });
        } else {
          warn(`跳过 DMG：${r.reason}`);
        }
      } catch (err) {
        warn(`DMG 构建失败（不影响 tar.gz）：${String(err.message).slice(0, 200)}`);
      }
    }
  }

  return results;
}

// ---------------- 产物反向校验 ----------------

// 归档格式一旦写错，典型表现是"能生成、解压报错"。这里做三层校验：
// 1) 结构校验：必需文件都在（含**依赖闭包**，防止再次漏包——曾漏 zcode-path.cjs）；
// 2) 系统工具交叉验证：unzip / tar 能否列出条目；
// 3) 冒烟校验：产物内 controller.cjs 的 require 能否全部解析（真正确认"装完能跑"）。
function verifyArtifact(artifact) {
  const name = path.basename(artifact.path);

  // 安装器形态（exe/dmg）走各自的校验分支
  if (artifact.kind === 'exe') return verifyNsis(name, artifact.path);
  if (artifact.kind === 'dmg') return verifyDmg(name, artifact.path, artifact.expectNode !== false);

  const buf = fs.readFileSync(artifact.path);
  const entries = artifact.kind === 'zip' ? readZipEntries(buf) : readTarGz(buf);
  const names = entries.map((e) => e.path);

  // 1) 依赖闭包校验：compiler 推导出的每个运行时文件都必须进包
  const missing = COMPANION_FILES.filter((f) => !names.includes(f));
  if (missing.length > 0) {
    throw new Error(`${name}: 缺少运行时文件 ${missing.join(', ')}（发行包内 controller 会 require 失败）`);
  }
  if (artifact.kind === 'zip' && !names.includes('install.cmd')) throw new Error(`${name}: 缺少 install.cmd`);
  if (artifact.kind === 'targz' && !names.includes('install.sh')) throw new Error(`${name}: 缺少 install.sh`);
  // launchd.cjs 是 macOS 专属的独立 CLI（不被 controller require），闭包推导覆盖不到，单独校验。
  if (artifact.kind === 'targz' && !names.includes('launchd.cjs')) {
    throw new Error(`${name}: 缺少 launchd.cjs（macOS 自启动绑定会静默失效）`);
  }

  // 2) 系统工具交叉验证（尽力而为）。
  // 工具**不可用**时跳过并提示：`unzip` 不是 Windows 自带（需 Git for Windows 的 CmdTools，
  // MinGit 版不含），把它当致命条件会让没装该工具的 Windows 机器直接构建失败。
  // 但工具**存在却失败**时仍必须报错——那说明产物可能真的损坏。
  const crossCheck = artifact.kind === 'zip'
    ? { tool: 'unzip', args: ['-l', artifact.path] }
    : { tool: 'tar', args: ['-tzf', artifact.path] };
  if (hasSystemTool(crossCheck.tool)) {
    execFileSync(crossCheck.tool, crossCheck.args, { stdio: 'pipe' });
    log(`系统工具交叉验证通过（${crossCheck.tool}）：${name}`);
  } else {
    log(`提示：未找到 ${crossCheck.tool}，跳过系统工具交叉验证（自研读取器校验已通过）`);
  }

  // 3) require 冒烟：把包内 JS 释放到临时目录，实际 require 一次 controller
  verifyRequireClosure(name, entries);

  log(`校验通过（依赖闭包 + 系统工具 + require 冒烟）：${name}，${names.length} 个条目`);
}

// 系统上是否存在可执行工具（用于决定是否做交叉验证）。
function hasSystemTool(tool) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// NSIS 安装器校验：PE 头（致命）+ 体积合理性（致命）+ 内嵌文件名扫描（仅告警）。
//
// verifyNsis：PE 头（致命）+ 体积合理性（致命）+ 内嵌文件名扫描（仅告警）。
//
// 体积下限不能一刀切：不带内嵌 Node 的安装器**合法地**很小——实测真实
// COMPANION_FILES + 真图标、无 bin/node.exe 时 makensis 产出 80592 字节（约 79KB）。
// 早期用固定 1MiB 会把这种好包判成"疑似空包"，并让整个构建 exit 1。
// 因此阈值按"是否内嵌 node"区分：
//   - 内嵌：安装器必须显著大于 node 二进制本身（用 8MiB 作宽松下限，node.exe 约 90MB）
//   - 未内嵌：只要不是几百字节的残骸即可（1KiB）
function verifyNsis(name, filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`${name}: 不是合法的 PE 可执行文件（缺 MZ 头）`);
  }

  const hasEmbeddedNode = COMPANION_FILES.length > 0 && fs.existsSync(path.join(DIST, '.stage-win-nsis', 'bin', 'node.exe'));
  const MIN_BYTES = hasEmbeddedNode ? 8 * 1024 * 1024 : 1024;
  if (buf.length < MIN_BYTES) {
    const kind = hasEmbeddedNode ? '已内嵌 node.exe' : '未内嵌 node.exe';
    throw new Error(`${name}: 体积异常（${buf.length} 字节，${kind}，下限 ${MIN_BYTES}），疑似空包`);
  }

  // 文件名扫描仅作告警，且**同时查 UTF-8/ASCII 与 UTF-16LE**：
  // Unicode NSIS 的字符串表是 UTF-16LE，只用 latin1 查会恒为 false，
  // 每次都打印"未检出"——那样的诊断信息没有价值。
  const hasLatin = (f) => buf.includes(Buffer.from(f, 'latin1'));
  const hasUtf16 = (f) => buf.includes(Buffer.from(f, 'utf16le'));
  const notFound = COMPANION_FILES.filter((f) => !hasLatin(f) && !hasUtf16(f));
  if (notFound.length > 0) {
    // 非致命：LZMA 压缩后文件名可能整体位于压缩流中，不可见属正常。
    log(`提示：${name} 未检出 ${notFound.join(', ')}（LZMA 压缩下属正常，不作为失败条件）`);
  }
  log(`校验通过（PE 头 + 体积合理性）：${name}，${(buf.length / 1048576).toFixed(1)} MB`);
}

// DMG 校验：hdiutil verify 后挂载，确认 .app 结构与依赖闭包完整。
// expectNode：构建时是否内嵌 Node（--no-embed-node 时为 false，只警告不报错）。
function verifyDmg(name, filePath, expectNode = true) {
  execFileSync('hdiutil', ['verify', filePath], { stdio: 'pipe' });

  const mountPoint = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zca-dmg-'));
  try {
    execFileSync('hdiutil', ['attach', filePath, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { stdio: 'pipe' });
    try {
      const appDir = path.join(mountPoint, 'ZCode Advisor.app');
      if (!fs.existsSync(appDir)) throw new Error(`${name}: DMG 内缺少 ZCode Advisor.app`);

      const resources = path.join(appDir, 'Contents', 'Resources');
      const launcher = path.join(appDir, 'Contents', 'MacOS', 'ZCodeAdvisor');
      if (!fs.existsSync(launcher)) throw new Error(`${name}: .app 缺少可执行启动器`);
      // **必须校验插件 payload**：曾因 pluginDir 硬编码 x64，arm64 DMG 缺插件本体而
      // 此处不校验 → CI 绿灯放行、用户装完只有角标没有审查功能。
      const pluginManifest = path.join(resources, 'app', 'plugin', '.claude-plugin', 'marketplace.json');
      if (!fs.existsSync(pluginManifest)) {
        throw new Error(`${name}: .app 缺少插件 payload（${pluginManifest}）——该包无法自动启用审查插件`);
      }
      const bridge = path.join(resources, 'app', 'plugin', 'tools', 'config-bridge.js');
      if (!fs.existsSync(bridge)) {
        throw new Error(`${name}: 插件 payload 缺少 tools/config-bridge.js（MCP 将无法启动）`);
      }

      const missing = COMPANION_FILES.filter((f) => !fs.existsSync(path.join(resources, 'app', f)));
      if (missing.length > 0) {
        throw new Error(`${name}: .app 内缺少运行时文件 ${missing.join(', ')}`);
      }
      // **必须校验内嵌 Node**：.app 由 Finder 启动，不继承 shell PATH，
      // `command -v node` 对 nvm 等管理的 node 会失败。曾用 --no-embed-node 构建后
      // 分发，用户双击只得到「找不到 node」弹窗，而此处不校验 → 构建绿灯放行。
      const nodeBin = path.join(resources, 'node');
      if (!fs.existsSync(nodeBin)) {
        if (expectNode) {
          throw new Error(`${name}: .app 缺少内嵌 Node（${nodeBin}）——GUI 启动不继承 PATH，无内嵌 node 时启动器必然失败`);
        }
        warn(`${name}: .app 未内嵌 Node（--no-embed-node）——仅供本机调试，**不要分发**`);
      } else if (process.platform !== 'win32' && (fs.statSync(nodeBin).mode & 0o111) === 0) {
        throw new Error(`${name}: .app 内嵌 Node 缺少执行位（无法启动）`);
      }
      // launchd 自启动模块必须在包内（启动器会调用它装 LaunchAgent）
      const launchdMod = path.join(resources, 'app', 'launchd.cjs');
      if (!fs.existsSync(launchdMod)) {
        throw new Error(`${name}: .app 缺少 launchd.cjs（自启动绑定将静默失效）`);
      }
      log(`校验通过（hdiutil verify + .app 结构与依赖闭包）：${name}，${(fs.statSync(filePath).size / 1048576).toFixed(1)} MB`);
    } finally {
      execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'pipe' });
    }
  } catch (err) {
    // 挂载失败时尝试清理，但把原始错误抛给调用方
    try { execFileSync('hdiutil', ['detach', mountPoint, '-force', '-quiet'], { stdio: 'pipe' }); } catch (_) {}
    throw err;
  } finally {
    try { fs.rmdirSync(mountPoint); } catch (_) { /* 挂载点非空/已卸载：保留即可 */ }
  }
}

// 把产物中的 JS 文件释放到临时目录并 require 入口，确认依赖确实可解析。
// 这是拦住"清单漏项"类问题的最终防线：结构对了、但 require 挂掉同样不可交付。
function verifyRequireClosure(name, entries) {
  const { execFileSync: run } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zca-smoke-'));

  try {
    for (const e of entries) {
      if (!/\.(cjs|js)$/.test(e.path)) continue;
      const dest = path.join(tmp, e.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
    }

    // controller.cjs 顶层只做定义与 require，不会自动启动（main() 在文件末尾调用，
    // 故这里改为只解析依赖图：require 每个模块并检查是否抛 MODULE_NOT_FOUND）。
    for (const f of COMPANION_FILES) {
      if (!f.endsWith('.cjs')) continue; // inject.js 是页面脚本，不参与 require
      try {
        run(process.execPath, ['-e', `require(${JSON.stringify(path.join(tmp, f))})`], {
          stdio: 'pipe',
          timeout: 20000,
          env: Object.assign({}, process.env, { ZCODE_ADVISOR_REQUIRE_SMOKE: '1' })
        });
      } catch (err) {
        const out = `${err.stdout || ''}${err.stderr || ''}`.trim().slice(0, 400);
        throw new Error(`${name}: require 冒烟失败（${f}）—— ${out || err.message}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------- 入口 ----------------

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  log(`构建 ZCode Advisor 发行包 v${VERSION}（平台参数 mac-arch=${opts.macArch}）`);

  // 清理上次产物：**不删除**，移入 dist/.previous/（保留可回溯性，也避免误删手工放置的文件）。
  // .cache 与 .previous 自身不动。
  if (fs.existsSync(DIST)) {
    const prev = path.join(DIST, '.previous');
    let moved = 0;
    for (const f of fs.readdirSync(DIST)) {
      if (f === '.cache' || f === '.previous') continue;
      fs.mkdirSync(prev, { recursive: true });
      const from = path.join(DIST, f);
      const to = path.join(prev, f);
      try {
        if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true }); // 覆盖上上次同名产物
        fs.renameSync(from, to);
        moved++;
      } catch (_) { /* 跨设备或占用：跳过，不阻断构建 */ }
    }
    if (moved > 0) log(`上次产物 ${moved} 项已移入 dist/.previous/`);
  }
  stageDir(DIST);

  const artifacts = [];

  if (!opts.skipWin) {
    artifacts.push(...await buildWin(opts));
  }

  if (!opts.skipMac) {
    // mac 产物可在任意平台交叉构建（只做二进制搬运，不执行），故不限制构建机平台。
    const arches = opts.macArch === 'both' ? ['x64', 'arm64'] : [opts.macArch];
    for (const arch of arches) {
      artifacts.push(...await buildMac(arch, opts));
    }
  }

  // 校验阶段：单个产物失败不应掩盖其它产物的结论，先全跑完再汇总
  const failures = [];
  for (const a of artifacts) {
    try {
      verifyArtifact(a);
    } catch (err) {
      failures.push(`${path.basename(a.path)}: ${err.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`产物校验失败：\n  - ${failures.join('\n  - ')}`);
  }

  log(`构建完成：${artifacts.length} 个产物位于 dist/`);
})().catch((err) => {
  console.error('[build] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
