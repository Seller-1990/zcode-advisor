'use strict';

// 平台安装模板（纯字符串，零依赖）。
// 从 build-installer.cjs 抽出：模板与构建逻辑分离，便于审阅与测试。
//
// 设计约束（README 第 212 行声明，不得回退）：
// - 不做自解压 setup.exe、不改进程名、不做隐藏启动——三者均为杀软高危启发式特征；
// - 安装脚本全程明文、可审计；
// - Windows 的 node.exe 保持原始文件名与官方数字签名。

const { VERSION } = require('./build-meta.cjs');

// ---------------- Windows ----------------

// 快捷方式直接指向原始签名的 node.exe（不改名、不隐藏窗口，最小化运行日志）。
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
if errorlevel 1 (
  echo [错误] 文件复制失败（可能被杀毒软件拦截或目录被占用）：%DST%
  echo 请关闭占用程序或将 %DST% 加入白名单后重试。桌面图标未创建。
  endlocal & exit /b 1
)
cscript //nologo "%DST%\\install-shortcut.vbs"
if errorlevel 1 (
  echo [错误] 快捷方式创建失败（cscript 退出码非零）。文件已复制到 %DST%，可手动运行：
  echo   %DST%\\install-shortcut.vbs
  endlocal & exit /b 1
)
echo 完成：桌面已创建「ZCode Advisor」图标（双击即以角标模式启动 ZCode）。
endlocal & exit /b 0
`;

const winReadme = (embedded) => `ZCode Advisor（输入框角标外挂）— Windows 安装说明

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
${embedded ? '' : `
⚠️ 重要：本包【未内嵌】Node 运行时
构建时未能下载官方 node.exe，因此本包缺少 bin\\node.exe。
请自行安装 Node ≥ 22，并把 bin\\node.exe 替换为该 Node 的可执行文件
（或从 nodejs.org 下载 node.exe 放到本目录的 bin\\ 下），否则快捷方式无法启动。
`}`;

// ---------------- macOS ----------------

const macReadme = (embedded) => `ZCode Advisor（输入框角标外挂）— macOS 安装说明

安装：终端执行 ./install.sh —— 生成 ~/Applications/ZCode Advisor.app（启动台可见）。
      ${embedded
        ? '本包已内嵌官方 Node 运行时，无需系统 Node。'
        : '⚠️ 本包【未内嵌】Node 运行时：需要系统已安装 Node ≥ 22（角标外挂依赖全局 WebSocket，Node 22 起默认提供）。'}
使用：启动台/聚焦打开 ZCode Advisor → 自动以调试模式启动 ZCode 并注入 🛡️ 角标。
配置：点击输入框旁 🛡️ 角标 → 设置面板：第三方 API 端点 / API key / 拉取模型列表 / Ping / 保存。
      macOS 上若自动探测不到 ZCode，编辑 ~/.zcode/advisor-companion.json 填 {"zcodePath":"/Applications/ZCode.app"}。
日志：~/.zcode/advisor-companion.log
卸载：删除 ~/Applications/ZCode Advisor.app 与 ~/Library/Application Support/ZCodeAdvisor。
免责：依赖 ZCode 桌面版非公开接口（CDP 注入），ZCode 大版本更新可能导致角标失效；hook 审查功能不受影响。
`;

// install.sh：生成 .app 包；内嵌 node 不可用时显式回退到系统 node。
// 注意 ${RUNTIME_CP_LINES}：运行时文件列表由 build-meta 的依赖闭包推导后注入，
// 避免"cp 清单"与实际 require 依赖漂移（曾漏 zcode-path.cjs 导致装完即崩）。
const MAC_INSTALL_SH = (runtimeFiles) => `#!/bin/bash
set -e
SUPPORT="$HOME/Library/Application Support/ZCodeAdvisor"
APP="$HOME/Applications/ZCode Advisor.app"
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SUPPORT/bin" "$APP/Contents/MacOS" "$APP/Contents/Resources"
${runtimeFiles.map((f) => `[ -f "$SRC/${f}" ] || { echo "[错误] 发行包缺少 ${f}" >&2; exit 1; }`).join('\n')}
${runtimeFiles.map((f) => `cp -f "$SRC/${f}" "$SUPPORT/"`).join('\n')}
# launchd 自启动模块：不被 controller require（独立 CLI），故不在闭包推导里，须显式复制。
[ -f "$SRC/launchd.cjs" ] || { echo "[错误] 发行包缺少 launchd.cjs" >&2; exit 1; }
cp -f "$SRC/launchd.cjs" "$SUPPORT/"

# 安装插件本体（包内 payload → 调用 auto-enable 走 ZCode 官方 CLI 注册/安装/启用）。
# 这是 tar.gz 路径的"自动启用"执行点：包内携带 plugin/ 与 auto-enable.cjs，
# 缺此步骤则用户只装到角标外挂、审查插件本体没装。
if [ -f "$SRC/plugin/.claude-plugin/marketplace.json" ] && [ -f "$SRC/auto-enable.cjs" ]; then
  "$SUPPORT/bin/node" "$SRC/auto-enable.cjs" 2>/dev/null || echo "[提示] 插件自动启用未完成，可在 ZCode 内手动添加插件市场：$SRC/plugin"
else
  echo "[提示] 包内未找到插件 payload，审查功能需手动安装插件（见 README）"
fi

# 把 auto-enable.cjs 与 plugin payload 复制进 $SUPPORT：controller 每次启动都会从
# __dirname 找 auto-enable.cjs 重新执行（0.2.13 起的既有设计），但本脚本此前没有把
# 这两样复制过来——导致 .app 升级时插件永远停在旧版本（复审无情行者/实跑定位）。
# 复制后即闭环：每次点开「ZCode Advisor」→ controller 启动 → auto-enable 按
# 「不降级」判据把插件升到包内版本（DMG 自包含 .app 已有同样布局，无需改动）。
if [ -f "$SRC/auto-enable.cjs" ] && [ -d "$SRC/plugin" ]; then
  cp -f "$SRC/auto-enable.cjs" "$SUPPORT/" || echo "[提示] auto-enable 复制失败（后续升级需手动跑 plugins update）"
  rm -rf "$SUPPORT/plugin"
  cp -R "$SRC/plugin" "$SUPPORT/plugin" || echo "[提示] plugin payload 复制失败（后续升级需手动跑 plugins update）"
fi

# Node 运行时：优先用包内内嵌，其次回退系统 node（并明确告知）。
# 注意：set -e 对 cp 在命令替换赋值位置并不总是生效，故显式校验结果，
# 避免复制失败却仍写出指向缺失文件的启动器、最后打印"安装成功"。
if [ -f "$SRC/bin/node" ]; then
  cp -f "$SRC/bin/node" "$SUPPORT/bin/node" || { echo "[错误] 复制内置 Node 失败" >&2; exit 1; }
  chmod +x "$SUPPORT/bin/node" || { echo "[错误] 设置执行位失败" >&2; exit 1; }
elif command -v node >/dev/null 2>&1; then
  SYSTEM_NODE="$(command -v node)"
  cp -f "$SYSTEM_NODE" "$SUPPORT/bin/node" || { echo "[错误] 复制系统 Node 失败：$SYSTEM_NODE" >&2; exit 1; }
  chmod +x "$SUPPORT/bin/node" || { echo "[错误] 设置执行位失败" >&2; exit 1; }
  echo "[提示] 包内未内嵌 Node，已使用系统 Node：$SYSTEM_NODE"
else
  echo "[错误] 包内未内嵌 Node，且系统 PATH 上找不到 node。请安装 Node >= 22 后重试（角标外挂依赖全局 WebSocket）。" >&2
  exit 1
fi
[ -x "$SUPPORT/bin/node" ] || { echo "[错误] Node 运行时就位校验失败：$SUPPORT/bin/node" >&2; exit 1; }

cp -f "$SRC/advisor.icns" "$APP/Contents/Resources/" 2>/dev/null || true
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleName</key><string>ZCode Advisor</string>
<key>CFBundleDisplayName</key><string>ZCode Advisor</string>
<key>CFBundleIdentifier</key><string>local.zcode.advisor</string>
<key>CFBundleVersion</key><string>__VERSION__</string>
<key>CFBundleShortVersionString</key><string>__VERSION__</string>
<key>CFBundleExecutable</key><string>ZCodeAdvisor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>10.15</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
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
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  osascript -e 'display dialog "未找到 node（可能已升级或卸载），请重新运行 install.sh" with title "ZCode Advisor" buttons ["好"] default button ["好"] with icon caution' >/dev/null 2>&1
  exit 1
fi
# 自启动绑定（幂等）：登录时自动拉起，崩溃时自动重启。
"$NODE" "$SUPPORT/launchd.cjs" install --now >>"$LOG" 2>&1 || true
# LaunchAgent 已加载时交由 launchd 常驻，避免两个 owner 互抢单实例锁。
if "$NODE" "$SUPPORT/launchd.cjs" status 2>/dev/null | grep -q 'loaded=是'; then
  exit 0
fi
nohup "$NODE" "$SUPPORT/controller.cjs" >>"$LOG" 2>&1 &
exit 0
LAUNCH
chmod +x "$APP/Contents/MacOS/ZCodeAdvisor"
echo "已安装：~/Applications/ZCode Advisor.app（启动台可见）"
echo "已配置登录自启动（LaunchAgent: ~/Library/LaunchAgents/local.zcode.advisor.plist）"
echo "打开应用即以角标模式启动 ZCode；日志：~/.zcode/advisor-companion.log"
`;

module.exports = {
  INSTALL_SHORTCUT_VBS,
  INSTALL_CMD,
  winReadme,
  macReadme,
  MAC_INSTALL_SH,
  MAC_BUILD_INFO: (arch, embedded) => `zcode-advisor 发行包（macOS）
version: ${VERSION}
arch: ${arch}
内嵌 Node: ${embedded ? '是' : '否（需系统 Node >= 22）'}
构建于: ${new Date().toISOString()}
`
};
