#!/bin/bash
# ocr 评审包装脚本（zcode-advisor）
#
# 设计（与 ~/.dsh/AGENTS.md 一致）：
#   - 评审工具**不进 CI**：模型网关是内网地址（192.168.50.139），GitHub runner 够不着；
#     拦截靠 CI 的确定性检查，评审只作为 advisory 关卡。
#   - 也**不定时跑**：只在每个 PR 合并前调用一次。
#
# 模型降级链（provider|model，与 ~/.opencodereview/config.json 的 custom_providers 对应）：
#   ⚠️ 本脚本含云端 provider，**只允许公开仓使用**（云端会把代码发往第三方）；
#      私有仓用 ocr-review.sh.private 变体（NAS-only，见 ~/.dsh/templates/ocr-review/）。
#   前四棒全 0 倍率免费（2026-10-04 成本优先，避开 kimi-k3 等贵模型）：
#   主    nas-hy4     -> deepseek-v4.1-flash （8787 免费，工具调用已实测）
#   备用① nas-octopus -> glm-5.3-flash      （8088 PM-API 免费分组）
#   备用② nas-hy4     -> hy3                （8787 免费）
#   备用③ nas-hy4     -> hy4-preview-f      （8787 免费）
#   备用④ x666        -> ministral-14b-latest （云端 0 倍率，工具调用已实测）
#   备用⑤ lucky-gem   -> gemini-3.6-flash   （云端，主人提供 key，工具调用已实测）
#   备用⑥ lucky       -> stealth/space-bunny-alpha （云端，工具调用已实测）
#   备用⑦ lucky       -> step-5-preview     （云端，工具调用已实测）
#   备用⑧ daigua      -> gpt-6-sol          （云端，顾问生产验证过工具调用）
# 用法：
#   ./scripts/ocr-review.sh              # 默认基准 origin/dev（不存在则回退 main）
#   ./scripts/ocr-review.sh v1.8.8       # 对比 tag / 分支
#   ./scripts/ocr-review.sh main HEAD   # 指定 from/to

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# ── 并发锁（实测教训）──
# pre-push hook 每次推送都会起一个评审，而完整评审要 5–15 分钟。
# 连续推送（或 tag + main 分开推）会让多个评审同时跑：既争抢上游配额，
# 又争抢同一个报告文件 .git/ocr-review-last.txt，且各自耗内存。
# 实测曾同时存在 6 个 ocr review 进程，最久的已跑 38 分钟。
#
# 用 mkdir 做原子锁（POSIX 下最可靠；flock 在 macOS 上不可用）。
# 锁内含 pid + 起始时间；发现锁时：
#   - 持锁进程仍活着 → 提示并退出（不重复评审）
#   - 持锁进程已死（崩溃/被 kill）→ 视为陈旧锁，接管
LOCK_DIR="$REPO_ROOT/.git/ocr-review.lock"
LOCK_INFO="$LOCK_DIR/info"
# OCR_REVIEW_FORCE=1 可绕过（需要并行评审时显式指定）
if [ -z "${OCR_REVIEW_FORCE:-}" ]; then
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'pid=%s\nstarted=%s\n' "$$" "$(date +%s)" > "$LOCK_INFO"
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
  else
    HOLD_PID=""
    [ -f "$LOCK_INFO" ] && HOLD_PID="$(sed -n 's/^pid=//p' "$LOCK_INFO" 2>/dev/null)"
    if [ -n "$HOLD_PID" ] && kill -0 "$HOLD_PID" 2>/dev/null; then
      echo "[ocr-review] 已有评审在进行（pid ${HOLD_PID}），本次跳过以免重复消耗。"
      echo "[ocr-review] 已有报告：$REPO_ROOT/.git/ocr-review-last.txt"
      echo "[ocr-review] 如需强制并行，设 OCR_REVIEW_FORCE=1"
      exit 0
    fi
    # 陈旧锁：持锁进程已不存在，接管
    echo "[ocr-review] 发现陈旧锁（pid ${HOLD_PID:-未知} 已退出），接管"
    printf 'pid=%s\nstarted=%s\n' "$$" "$(date +%s)" > "$LOCK_INFO"
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
  fi
fi

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
[ -n "$AGENT_MODEL" ] && echo "（编码代理当前模型：${AGENT_MODEL}，评审将优先使用其他 provider）"

# 降级链：逐个尝试，第一个**产出有效 JSON** 的即采用
CHAIN=(
  "nas-hy4|deepseek-v4.1-flash"
  "nas-octopus|glm-5.3-flash"
  "nas-hy4|hy3"
  "nas-hy4|hy4-preview-f"
  "x666|ministral-14b-latest"
  "lucky-gem|gemini-3.6-flash"
  "lucky|stealth/space-bunny-alpha"
  "lucky|step-5-preview"
  "daigua|gpt-6-sol"
)

# 模板必须以 XXXXXX 结尾：GNU mktemp 把 -t 当 --tmpdir 并要求该后缀（BSD/macOS 两者都接受）。
TMPDIR_OCR="${TMPDIR:-/tmp}"
OUT_JSON="$(mktemp "${TMPDIR_OCR%/}/ocr-review-XXXXXX" 2>/dev/null)" || {
  echo "错误：无法创建临时文件（mktemp 失败）" >&2; exit 1;
}
[ -n "$OUT_JSON" ] || { echo "错误：mktemp 未返回路径" >&2; exit 1; }
ATTEMPT_LOG=""
# OCR_REVIEW_RAW_OUT（可选，由调用方提供，例如 pre-push hook）：把 ocr 的**原始 JSON**
# 另存一份。它是权威产物（下面的渲染表由它生成），而 OUT_JSON 只是 mktemp 临时文件、
# 退出时被本函数删掉 —— 此前评审成功后原始 JSON 一并消失，事后无法复核或重渲染。
#
# 两道守卫，缺一不可：
#   - `$CHOSEN` 非空 = 确有一跳产出完整评审。**不能**只看 OUT_JSON 非空：链全失败时
#     OUT_JSON 里留着最后一跳的 partial/无效输出，照拷会把上一份好结论覆盖成半成品。
#   - 命中锁而提前退出的进程根本走不到这里（锁检查在 OUT_JSON 创建之前）。
cleanup() {
  if [ -n "${OCR_REVIEW_RAW_OUT:-}" ] && [ -n "${CHOSEN:-}" ]; then
    # 这里不再检查 OUT_JSON 非空：$CHOSEN 只在 valid_output 通过后赋值，而 valid_output
    # 首行就是 [ -s "$OUT_JSON" ]，故「CHOSEN 非空」已蕴含「有完整评审可拷」。
    if [ -d "$OCR_REVIEW_RAW_OUT" ]; then
      # 传目录进来时 cp/mv 会把文件塞进目录、还顺带覆盖同名文件，与「保存到该路径」的
      # 契约不符；明确拒绝好过默默塞进去。（[ -d ] 跟随符号链接，指向目录的链接同样被拒。）
      echo "警告：OCR_REVIEW_RAW_OUT=$OCR_REVIEW_RAW_OUT 是目录（期望文件路径），跳过保存原始 JSON" >&2
    else
      # 先写同目录临时文件再 mv，而不是直接 cp：
      #   ① cp 是「打开目标→截断→写入」，并发读者会看到 0 字节或半截文件；本脚本用
      #      OCR_REVIEW_FORCE=1 明确支持并行运行，两个评审会争同一目标，必须原子发布。
      #   ② cp 会**跟随**目标符号链接（把内容写穿到链接指向的文件）；mv 替换链接本身。
      #   ③ 只有同目录的 mv 才是原子的（跨文件系统会退化成 copy+unlink）。
      #   ④ 临时名必须**不可预测**：用 "${TARGET}.tmp.$$" 这种可枚举（PID）的名字，
      #      攻击者能预置同名符号链接，cp 会跟随它把内容写穿到任意文件（已实测复现）。
      #      mktemp 在目标同目录创建、名随机，且 O_EXCL 保证不会被既有文件/链接抢占。
      local _raw_dir _raw_tmp
      _raw_dir="$(dirname "$OCR_REVIEW_RAW_OUT")"
      _raw_tmp="$(mktemp "${_raw_dir%/}/.ocr-raw-XXXXXX" 2>/dev/null)" || _raw_tmp=""
      if [ -z "$_raw_tmp" ]; then
        echo "警告：无法在 $_raw_dir 创建临时文件，保存原始 JSON 到 $OCR_REVIEW_RAW_OUT 失败（事后复核将不可用）" >&2
      elif ! cp -f "$OUT_JSON" "$_raw_tmp" 2>/dev/null || ! mv -f "$_raw_tmp" "$OCR_REVIEW_RAW_OUT" 2>/dev/null; then
        # 静默失败最坑：这个功能存在的意义就是「事后能复核」，写不成功必须说一声。
        # 但不改退出码——cleanup 不该篡改脚本本身的成败。
        rm -f "$_raw_tmp" 2>/dev/null || true
        echo "警告：保存原始 JSON 到 $OCR_REVIEW_RAW_OUT 失败（事后复核将不可用）" >&2
      fi
      # 已知残余窗口：上面 [ -d ] 与 mv 之间，目标仍可能被并发替换成目录，此时 mv 会把
      # 文件移进该目录。能这么做的人对目标目录已有写权限、本可径直覆盖报告文件，
      # 故此处只做「更早发现」，不宣称已消除该竞态。
    fi
  fi
  rm -f "$OUT_JSON" ${ATTEMPT_LOG:+"$ATTEMPT_LOG"}
}
trap cleanup EXIT INT TERM

# 判定一次尝试是否真正成功：退出码为 0 **且** 评审确实完整完成。
#
# 判定依据来自 ocr 自身的状态枚举（从其二进制字符串表提取，2026-09 实测）：
#   TerminalState = complete | partial | failed | skipped | aborted | legacy
# 其中只有 `complete` 表示「全部选中项都评审完成」；`partial` 会打印
# "Review partially complete: N finding(s); M of K selected item(s) failed."。
#
# 为什么用**白名单**而不是黑名单：黑名单已被咬过两次——
#   ① {"status":"failed",...}（无 comments）曾被当成干净通过；
#   ② 补上 failed/error/cancelled 后，{"status":"partial","comments":[]} 仍被当成通过。
# 只认 `complete` 才不会再有第三个未知状态漏过。
#
# 注意：**不能**用 retry_report.failed_requests 当判据——plan 阶段的失败
# （日志里的 "continuing without plan"）不影响评审覆盖，按它判定会在上游限流时
# 误拒完整结果、触发无谓重跑。覆盖完整性以 status 为准。
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

# 白名单：只有 complete 才算完整评审
if str(data.get("status") or "").lower() != "complete":
    sys.exit(1)

# comments 必须存在且为数组（0 条也是合法的"未发现问题"）
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
    echo "  跳过 ${provider}（$model 正被编码代理占用）"
    SKIPPED=$((SKIPPED + 1))
    [ "$SKIPPED" -eq "${#CHAIN[@]}" ] && SKIPPED_ALL=1
    continue
  fi
  # 每次尝试前清空，防止失败后残留上次结果被误判为成功
  : > "$OUT_JSON"
  ATTEMPT_LOG="$(mktemp "${TMPDIR_OCR%/}/ocr-attempt-XXXXXX" 2>/dev/null || true)"
  echo "  尝试 provider=$provider model=$model …"
  # --concurrency 2：ocr 默认并发 8 个子任务（每组还有多轮工具调用），实测会打满
  # x666 的「25 请求/5 分钟」限流（429）——连续 6 次评审全灭的根因。降并发换稳。
  # 可用 OCR_REVIEW_CONCURRENCY 覆盖；限流充裕的 provider 可设回 8。
  # --exclude 图片：assets/icon.png 是 ~1MB 二进制，进 diff 会塞爆每个分组的上下文，
  # 实测两个模型全部返回空 comments（20 组全灭）——二进制资产对文本评审只有噪音。
  if ocr review --from "$FROM" --to "$TO" --format json --output "$OUT_JSON" \
       --concurrency "${OCR_REVIEW_CONCURRENCY:-2}" \
       --exclude '**/*.png,**/*.ico,**/*.icns,**/*.jpg,**/*.jpeg,**/*.gif,**/*.pdf' \
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
    echo "错误：所有 provider 都因与编码代理同模型被跳过（agent-model=${AGENT_MODEL}）。" >&2
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
