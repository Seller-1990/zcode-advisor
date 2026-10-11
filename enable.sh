#!/usr/bin/env bash
# zcode-advisor 启用脚本：一条命令完成插件注册、安装、启用与配置。
#
# 用法：
#   ./enable.sh                    # 注册 + 安装 + 启用（幂等，可重复运行）
#   ./enable.sh --no-companion     # 只装插件，不提示角标外挂
#
# 原理：ZCode 自带 CLI（<app>/Contents/Resources/glm/zcode.cjs）提供
# `plugins marketplace add / install / enable` 子命令——本脚本调用它完成
# 官方支持的全自动启用，不修改宿主私有数据文件。
#
# 启用后：新开 ZCode 会话即自动挂载审查（SessionStart hook 注入注册行），
# 开关、服务商/模型选择与审查参数可在「🛡 顾问」面板或本地网页面板调整。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1
NO_COMPANION=0
[ "${1:-}" = "--no-companion" ] && NO_COMPANION=1

echo "── zcode-advisor 启用 ──────────────────────────"

# 0) 前置检查
[ -f "$ROOT/.claude-plugin/marketplace.json" ] || { echo "错误：未找到 .claude-plugin/marketplace.json（请在仓库根目录或发行包解压目录运行）" >&2; exit 1; }

# 1) 找 ZCode CLI（宿主自带；发行包用户无需系统 Node——CLI 用 node 运行，
#    而发行包内嵌了 node，优先用它，避免依赖系统 Node）
ZC_CANDIDATES=(
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
  "$HOME/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
)
ZC=""
for c in "${ZC_CANDIDATES[@]}"; do
  [ -f "$c" ] && { ZC="$c"; break; }
done
if [ -z "$ZC" ]; then
  echo "错误：未找到 ZCode CLI（预期 /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs）" >&2
  echo "      请确认已安装 ZCode 桌面版；如装在自定义位置请编辑本脚本 ZC_CANDIDATES。" >&2
  exit 1
fi

# 2) 运行 CLI 的 node：优先用本目录内嵌的（发行包 bin/node），否则系统 node。
#    注意必须剥离 ELECTRON_RUN_AS_NODE——否则宿主 Electron 包装器被当作 Node 解释器，
#    报 bad option（实测踩过）。
NODE_BIN=""
[ -f "$ROOT/bin/node" ] && NODE_BIN="$ROOT/bin/node"
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && { echo "错误：找不到 node（内嵌与系统均无）" >&2; exit 1; }

run_cli() {
  env -u ELECTRON_RUN_AS_NODE "$NODE_BIN" "$ZC" "$@"
}

echo "✓ ZCode CLI: $ZC"
echo "✓ Node:      $("${NODE_BIN}" -v)（${NODE_BIN}）"

# 失败累积器：占位注册/刷新/启用任一步失败都不得再报「完成」（R13——旧版只检查
# install，update/enable 失败仍 exit 0，用户看到成功而插件其实没启用）。
FAIL=0
fail_step() {
  FAIL=1
  echo "错误：$1 失败（见上方输出）" >&2
}

# 同步 plugins/<name>/（宿主市场布局要求的子目录）——避免"改了根目录却装出旧代码"
if ! "$NODE_BIN" "$ROOT/tools/sync-plugin-dir.cjs" 2>&1 | sed 's/^/  /'; then
  fail_step "同步 plugins/<name>/"
fi

# 3) 注册本地市场（幂等：重复 add 会被 CLI 以同名提示）
echo "── 注册本地插件市场 ──"
ADD_OUT="$(run_cli plugins marketplace add "$ROOT" 2>&1)"; ADD_RC=$?
printf '%s\n' "$ADD_OUT" | grep -vE "^$" | head -3
# add 不设硬失败：既可能"已注册"而返回非零，也可能输出为空（空输出会让 grep 返回 1），
# 无法与真失败区分；真正决定"装的是不是当前代码"的是下一步 update。
[ "$ADD_RC" -eq 0 ] || echo "提示：marketplace add 返回 $ADD_RC（重复注册属正常；首次注册请核对上方输出）" >&2

# 4) 刷新市场缓存（**必须**）——宿主会把市场内容快照到自己的缓存目录，
#    install 从该快照拷贝，因此不 update 就会装出旧代码（实测踩过：
#    no_transcript 修复未进入宿主 cache，顾问仍空转）。
echo "── 刷新市场缓存 ──"
UPDATE_OUT="$(run_cli plugins marketplace update zcode-advisor-local 2>&1)"; UPDATE_RC=$?
printf '%s\n' "$UPDATE_OUT" | tail -1
[ "$UPDATE_RC" -eq 0 ] || fail_step "刷新市场缓存（marketplace update）"

# 5) 安装插件（从刷新后的市场缓存安装）
echo "── 安装插件 ──"
if ! run_cli plugins install zcode-advisor 2>&1 | tail -2; then
  echo "错误：插件安装失败（见上方输出）" >&2
  exit 1
fi

# 5) 启用（写入宿主 config.json 的 plugins 段）
echo "── 启用插件 ──"
ENABLE_OUT="$(run_cli plugins enable zcode-advisor 2>&1)"; ENABLE_RC=$?
printf '%s\n' "$ENABLE_OUT" | tail -1
[ "$ENABLE_RC" -eq 0 ] || fail_step "启用插件（plugins enable）"

# 6) 验证：宿主应报告 hooks(3)/mcp(config-bridge)/commands 已加载
#    （若 cache 与源目录 md5 不一致，说明市场缓存未刷新成功）
echo "── 验证 ──"
run_cli plugins list 2>&1 | grep -A2 "zcode-advisor@" | head -3 || \
  echo "警告：未能从 plugins list 确认（请手动运行 plugins list 核对）" >&2

# 7) 用户级行为配置模板（若尚无）；凭据由 ZCode 第三方服务商配置维护。
CFG="$HOME/.zcode/advisor.config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cat > "$CFG" <<'JSON'
{
  "enabled": true,
  "reviewMode": "async"
}
JSON
  echo "✓ 已生成用户级行为配置：$CFG"
else
  echo "✓ 用户级行为配置已存在（不覆盖）"
fi
echo "  请先在 ZCode 第三方服务商设置中配置端点、API key 与模型，再用 /advisor-setup 选择。"

# 8) 角标外挂（可选）：顶栏图标 + 设置面板（开关、服务商/模型选择与审查参数）
if [ "$NO_COMPANION" = "1" ]; then
  echo
  echo "（按 --no-companion 跳过角标外挂）"
else
  echo
  echo "── 角标外挂（可选：顶栏图标 + 设置面板）──"
  echo "  运行：node \"$ROOT/tools/companion/controller.cjs\""
  echo "  面板内可调：顾问开关（/advisor-on|off 亦可）、服务商 / 模型 / 模式 / max_tokens；端点和 key 在 ZCode 设置中维护。"
fi

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "────────────────────────────────────────────────" >&2
  echo "失败：上述步骤存在未成功的项，插件未完成启用（不要以「完成」为准）。" >&2
  echo "      修好后可重复运行本脚本（幂等）。" >&2
  exit 1
fi

echo
echo "────────────────────────────────────────────────"
echo "完成。新开 ZCode 会话即自动启用审查。"
echo "  · 状态：/advisor-status"
echo "  · 临时开关：/advisor-on ｜ /advisor-off"
echo "  · 意见历史：🛡 顾问面板 → 📜 顾问意见记录"
