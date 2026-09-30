'use strict';

// 安装器打包：Windows NSIS（.exe）与 macOS DMG（.dmg）。
//
// 与已有 zip / tar.gz 的关系（**并存，不替代**）：
// - zip / tar.gz 仍是"杀软友好"的绿色包：明文 install.cmd / install.sh，无自解压、无改名进程、无隐藏启动；
// - setup.exe 是常规 NSIS 安装器（业界标准安装器，非 IExpress 自解压 dropper），
//   提供标准安装体验（桌面快捷方式、开始菜单、控制面板卸载项）；
// - dmg 是 macOS 标准分发形态：内含 .app 包，拖入 Applications 即装。
//
// 两条纪律在三种形态下都保持：不改进程名（快捷方式指向原始 node 二进制）、不做隐藏启动。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------- Windows：NSIS ----------------

// 版本号补成 4 段数字，满足 VIProductVersion 的 x.x.x.x 要求
function version4(v) {
  const parts = String(v).split('.').map((p) => parseInt(p, 10)).filter((n) => Number.isFinite(n));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

// NSIS 脚本。路径统一用正斜杠（NSIS 接受），避免反斜杠转义问题。
//
// File 指令为什么用**相对路径**（`SRCFILES` 定义 + 相对 srcDir）：
// 实测 CI（windows-2022，makensis v3.10）上 `File /r "D:/abs/path/*.*"` 报
// "no files found" —— makensis 对「绝对路径 + 通配符」的组合在 Windows 上解析不可靠。
// 改为把 .nsi 放在 srcDir 的**父目录**、引用相对路径 `SRCFILES\*.*`，
// 并让 makensis 以脚本所在目录为工作目录（cd 到该目录再调用），两侧一致后解析稳定。
//
// **srcDirName 必须等于 srcDir 的 basename**：三者（.nsi 位置 / SRCFILES / 实际目录）
// 不一致就会出现 "no files found"——实测踩过（目录叫 .stage-win-nsis 而脚本里写的 stage）。
function nsisScript(opts) {
  const { outFile, iconPath, srcDirName, version } = opts;
  return `Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

; 待打包目录（相对本脚本）：由构建脚本保证与 .nsi 同级
!define SRCFILES "${srcDirName}"

Name "ZCode Advisor"
OutFile "${outFile}"
InstallDir "$LOCALAPPDATA\\ZCodeAdvisor"
InstallDirRegKey HKCU "Software\\ZCodeAdvisor" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show

VIProductVersion "${version4(version)}"
VIAddVersionKey "ProductName" "ZCode Advisor"
VIAddVersionKey "FileDescription" "ZCode Advisor 安装程序（输入框角标外挂）"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "ProductVersion" "${version}"

!define MUI_ICON "${iconPath}"
!define MUI_UNICON "${iconPath}"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "ZCode Advisor 安装完成"
!define MUI_FINISHPAGE_TEXT "桌面与开始菜单已创建「ZCode Advisor」图标。$\\r$\\n双击它即以角标模式启动 ZCode，输入框右下角会出现 🛡️ 角标，点开即可配置。"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "\${SRCFILES}\\*.*"

  WriteRegStr HKCU "Software\\ZCodeAdvisor" "InstallDir" "$INSTDIR"

  ; 快捷方式指向原始 node 二进制并带上 controller 参数；SW_SHOWMINIMIZED 保持控制台可见
  ; （与绿色包的 .vbs 行为一致：不隐藏、不改名、不做后台启动）
  CreateShortCut "$DESKTOP\\ZCode Advisor.lnk" "$INSTDIR\\bin\\node.exe" '"$INSTDIR\\controller.cjs"' "$INSTDIR\\advisor.ico" 0 SW_SHOWMINIMIZED
  CreateDirectory "$SMPROGRAMS\\ZCode Advisor"
  CreateShortCut "$SMPROGRAMS\\ZCode Advisor\\ZCode Advisor.lnk" "$INSTDIR\\bin\\node.exe" '"$INSTDIR\\controller.cjs"' "$INSTDIR\\advisor.ico" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\\ZCode Advisor\\卸载 ZCode Advisor.lnk" "$INSTDIR\\uninstall.exe"

  WriteUninstaller "$INSTDIR\\uninstall.exe"

  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "DisplayName" "ZCode Advisor"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "DisplayIcon" "$INSTDIR\\advisor.ico"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "DisplayVersion" "${version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "Publisher" "local"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "UninstallString" '"$INSTDIR\\uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\ZCode Advisor.lnk"
  Delete "$SMPROGRAMS\\ZCode Advisor\\ZCode Advisor.lnk"
  Delete "$SMPROGRAMS\\ZCode Advisor\\卸载 ZCode Advisor.lnk"
  RMDir "$SMPROGRAMS\\ZCode Advisor"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeAdvisor"
  DeleteRegKey HKCU "Software\\ZCodeAdvisor"
  ; 卸载保留用户级配置 %USERPROFILE%\\.zcode\\advisor.config.json（含 API key，不静默删除）
  RMDir /r "$INSTDIR"
SectionEnd
`;
}

function hasTool(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// 调 makensis 编译。makensis 可跨平台（macOS 上也能产出 Windows .exe）。
// 失败（含二进制崩溃）统一包装为 {ok:false, reason}，让调用方给出可读提示而不是抛裸异常。
function buildNsisInstaller(opts) {
  const { workDir, srcDir, iconPath, version, outFile } = opts;
  fs.mkdirSync(workDir, { recursive: true });

  // 脚本写到 srcDir 的**父目录**，使 File /r 的相对路径可解析。
  // SRCFILES 用 srcDir 的 basename——三者（.nsi 位置 / SRCFILES / 实际目录）必须一致，
  // 否则 makensis 报 "no files found"（实测踩过：目录名与脚本内写的不一致）。
  const srcDirName = path.basename(srcDir);
  const nsiPath = path.join(path.dirname(srcDir), `zcode-advisor-${version}.nsi`);
  const iconRel = path.relative(path.dirname(nsiPath), iconPath).replace(/\\/g, '/');

  // **必须带 UTF-8 BOM**：脚本含中文，而 makensis 在 Windows 上默认按系统 ACP 解析
  // 非 BOM 输入（NSIS 源码 utf.cpp 的 DetectUTFBOM 只识别 BOM，识别失败即回落到 ACP）。
  // 无 BOM 的 UTF-8 + 中文 → "Bad text encoding"，编译失败，而失败会被上层当成
  // "跳过安装器" 吞掉，导致 CI 绿灯却不产出 setup.exe。加 BOM 后任何平台都按 UTF-8 解析。
  const nsiSource = Buffer.from(nsisScript({
    outFile: outFile.replace(/\\/g, '/'),
    iconPath: iconRel,
    srcDirName,
    version
  }), 'utf8');
  fs.writeFileSync(nsiPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), nsiSource]));

  if (!hasTool('makensis')) {
    return { ok: false, reason: 'makensis 不可用（Windows 建议 choco install nsis；CI 用 windows-2022 预装版）' };
  }

  try {
    // 以 .nsi 所在目录为工作目录运行（与脚本内相对路径的定义一致）
    execFileSync('makensis', ['-V2', nsiPath], { stdio: 'pipe', cwd: path.dirname(nsiPath) });
  } catch (err) {
    // 已知现象一：部分平台/版本的 makensis 二进制自身崩溃（如 macOS Homebrew 3.12 的
    // std::bad_alloc → SIGABRT）。此时 stderr 只有 libc++abi 提示，需要转成可读原因。
    // 已知现象二：makensis 崩溃（SIGABRT）会干扰同一进程内随后的 hdiutil 调用，
    // 因此调用方应在独立子进程中执行本函数（见 build-installer.cjs 的隔离说明）。
    const stderr = String((err && err.stderr) || '').trim().slice(0, 200);
    const signal = err && err.signal ? `（信号 ${err.signal}）` : '';
    const hint = /bad_alloc|libc\+\+abi/.test(stderr)
      ? 'makensis 二进制异常退出；该平台的 makensis 可能不可用，建议改在 Windows/CI 上构建'
      : 'makensis 编译失败';
    return { ok: false, reason: `${hint}${signal}${stderr ? `：${stderr}` : ''}` };
  }

  if (!fs.existsSync(outFile)) return { ok: false, reason: 'makensis 未产出文件' };
  return { ok: true, path: outFile, bytes: fs.statSync(outFile).size };
}

// ---------------- macOS：.app + DMG ----------------

// 自包含 .app 的启动器：运行时与控制器都在包内，不依赖 Application Support。
const MAC_APP_LAUNCHER = `#!/bin/bash
# ZCode Advisor 启动器（自包含 .app：运行时与控制器均在包内）
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG="$HOME/.zcode/advisor-companion.log"
mkdir -p "$(dirname "$LOG")"

NODE="$DIR/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  osascript -e 'display dialog "本应用需要 Node 运行时，但包内未内嵌且系统 PATH 上找不到 node。请重新下载完整安装包。" with title "ZCode Advisor" buttons ["好"] default button "好" with icon caution' >/dev/null 2>&1
  exit 1
fi

# 日志追加；controller 自身有单实例锁，重复点击不会重复注入
nohup "$NODE" "$DIR/app/controller.cjs" >>"$LOG" 2>&1 &
exit 0
`;

function macAppPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleName</key><string>ZCode Advisor</string>
<key>CFBundleDisplayName</key><string>ZCode Advisor</string>
<key>CFBundleIdentifier</key><string>local.zcode.advisor</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>ZCodeAdvisor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>10.15</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleIconFile</key><string>advisor.icns</string>
</dict></plist>
`;
}

// 在 destDir 下生成 "ZCode Advisor.app"（自包含），返回 .app 路径。
function stageMacApp(opts) {
  const { destDir, version, runtimeFiles, companionDir, nodeBinPath, icnsBuf } = opts;
  const appDir = path.join(destDir, 'ZCode Advisor.app');
  const contents = path.join(appDir, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const appRes = path.join(resources, 'app');

  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(appRes, { recursive: true });

  fs.writeFileSync(path.join(contents, 'Info.plist'), macAppPlist(version), 'utf8');
  const launcher = path.join(macos, 'ZCodeAdvisor');
  fs.writeFileSync(launcher, MAC_APP_LAUNCHER, 'utf8');
  fs.chmodSync(launcher, 0o755);

  for (const f of runtimeFiles) {
    fs.copyFileSync(path.join(companionDir, f), path.join(appRes, f));
  }
  if (nodeBinPath && fs.existsSync(nodeBinPath)) {
    fs.copyFileSync(nodeBinPath, path.join(resources, 'node'));
    fs.chmodSync(path.join(resources, 'node'), 0o755);
  }
  if (icnsBuf) fs.writeFileSync(path.join(resources, 'advisor.icns'), icnsBuf);

  return appDir;
}

// hdiutil 制作压缩 DMG；并放入 /Applications 符号链接，符合"拖入即装"的 macOS 习惯。
function buildDmg(opts) {
  const { stageDir, outFile, volumeName } = opts;
  if (process.platform !== 'darwin' || !hasTool('hdiutil')) {
    return { ok: false, reason: 'DMG 只能在 macOS 上构建（hdiutil 不可用）' };
  }
  const link = path.join(stageDir, 'Applications');
  try {
    if (!fs.existsSync(link)) fs.symlinkSync('/Applications', link);
  } catch (_) { /* 已存在或权限问题：不阻断 DMG 制作 */ }

  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  // 不用 -quiet：DMG 创建失败时 stderr 是唯一线索（此前 -quiet 把错误吞掉，
  // 只留下"Command failed: hdiutil create …"这种无法定位的信息）。
  try {
    execFileSync('hdiutil', [
      'create',
      '-volname', volumeName,
      '-srcfolder', stageDir,
      '-ov',
      '-format', 'UDZO',
      outFile
    ], { stdio: 'pipe' });
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim().slice(0, 300);
    return { ok: false, reason: `hdiutil create 失败：${stderr || (err && err.message)}` };
  }

  if (!fs.existsSync(outFile)) return { ok: false, reason: 'hdiutil 未产出文件' };
  return { ok: true, path: outFile, bytes: fs.statSync(outFile).size };
}

module.exports = {
  buildNsisInstaller,
  buildDmg,
  stageMacApp,
  nsisScript,
  version4,
  MAC_APP_LAUNCHER,
  macAppPlist
};
