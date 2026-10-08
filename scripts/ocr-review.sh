#!/bin/bash
# ocr 评审包装脚本（公开仓模板）— 新机重建版 2026-10-07（Windows Git Bash 适配）
#
# 架构（与旧机同构，见《OCR-自动评审-从零搭建指南》）：
#   - 运行时读链文件 chain-public（唯一真源），读不到用下方内嵌快照兜底；
#   - 逐跳降级：timeout 包 ocr review --provider/--model，单跳失败自动下一棒；
#   - advisory：评审永不拦门，本脚本退出码只反映「是否产出评审」；
#   - 跳过 config.json 中 api_key 为空的 provider（未补 key 的云端条目自动让位）。
# 用法：
#   bash scripts/ocr-review.sh               # 默认 HEAD~1 → HEAD
#   bash scripts/ocr-review.sh <from> <to>   # 指定区间
# 产物：
#   <git-common-dir>/ocr-review-last.txt     最近一次评审报告
#   ~/.dsh/hooks/ocr-pool-usage.log          用量流水（只记 provider/model/ok|fail，不记 diff 与 key）
set -uo pipefail

CHAIN_FILE="${OCR_CHAIN_FILE:-$HOME/.dsh/templates/ocr-review/chain-public}"
HOP_DEADLINE=900      # 单跳上限（秒），与 CI llm_timeout=600、ocr --timeout 15min 对齐口径
TOTAL_BUDGET=5400     # 全链总预算（秒）
PY="$(command -v python || command -v python3)"

# >>>OCR_CHAIN_SNAPSHOT>>>
CHAIN_SNAPSHOT='nas|nas-hy4|space-bunny
cloud|x666|ministral-14b-latest
cloud|runanytime-astra|gpt-6-astra
cloud|lucky|step-5-preview
nas|nas-octopus|gemini-3.7-flash
nas|nas-hy4|gemini-3.5-flash
nas|nas-hy4|deepseek-v4.1-flash
nas|nas-hy4|deepseek-v4.1-flash-sg
nas|nas-hy4|glm-5.3
nas|nas-hy4|gpt-6-astra
nas|nas-hy4|gemini-3.8-flash
nas|nas-hy4|kimi-k2.8-preview
nas|nas-hy4|hy3
nas|nas-hy4|hy4-preview-f'
# <<<OCR_CHAIN_SNAPSHOT<<<

log() { echo "[ocr-review] $*"; }

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "不在 git 仓内" >&2; exit 1; }
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 1
case "$GIT_COMMON_DIR" in
  /*|?:*) ;;  # 绝对路径（含盘符）
  *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
esac
cd "$REPO_ROOT" || exit 1
REPO_NAME="$(basename "$REPO_ROOT")"

FROM="${1:-HEAD~1}"
TO="${2:-HEAD}"
git rev-parse --verify "$FROM" >/dev/null 2>&1 || { echo "from ref 无效: $FROM" >&2; exit 1; }
git rev-parse --verify "$TO" >/dev/null 2>&1   || { echo "to ref 无效: $TO" >&2; exit 1; }
[ "$FROM" = "$TO" ] && { echo "from=to，无 diff 可评审"; exit 0; }

REPORT_LAST="$GIT_COMMON_DIR/ocr-review-last.txt"
REPORT_TMP="$GIT_COMMON_DIR/ocr-review-running.txt"
HOP_LOG="$GIT_COMMON_DIR/ocr-review-hop.log"
USAGE_LOG="$HOME/.dsh/hooks/ocr-pool-usage.log"
LOCK_DIR="$GIT_COMMON_DIR/ocr-review.lock"

# ── 并发锁（mkdir 原子锁；持锁进程死亡视为陈旧锁接管；OCR_REVIEW_FORCE=1 绕过）──
HELD_LOCK=0
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then HELD_LOCK=1; return 0; fi
  local lpid
  lpid="$(sed -n 's/^pid=//p' "$LOCK_DIR/info" 2>/dev/null)"
  if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
    log "已有评审进行中（pid=$lpid），本次跳过（OCR_REVIEW_FORCE=1 可并行）"
    return 1
  fi
  log "发现陈旧锁，接管"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || { log "无法建立锁目录"; return 1; }
  HELD_LOCK=1
}
if [ -z "${OCR_REVIEW_FORCE:-}" ]; then
  acquire_lock || exit 0
else
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR"; HELD_LOCK=1
fi
printf 'pid=%s\nstarted=%s\nfrom=%s\nto=%s\n' "$$" "$(date +%s)" "$FROM" "$TO" > "$LOCK_DIR/info" 2>/dev/null
trap '[ "$HELD_LOCK" -eq 1 ] && rm -rf "$LOCK_DIR"' EXIT INT TERM

# ── 载入降级链：链文件优先，内嵌快照兜底 ──
CHAIN_SRC=""
if [ -r "$CHAIN_FILE" ] && [ -s "$CHAIN_FILE" ] && grep -q '|' "$CHAIN_FILE" 2>/dev/null; then
  CHAIN_SRC="$(cat "$CHAIN_FILE")"
  CHAIN_ORIGIN="链文件 $CHAIN_FILE"
elif [ -n "$CHAIN_SNAPSHOT" ]; then
  CHAIN_SRC="$CHAIN_SNAPSHOT"
  CHAIN_ORIGIN="内嵌快照（链文件不可读）"
  log "警告：链文件不可读，使用内嵌快照兜底"
else
  log "致命：链文件与内嵌快照均不可用（$CHAIN_FILE）"
  exit 1
fi

HOPS="$(printf '%s\n' "$CHAIN_SRC" | sed 's/#.*//' | tr -d '\r' \
        | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep '|' | grep -v '^$')"
[ -z "$HOPS" ] && { log "致命：链为空"; exit 1; }

prov_has_key() {
  [ -n "$PY" ] || return 0   # 无 python 时不做预检，交给 ocr 自己报错
  "$PY" - "$1" <<'PYEOF' >/dev/null 2>&1
import json, os, sys
c = json.load(open(os.path.expanduser('~/.opencodereview/config.json'), encoding='utf-8'))
e = c.get('custom_providers', {}).get(sys.argv[1], {})
sys.exit(0 if e.get('api_key') else 1)
PYEOF
}

rm -f "$REPORT_TMP"
ATTEMPTS="$GIT_COMMON_DIR/ocr-review-attempts.txt"
: > "$ATTEMPTS"
START_TS=$(date +%s)
log "仓库=$REPO_NAME 区间=$FROM..$TO 链来源=$CHAIN_ORIGIN"

SUCCESS=0
USED_PROV=""; USED_MODEL=""
for line in $HOPS; do
  scope="${line%%|*}"; rest="${line#*|}"
  prov="${rest%%|*}";  model="${rest#*|}"
  now=$(date +%s); remaining=$((TOTAL_BUDGET - (now - START_TS)))
  if [ "$remaining" -le 60 ]; then log "全链总预算耗尽（${TOTAL_BUDGET}s），停止"; break; fi
  d=$(( remaining < HOP_DEADLINE ? remaining : HOP_DEADLINE ))
  if ! prov_has_key "$prov"; then
    log "跳过 $prov/$model（api_key 未配置）"
    printf '%s\t%s\t%s\t%s\tskip-nokey\t0\n' "$(date '+%F %T')" "$REPO_NAME" "$prov" "$model" >> "$ATTEMPTS"
    continue
  fi
  hop_start=$(date +%s)
  log "尝试 $scope $prov/$model（本跳上限 ${d}s）…"
  hop_rc=0
  timeout "$d" ocr review --provider "$prov" --model "$model" \
      --from "$FROM" --to "$TO" --timeout 15 --format text --audience agent \
      --output "$REPORT_TMP" >"$HOP_LOG" 2>&1 || hop_rc=$?
  secs=$(( $(date +%s) - hop_start ))
  if [ "$hop_rc" -eq 0 ] && [ -s "$REPORT_TMP" ]; then
    SUCCESS=1; USED_PROV="$prov"; USED_MODEL="$model"
    printf '%s\t%s\t%s\t%s\tok\t%s\n' "$(date '+%F %T')" "$REPO_NAME" "$prov" "$model" "$secs" >> "$ATTEMPTS"
    log "成功：provider=$prov model=$model 耗时=${secs}s"
    break
  elif [ "$hop_rc" -eq 124 ]; then
    printf '%s\t%s\t%s\t%s\tfail-timeout\t%s\n' "$(date '+%F %T')" "$REPO_NAME" "$prov" "$model" "$secs" >> "$ATTEMPTS"
    log "失败：$prov/$model 超时（${secs}s，达本跳上限）——单次超时不出链结论，下一棒"
  else
    printf '%s\t%s\t%s\t%s\tfail-rc=%s\t%s\n' "$(date '+%F %T')" "$REPO_NAME" "$prov" "$model" "$hop_rc" "$secs" >> "$ATTEMPTS"
    log "失败：$prov/$model 退出码 $hop_rc（详见 $HOP_LOG 末尾），下一棒"
    tail -5 "$HOP_LOG" 2>/dev/null | sed 's/^/    | /'
  fi
done

if [ "$SUCCESS" -eq 1 ]; then
  {
    echo "# OCR 评审报告 · $REPO_NAME"
    echo "# 时间：$(date '+%F %T')  区间：$FROM..$TO"
    echo "# provider：$USED_PROV  model：$USED_MODEL  链来源：$CHAIN_ORIGIN"
    echo "# 各跳尝试记录："
    cat "$ATTEMPTS"
    echo "# ───────────────────────── 评审正文 ─────────────────────────"
    echo ""
    cat "$REPORT_TMP"
  } > "$REPORT_LAST"
  rm -f "$REPORT_TMP" "$ATTEMPTS" "$HOP_LOG"
  mkdir -p "$(dirname "$USAGE_LOG")"
  printf '%s\t%s\t%s\t%s\tok\t%s\n' "$(date '+%F %T')" "$REPO_NAME" "$USED_PROV" "$USED_MODEL" "$secs" >> "$USAGE_LOG" 2>/dev/null
  echo "报告已写入：$REPORT_LAST"
  exit 0
else
  {
    echo "# OCR 评审报告 · $REPO_NAME（全链失败）"
    echo "# 时间：$(date '+%F %T')  区间：$FROM..$TO  链来源：$CHAIN_ORIGIN"
    echo "# 各跳尝试记录："
    cat "$ATTEMPTS"
  } > "$REPORT_LAST"
  rm -f "$REPORT_TMP" "$ATTEMPTS"
  [ -n "${USED_PROV:-}" ] || printf '%s\t%s\tALL\tALL\tfail-all\t%s\n' "$(date '+%F %T')" "$REPO_NAME" "$(($(date +%s)-START_TS))" >> "$USAGE_LOG" 2>/dev/null
  echo "全链失败，详见 $REPORT_LAST（评审 advisory，不影响推送）"
  exit 1
fi
