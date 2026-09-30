#!/bin/bash
# ocr 评审包装脚本（zcode-advisor）
#
# 设计（与 ~/.dsh/AGENTS.md 一致）：
#   - 评审工具**不进 CI**：模型网关是内网地址（192.168.50.139），GitHub runner 够不着；
#     拦截靠 CI 的确定性检查，评审只作为 advisory 关卡。
#   - 也**不定时跑**：只在每个 PR 合并前调用一次。
#
# 三级模型降级链（provider|model，与 ~/.opencodereview/config.json 的 custom_providers 对应）：
#   主    x666        -> grok-4.7        （薄荷 0 倍率）
#   备用① nas-hy4     -> hy4-preview-f   （8787 网关）
#   备用② nas-octopus -> glm-5.3-flash   （PM-API 免费分组）
#
# 用法：
#   ./scripts/ocr-review.sh              # 默认基准 origin/dev（不存在则回退 main）
#   ./scripts/ocr-review.sh v1.8.8       # 对比 tag / 分支
#   ./scripts/ocr-review.sh main HEAD   # 指定 from/to

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# ocr 装在 nvm 全局；cron/非交互 shell 不继承 PATH，这里显式补上。
# 先看 PATH 里有没有，没有再补常见位置（不把某个固定版本当成唯一来源）。
if ! command -v ocr >/dev/null 2>&1; then
  # nvm 版本号会随升级变化，用通配匹配当前安装的 node，而不是写死某个版本
  # 先看 nvm 默认别名指向的具体版本
  NVM_DEFAULT="$HOME/.nvm/alias/default"
  if [ -f "$NVM_DEFAULT" ]; then
    DEFAULT_VER="$(tr -d '[:space:]' < "$NVM_DEFAULT")"
    case "$DEFAULT_VER" in v*) ;; *) DEFAULT_VER="v$DEFAULT_VER" ;; esac
    CAND="$HOME/.nvm/versions/node/$DEFAULT_VER/bin"
    [ -x "$CAND/ocr" ] && PATH="$CAND:$PATH"
  fi
  # 再按版本号倒序扫（字典序会把 v10 排在 v20 之前，可能命中陈旧的全局安装）
  if ! command -v ocr >/dev/null 2>&1; then
    for candidate in $(ls -1d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -Vr) /usr/local/bin /opt/homebrew/bin; do
      if [ -x "$candidate/ocr" ]; then
        PATH="$candidate:$PATH"
        break
      fi
    done
  fi
  export PATH
fi
if ! command -v ocr >/dev/null 2>&1; then
  echo "错误：找不到 ocr 命令（npm i -g @alibaba-group/open-code-review）" >&2
  exit 1
fi

AGENT_MODEL_FILE="$HOME/.opencodereview/agent-model"

# 校验 ref 是否真实存在（避免把非法参数带进 ocr）
require_ref() {
  local ref="$1"
  case "$ref" in ''|-*) return 1 ;; esac
  # rev-parse --verify 对 blob/tree 也返回 0，必须确认解析为 commit
  git rev-parse --verify --quiet --end-of-options "${ref}^{commit}" >/dev/null 2>&1
}

# 基准：默认 origin/dev，回退 origin/main 或本地 main；都不可用则 HEAD~1
resolve_base() {
  local candidate="${1:-}"
  if [ -n "$candidate" ]; then
    if require_ref "$candidate"; then echo "$candidate"; return 0; fi
    echo "错误：基准 ref 不存在：$candidate" >&2
    return 1
  fi
  local ref
  for ref in origin/dev origin/main main; do
    if require_ref "$ref"; then echo "$ref"; return 0; fi
  done
  if require_ref "HEAD~1"; then echo "HEAD~1"; return 0; fi
  # 只有一次提交时：空树作基准，让首次提交也能被评审
  local empty_tree
  empty_tree="$(git hash-object -t tree /dev/null 2>/dev/null || true)"
  if [ -n "$empty_tree" ]; then echo "$empty_tree"; return 0; fi
  echo "错误：找不到可用基准（仓库尚无提交）" >&2
  return 1
}

FROM="$(resolve_base "${1:-}")" || exit 1
TO="${2:-HEAD}"
if ! require_ref "$TO"; then
  echo "错误：目标 ref 不存在：$TO" >&2
  exit 1
fi

# 代理当前模型：仅作避让提示（避免评审与编码代理抢同一个模型配额）
AGENT_MODEL="$(tr -d '[:space:]' < "$AGENT_MODEL_FILE" 2>/dev/null || true)"
[ -n "$AGENT_MODEL" ] && echo "（编码代理当前模型：$AGENT_MODEL，评审将优先使用其他 provider）"

# 三级降级链：逐个尝试，第一个**产出有效 JSON** 的即采用
CHAIN=(
  "x666|grok-4.7"
  "nas-hy4|hy4-preview-f"
  "nas-octopus|glm-5.3-flash"
)

# 模板必须以 XXXXXX 结尾：GNU mktemp 把 -t 当 --tmpdir 并要求该后缀（BSD/macOS 两者都接受）。
TMPDIR_OCR="${TMPDIR:-/tmp}"
OUT_JSON="$(mktemp "${TMPDIR_OCR%/}/ocr-review-XXXXXX" 2>/dev/null)" || {
  echo "错误：无法创建临时文件（mktemp 失败）" >&2; exit 1;
}
[ -n "$OUT_JSON" ] || { echo "错误：mktemp 未返回路径" >&2; exit 1; }
ATTEMPT_LOG=""
cleanup() { rm -f "$OUT_JSON" ${ATTEMPT_LOG:+"$ATTEMPT_LOG"}; }
trap cleanup EXIT INT TERM

# 判定一次尝试是否真正成功：退出码为 0 **且** 产出结构合格的 JSON。
# 只校验"可解析"不够——ocr 会写出 {"status":"failed","message":"..."} 这类对象，
# 若据此锁定 CHOSEN 就会跳过降级链，最后渲染成"未发现问题"（假清白，实测踩过）。
# 额外要求：status 不是 failed/error/cancelled，且 comments 是数组。
valid_output() {
  [ -s "$OUT_JSON" ] || return 1
  python3 - "$OUT_JSON" <<'PYCHECK' >/dev/null 2>&1
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
status = str(data.get("status") or "").lower()
if status in ("failed", "error", "cancelled"):
    sys.exit(1)
if not isinstance(data.get("comments"), list):
    sys.exit(1)
PYCHECK
}

echo "评审范围：$FROM .. $TO"
CHOSEN=""
SKIPPED=0
SKIPPED_ALL=0
FAILURE_DIAG=""
for entry in "${CHAIN[@]}"; do
  provider="${entry%%|*}"
  model="${entry##*|}"
  if [ -n "$AGENT_MODEL" ] && [ "$model" = "$AGENT_MODEL" ]; then
    echo "  跳过 $provider（$model 正被编码代理占用）"
    SKIPPED=$((SKIPPED + 1))
    [ "$SKIPPED" -eq "${#CHAIN[@]}" ] && SKIPPED_ALL=1
    continue
  fi
  # 每次尝试前清空，防止失败后残留上次结果被误判为成功
  : > "$OUT_JSON"
  ATTEMPT_LOG="$(mktemp "${TMPDIR_OCR%/}/ocr-attempt-XXXXXX" 2>/dev/null || true)"
  echo "  尝试 provider=$provider model=$model …"
  if ocr review --from "$FROM" --to "$TO" --format json --output "$OUT_JSON" \
       --provider "$provider" --model "$model" >"${ATTEMPT_LOG:-/dev/null}" 2>&1 && valid_output; then
    echo "  成功：$provider / $model"
    CHOSEN="$provider/$model"
    [ -n "$ATTEMPT_LOG" ] && rm -f "$ATTEMPT_LOG"
    break
  fi
  # 保留该次失败输出尾部，供全失败时排查（此前一律丢进 /dev/null）
  if [ -n "$ATTEMPT_LOG" ]; then
    FAILURE_DIAG="${FAILURE_DIAG}--- ${provider}/${model} ---
$(tail -5 "$ATTEMPT_LOG" 2>/dev/null)
"
    rm -f "$ATTEMPT_LOG"
  fi
  echo "  失败或输出无效，降级到下一个"
done

if [ -z "$CHOSEN" ]; then
  if [ "$SKIPPED_ALL" = "1" ]; then
    echo "错误：所有 provider 都因与编码代理同模型被跳过（agent-model=$AGENT_MODEL）。" >&2
    echo "      可临时指定：ocr review --provider <p> --model <m>" >&2
  else
    echo "错误：三级 provider 全部失败，未产生有效评审结果。" >&2
  fi
  if [ -n "$FAILURE_DIAG" ]; then
    echo "各 provider 输出尾部：" >&2
    printf '%s' "$FAILURE_DIAG" >&2
  fi
  exit 1
fi

# 把 ocr 的 JSON 输出转成便于阅读的表格。
# ocr 的真实 JSON 形状（2026-09 实测）：
#   { status, llm, message, summary, tool_calls, comments[], groups[], session_id, manifest, retry_report }
#   comments[] 元素键：path, content, suggestion_code, existing_code, start_line, end_line, thinking, category, severity
# 渲染失败必须让脚本非零退出（set -e 未开启，故显式传递）。
if ! python3 - "$OUT_JSON" "$CHOSEN" <<'PY'
import json, sys

path, chosen = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
except Exception as exc:
    print(f"无法解析 ocr 输出（{exc}）")
    sys.exit(1)

if not isinstance(data, dict):
    print("无法解析 ocr 输出（顶层不是对象）")
    sys.exit(1)

comments = data.get('comments')
if not isinstance(comments, list):
    comments = []
comments = [c for c in comments if isinstance(c, dict)]

print()
print(f"评审完成（{chosen}）—— 共 {len(comments)} 条意见")
summary = data.get('summary')
if isinstance(summary, str) and summary.strip():
    print(f"  摘要：{summary.strip()[:200]}")
if not comments:
    print("  未发现问题。")
    sys.exit(0)

import unicodedata

def display_width(text):
    # CJK 字形是双宽：用显示宽度而非码点数做列对齐
    return sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in text)

def pad(text, width):
    return text + ' ' * max(0, width - display_width(text))

def clip(text, width):
    # 截断时补省略号，避免读者误以为内容是完整的
    if display_width(text) <= width:
        return text
    out, used = '', 0
    for ch in text:
        w = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
        if used + w > width - 1:
            break
        out += ch
        used += w
    return out + '…'

SEV_ORDER = {'critical': 0, 'high': 1, 'major': 1, 'medium': 2, 'minor': 3, 'low': 3, 'info': 4}

def sev_rank(comment):
    raw = comment.get('severity')
    return SEV_ORDER.get(str(raw).lower() if raw is not None else '', 9)

def sev_text(comment):
    raw = comment.get('severity')
    text = str(raw).strip() if raw is not None else ''
    return text or '-'

def location(comment):
    path_value = comment.get('path')
    p = str(path_value).strip() if path_value is not None else ''
    p = p or '?'
    start, end = comment.get('start_line'), comment.get('end_line')
    # 显式判空：行号 0 是合法值，不能用 `or` 丢掉
    if start is not None and end is not None and start != end:
        return f"{p}:{start}-{end}"
    if start is not None:
        return f"{p}:{start}"
    return p

SEV_W, LOC_W = 8, 46
print()
print(f"{pad('严重度', SEV_W)} {pad('位置', LOC_W)} 说明")
print("-" * 118)
for c in sorted(comments, key=sev_rank):
    msg = ' '.join(str(c.get('content') or '').split())
    cat_raw = c.get('category')
    cat = str(cat_raw).strip() if cat_raw is not None else ''
    if cat:
        msg = f"[{cat}] {msg}"
    print(f"{pad(clip(sev_text(c), SEV_W), SEV_W)} {pad(clip(location(c), LOC_W), LOC_W)} {clip(msg, 170)}")
    # 修复建议是评审里最有价值的部分，单独缩进打印
    suggestion_raw = c.get('suggestion_code')
    suggestion = str(suggestion_raw).strip() if suggestion_raw is not None else ''
    if suggestion and suggestion.lower() not in ('null', 'none'):
        first_line = suggestion.splitlines()[0]
        print(f"{'':<{SEV_W}} {'':<{LOC_W}}   ↳ 建议：{clip(first_line, 150)}")
PY
then
  echo "错误：评审结果渲染失败。" >&2
  exit 1
fi
