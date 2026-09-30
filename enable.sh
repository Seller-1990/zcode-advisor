#!/usr/bin/env bash
# zcode-advisor 启用脚本：把本目录注册为 ZCode 的本地插件市场，并引导完成安装。
#
# 为什么需要这个脚本：插件的审查逻辑以 ZCode 插件形态运行（hooks/commands），
# 必须被 ZCode 识别才能生效；而「打包 DMG/exe」只分发**角标外挂**（设置面板 + 注入 UI），
# 两者是独立组件。本脚本把「设置 → 插件管理 → 添加市场 → 选目录 → 安装」这条
# 手动链路压缩成一条命令。
#
# 用法：./enable.sh   （在本仓库根目录或发行包解压目录内运行）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

echo "── zcode-advisor 启用 ──────────────────────────"

# 0) 前置检查
[ -f "$ROOT/.claude-plugin/marketplace.json" ] || { echo "错误：未找到 .claude-plugin/marketplace.json（请在仓库根目录运行）" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "错误：需要 Node ≥ 22（node -v 自查）" >&2; exit 1; }
echo "✓ 插件目录就绪：$ROOT"
echo "✓ Node: $(node -v)"

# 1) 写入用户级配置模板（若尚无配置文件）——让首次审查即可用
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
  echo "✓ 已生成用户级配置：$CFG（请在设置面板填 API key）"
else
  echo "✓ 用户级配置已存在：$CFG（不覆盖）"
fi

# 2) 注册本地插件市场（若尚未注册）
#    ZCode 的市场列表在 ~/.zcode/cli/plugins/known_marketplaces.json；
#    本地目录市场指向本仓库根目录。
KM="$HOME/.zcode/cli/plugins/known_marketplaces.json"
REGED=0
if [ -f "$KM" ]; then
  if grep -q "zcode-advisor-local" "$KM" 2>/dev/null; then REGED=1; fi
fi
if [ "$REGED" = "1" ]; then
  echo "✓ 本地市场已注册（zcode-advisor-local），如需更新插件请重新安装一次"
else
  # 不直接改宿主私有 JSON（格式可能随版本变化）：把注册动作交给 ZCode CLI，
  # 并给出确定性指引——这一步必须在 ZCode 交互内完成，脚本无法代点。
  cat >&2 <<'GUIDE'

── 需要在 ZCode 里完成一步（脚本无法代点）──
  ZCode → 设置 → 插件管理 → 添加插件市场 → 选择目录：
      $ROOT
  然后安装列表中的「ZCode 顾问 / zcode-advisor」并保持启用。
  （此目录含 .claude-plugin/marketplace.json，ZCode 会识别为本地市场；
   安装后新开会话，首条消息应出现 [advisor] 注册行，即审查已挂载。）

GUIDE
fi

# 3) 顺带把角标外挂也装好（可选：设置面板 + 顶栏图标）
echo
echo "── 角标外挂（可选，设置面板 + 顶栏图标）──"
echo "  双击桌面入口或运行：node \"$ROOT/tools/companion/controller.cjs\""
echo "  （以调试模式启动 ZCode 并在顶栏注入 🛡 顾问图标；不装也不影响审查）"

echo
echo "────────────────────────────────────────────────"
echo "完成。安装插件后新开会话即可生效；状态用 /advisor-status 查看。"
