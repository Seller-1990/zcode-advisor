#!/usr/bin/env node
'use strict';

// 发行包构建脚本（零第三方依赖，在 Windows 上运行）。
// 产物（dist/）：
//   ZCodeAdvisor-<ver>-win-x64-setup.exe   IExpress 自解压安装包（双击安装并创建桌面/开始菜单图标）
//   ZCodeAdvisor-<ver>-win-x64.zip         绿色包（内含 install.cmd，效果同上）
//   ZCodeAdvisor-<ver>-macos-x64.tar.gz    macOS Intel (darwin-x64) 包：install.sh 生成 ~/Applications
//                                          下的 ZCode Advisor.app（启动台可见）
// 内嵌官方 Node 运行时：Windows 取本机 node.exe（build 即在 Node 上运行）；
// macOS 取 nodejs.org 的 darwin-x64 官方二进制（下载失败时给出无内嵌包并提示需系统 Node）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
const DIST = path.join(ROOT, 'dist');
// Windows 自带 bsdtar：GNU tar 会把 "D:\..." 当远程主机
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const NODE_DIST_MIRROR = process.env.NODE_DIST_MIRROR || 'https://nodejs.org/dist';
const NODE_MAJOR = process.version.match(/^v(\d+)/)[1];
const NODE_VERSION_FOR_MAC = process.env.NODE_EMBED_VERSION || null; // 缺省自动取最新 v22

const COMPANION_FILES = ['controller.cjs', 'inject.js', 'lib.cjs'];

// ---------------- 图标生成（零依赖）：盾牌图形，输出 RGBA 像素 ----------------

function drawShield(size) {
  const d = Buffer.alloc(size * size * 4);
  const px = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  };
  const inRounded = (x, y, m, rad) => {
    const x0 = m, y0 = m, x1 = size - m, y1 = size - m;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad || (x >= x0 + rad && x <= x1 - rad) || (y >= y0 + rad && y <= y1 - rad);
  };
  const shieldHalf = (t) => size * 0.26 * (1 - 0.42 * t * t); // t∈[0,1] 从顶到底收窄
  const shieldTop = size * 0.24, shieldBottom = size * 0.82, cx = size / 2;
  const inShield = (x, y, scale) => {
    if (y < shieldTop || y > shieldBottom) return false;
    const t = (y - shieldTop) / (shieldBottom - shieldTop);
    const half = shieldHalf(t) * scale;
    if (t > 0.86) { // 底部收尖
      const k = (t - 0.86) / 0.14;
      return Math.abs(x - cx) <= half * (1 - k);
    }
    return Math.abs(x - cx) <= half;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y, size * 0.03, size * 0.2)) { px(x, y, 0, 0, 0, 0); continue; }
      // 底：深蓝渐变
      const t = y / size;
      let r = Math.round(15 + 20 * t), g = Math.round(23 + 30 * t), b = Math.round(42 + 45 * t);
      if (inShield(x, y, 1)) { r = 226; g = 232; b = 240; }        // 外盾：浅色
      if (inShield(x, y, 0.74)) { r = 37; g = 99; b = 235; }        // 内盾：品牌蓝
      if (inShield(x, y, 0.74)) {
        // 中间一道浅色斜杠，增强辨识度
        const dx = x - cx, dy = y - (shieldTop + shieldBottom) / 2;
        if (Math.abs(dx - dy * 0.35) < size * 0.045) { r = 226; g = 232; b = 240; }
      }
      px(x, y, r, g, b, 255);
    }
  }
  return d;
}

// PNG 编码（8-bit RGBA，filter 0）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco() {
  const s32 = drawShield(32);
  // 32bpp BMP（XOR 自下而上 + AND 掩码）
  const xor = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) s32.copy(xor, (31 - y) * 32 * 4, y * 32 * 4, (y + 1) * 32 * 4);
  const and = Buffer.alloc(32 * 4); // 全 0 = 不透明位
  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0); bmpHeader.writeInt32LE(32, 4); bmpHeader.writeInt32LE(64, 8);
  bmpHeader.writeUInt16LE(1, 12); bmpHeader.writeUInt16LE(32, 14);
  bmpHeader.writeUInt32LE(xor.length + and.length, 20);
  const bmp = Buffer.concat([bmpHeader, xor, and]);
  const png256 = encodePng(256, drawShield(256));
  const entries = [];
  const data32 = Buffer.concat([bmp]);
  entries.push({ size: 32, data: data32 });
  entries.push({ size: 256, data: png256, png: true });
  let offset = 6 + entries.length * 16;
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  let off = offset;
  entries.forEach((e, i) => {
    const base = 6 + i * 16;
    dir[base] = e.size % 256; dir[base + 1] = 0;
    dir[base + 2] = e.size % 256; dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(e.png ? 32 : 32, base + 6); // bitcount
    dir.writeUInt32LE(e.data.length, base + 8);
    dir.writeUInt32LE(off, base + 12);
    off += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

function makeIcns() {
  const p128 = encodePng(128, drawShield(128));
  const p256 = encodePng(256, drawShield(256));
  const chunks = [];
  for (const [type, png] of [['ic07', p128], ['ic08', p256]]) {
    const head = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(png.length + 8);
    chunks.push(Buffer.concat([len, head, png]));
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4); total.writeUInt32BE(body.length + 8);
  return Buffer.concat([head, total, body]);
}

// ---------------- 通用工具 ----------------

function stageDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function copyTo(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
function write(dst, content) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, content); }

async function downloadTo(url, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dst, buf);
  return buf.length;
}

async function latestV22DarwinX64() {
  const r = await fetch(`${NODE_DIST_MIRROR}/index.json`);
  const idx = await r.json();
  const v = idx.find((e) => e.version.startsWith('v22.'));
  if (!v) throw new Error('index.json 中未找到 v22 版本');
  return { version: v.version, url: `${NODE_DIST_MIRROR}/${v.version}/node-${v.version}-darwin-x64.tar.gz` };
}

// ---------------- 各平台打包 ----------------

const INSTALL_SHORTCUT_VBS = `Option Explicit
Dim sh, fso, base, desktop, startMenu, lnk, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = base & "\\bin\\node.exe"
desktop = sh.SpecialFolders("Desktop")
startMenu = sh.SpecialFolders("Programs") & "\\ZCode Advisor"
If Not fso.FolderExists(startMenu) Then fso.CreateFolder(startMenu)
' 快捷方式直接指向原始签名的 node.exe（不改名、不隐藏窗口，最小化运行日志）
Set lnk = sh.CreateShortcut(desktop & "\\ZCode Advisor.lnk")
lnk.TargetPath = nodeExe
lnk.Arguments = chr(34) & base & "\\controller.cjs" & chr(34)
lnk.WorkingDirectory = base
lnk.IconLocation = base & "\\advisor.ico"
lnk.Description = "zcode-advisor 输入框角标外挂"
lnk.WindowStyle = 7
lnk.Save
Set lnk = sh.CreateShortcut(startMenu & "\\ZCode Advisor.lnk")
lnk.TargetPath = nodeExe
lnk.Arguments = chr(34) & base & "\\controller.cjs" & chr(34)
lnk.WorkingDirectory = base
lnk.IconLocation = base & "\\advisor.ico"
lnk.Description = "zcode-advisor 输入框角标外挂"
lnk.WindowStyle = 7
lnk.Save
`;

const INSTALL_CMD = `@echo off
setlocal
set "DST=%LOCALAPPDATA%\\ZCodeAdvisor"
echo 安装 zcode-advisor 外挂到 %DST% ...
xcopy /E /I /Y /Q "%~dp0*" "%DST%\\" >nul
cscript //nologo "%DST%\\install-shortcut.vbs"
echo 完成：桌面已创建「ZCode Advisor」图标（双击即以角标模式启动 ZCode）。
endlocal & exit /b 0
`;

const WIN_README = `ZCode Advisor（输入框角标外挂）— Windows 安装说明

安装：解压后双击 install.cmd（全程明文脚本，可先审阅），完成后桌面出现「ZCode Advisor」图标。
使用：双击桌面图标 → 以最小化窗口运行外挂（bin\\node.exe，原始官方签名副本）并注入 🛡️ 角标。
配置：点击输入框旁 🛡️ 角标 → 设置面板：第三方 API 端点 / API key / 拉取模型列表 / Ping 测试 / 保存。
      保存写入 %USERPROFILE%\\.zcode\\advisor.config.json，下一轮审查即生效，无需重启。
共存：与 zcode-plus 可同时使用（CDP 多客户端附着，✨ 与 🛡️ 共存；谁先启动都行）。
日志：%USERPROFILE%\\.zcode\\advisor-companion.log
卸载：删除桌面/开始菜单快捷方式与 %LOCALAPPDATA%\\ZCodeAdvisor 目录即可。
关于杀软：本包不含自解压 exe、不含改名进程、无隐藏启动；bin\\node.exe 为官方原版副本。
        若仍有误报，可将安装目录加入白名单（自行斟酌）。
免责：依赖 ZCode 桌面版非公开接口（CDP 注入），ZCode 大版本更新可能导致角标失效；hook 审查功能不受影响。
`;

const MAC_README = `ZCode Advisor（输入框角标外挂）— macOS (Intel) 安装说明

安装：终端执行 ./install.sh —— 生成 ~/Applications/ZCode Advisor.app（启动台可见），
      并内嵌官方 Node 运行时，无需系统 Node。
使用：启动台/聚焦打开 ZCode Advisor → 自动以调试模式启动 ZCode 并注入 🛡️ 角标。
配置：点击输入框旁 🛡️ 角标 → 设置面板：第三方 API 端点 / API key / 拉取模型列表 / Ping / 保存。
日志：~/.zcode/advisor-companion.log
卸载：删除 ~/Applications/ZCode Advisor.app 与 ~/Library/Application Support/ZCodeAdvisor。
`;

const MAC_INSTALL_SH = `#!/bin/bash
set -e
SUPPORT="$HOME/Library/Application Support/ZCodeAdvisor"
APP="$HOME/Applications/ZCode Advisor.app"
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SUPPORT/bin" "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -f "$SRC/controller.cjs" "$SRC/inject.js" "$SRC/lib.cjs" "$SUPPORT/"
cp -f "$SRC/bin/node" "$SUPPORT/bin/node" 2>/dev/null || cp -f "$(command -v node)" "$SUPPORT/bin/node"
chmod +x "$SUPPORT/bin/node"
cp -f "$SRC/advisor.icns" "$APP/Contents/Resources/" 2>/dev/null || true
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>ZCode Advisor</string>
<key>CFBundleDisplayName</key><string>ZCode Advisor</string>
<key>CFBundleIdentifier</key><string>local.zcode.advisor</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleExecutable</key><string>ZCodeAdvisor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>CFBundleIconFile</key><string>advisor.icns</string>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/ZCodeAdvisor" <<'LAUNCH'
#!/bin/bash
SUPPORT="$HOME/Library/Application Support/ZCodeAdvisor"
LOG="$HOME/.zcode/advisor-companion.log"
mkdir -p "$(dirname "$LOG")"
NODE="$SUPPORT/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
nohup "$NODE" "$SUPPORT/controller.cjs" >>"$LOG" 2>&1 &
exit 0
LAUNCH
chmod +x "$APP/Contents/MacOS/ZCodeAdvisor"
echo "已安装：~/Applications/ZCode Advisor.app（启动台可见）+ 桌面图标"
echo "打开应用即以角标模式启动 ZCode；日志：~/.zcode/advisor-companion.log"
`;

function buildWin() {
  // 杀软友好形态（v0.2.1 起放弃 IExpress 自解压与改名 node——两者均为高危启发式特征，
  // 会被杀软当作 dropper/masquerade 删除）：
  // - node.exe 保持原名与官方签名，放 bin/ 下；
  // - 快捷方式直接指向 bin\node.exe（最小化窗口运行日志，进程可见可查）；
  // - 安装脚本全程明文（install.cmd / install-shortcut.vbs 可审计），无自解压、无隐藏启动。
  const stage = stageDir(path.join(DIST, 'stage-win'));
  stageDir(path.join(stage, 'bin'));
  copyTo(process.execPath, path.join(stage, 'bin', 'node.exe'));
  for (const f of COMPANION_FILES) copyTo(path.join(ROOT, 'tools', 'companion', f), path.join(stage, f));
  write(path.join(stage, 'install-shortcut.vbs'), INSTALL_SHORTCUT_VBS);
  write(path.join(stage, 'install.cmd'), INSTALL_CMD);
  write(path.join(stage, 'advisor.ico'), makeIco());
  write(path.join(stage, 'README-install.txt'), WIN_README);

  const zip = path.join(DIST, `ZCodeAdvisor-${VERSION}-win-x64.zip`);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Force -Path '${stage}\\*' -DestinationPath '${zip}'`]);
  log(`产物：${zip}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB，含 bin\\node.exe 原始签名副本）`);
}

async function buildMac() {
  const stage = stageDir(path.join(DIST, 'stage-mac', `ZCodeAdvisor-${VERSION}-macos-x64`));
  for (const f of COMPANION_FILES) copyTo(path.join(ROOT, 'tools', 'companion', f), path.join(stage, f));
  write(path.join(stage, 'install.sh'), MAC_INSTALL_SH);
  write(path.join(stage, 'README-install.txt'), MAC_README);
  write(path.join(stage, 'advisor.icns'), makeIcns());
  stageDir(path.join(stage, 'bin'));

  let embedded = false;
  try {
    const { url } = await latestV22DarwinX64();
    log(`下载 macOS 运行时：${url}`);
    const tgz = path.join(DIST, 'cache', path.basename(url));
    await downloadTo(url, tgz);
    execFileSync(TAR, ['-xzf', tgz, '-C', path.join(DIST, 'cache'), `${path.basename(url, '.tar.gz')}/bin/node`]);
    copyTo(path.join(DIST, 'cache', `${path.basename(url, '.tar.gz')}`, 'bin', 'node'), path.join(stage, 'bin', 'node'));
    fs.chmodSync(path.join(stage, 'bin', 'node'), 0o755);
    embedded = true;
  } catch (err) {
    log(`警告：内嵌 macOS 运行时下载失败（${String(err).slice(0, 120)}）—— 包内将要求系统 Node ≥ 18`);
  }

  const tarball = path.join(DIST, `ZCodeAdvisor-${VERSION}-macos-x64.tar.gz`);
  execFileSync(TAR, ['-czf', tarball, '-C', path.join(DIST, 'stage-mac'), `ZCodeAdvisor-${VERSION}-macos-x64`]);
  log(`产物：${tarball}（${(fs.statSync(tarball).size / 1048576).toFixed(1)} MB，内嵌 darwin-x64 Node：${embedded ? '是' : '否'}）`);
}

function log(...a) { console.log('[build]', ...a); }

(async () => {
  log(`构建 ZCode Advisor 发行包 v${VERSION}`);
  fs.rmSync(DIST, { recursive: true, force: true });
  stageDir(DIST);
  buildWin();
  await buildMac();
  log('构建完成。产物位于 dist/');
})().catch((err) => {
  console.error('[build] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
