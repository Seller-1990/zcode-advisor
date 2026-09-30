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
# API/开关等设置在「🛡 顾问」面板或本地网页面板随时调整。
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
echo "✓ Node:      $($NODE_BIN -v)（$NODE_BIN）"

# 3) 注册本地市场（幂等：重复 add 会被 CLI 以同名提示）
echo "── 注册本地插件市场 ──"
run_cli plugins marketplace add "$ROOT" 2>&1 | grep -vE "^$" | head -3

# 4) 安装插件（从本目录内容安装，更新场景重复运行即可）
echo "── 安装插件 ──"
if ! run_cli plugins install zcode-advisor 2>&1 | tail -2; then
  echo "错误：插件安装失败（见上方输出）" >&2
  exit 1
fi

# 5) 启用（写入宿主 config.json 的 plugins 段）
echo "── 启用插件 ──"
run_cli plugins enable zcode-advisor 2>&1 | tail -1

# 6) 验证：宿主应报告 hooks(3)/mcp(config-bridge)/commands 已加载
echo "── 验证 ──"
run_cli plugins list 2>&1 | grep -A2 "zcode-advisor@" | head -3 || \
  echo "警告：未能从 plugins list 确认（请手动运行 plugins list 核对）" >&2

# 7) 用户级配置模板（若尚无）——审查的 API key/model/端点都在这里
CFG="$HOME/.zcode/advisor.config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cat > "$CFG" <<'JSON'
{
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "model": "glm-5.3-flash",
  "apiKey": ""
}
JSON
  echo "✓ 已生成用户级配置：$CFG"
else
  echo "✓ 用户级配置已存在（API key / 模型 / 端点均在其中，不覆盖）"
fi

# 8) 角标外挂（可选）：顶栏图标 + 设置面板（开关/API 均在此面板调整）
if [ "$NO_COMPANION" = "1" ]; then
  echo
  echo "（按 --no-companion 跳过角标外挂）"
else
  echo
  echo "── 角标外挂（可选：顶栏图标 + 设置面板）──"
  echo "  运行：node \"$ROOT/tools/companion/controller.cjs\""
  echo "  面板内可调：顾问开关（/advisor-on|off 亦可）、API 端点 / key / 模型 / 模式 / max_tokens。"
fi

echo
echo "────────────────────────────────────────────────"
echo "完成。新开 ZCode 会话即自动启用审查。"
echo "  · 状态：/advisor-status"
echo "  · 临时开关：/advisor-on ｜ /advisor-off"
echo "  · 意见历史：🛡 顾问面板 → 📜 顾问意见记录"
