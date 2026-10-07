#!/bin/sh
# ============================================================
# privacy-scan.sh · 隐私词扫描（入库 · 供 .husky/ 两个钩子调用）
#
# 用法:
#   privacy-scan.sh [patterns_file]                     仓库模式（.husky/pre-commit）
#   privacy-scan.sh -m|--message <msg_file> [patterns]  message 模式（.husky/commit-msg）
#   patterns_file 缺省 = <脚本所在目录>/../.privacy-patterns.txt
#
# 仓库模式（staged 判定属于 pre-commit 的职责）:
#   staged diff 命中              → block (exit 1)
#   最近 N 次 commit message 命中   → 仅告警 (exit 0)
#   历史只告警不阻塞: 历史 commit 已固化，改动前的仓库无法再拦截
#
# message 模式:
#   <msg_file> 命中 → block (exit 1) · 不读 .git/COMMIT_EDITMSG · 不依赖 git 仓库
#   git 钩子顺序为 pre-commit → prepare-commit-msg → commit-msg → 真正提交，
#   本次 message 到 commit-msg 阶段才定稿并以 $1 传入文件路径；
#   pre-commit 读 .git/COMMIT_EDITMSG 拿到的是上一条 commit 的陈旧内容。
#
# patterns 文件缺失或为空 → 红色告警「隐私闸门未启用」+ exit 0
#   patterns 文件内容本身就是禁词列表且被 gitignore，入库即泄露；
#   缺失时放行但必须显式暴露闸门状态，不能伪装成"扫描通过"。
#
# patterns 文件的注释与正则合法性:
#   整行以 # 开头（允许前导空白）的行是注释，不并入正则；
#   行内 # 保留 —— # 可能本身是 pattern 的一部分。
#   grep 退出码: 0=有命中 · 1=零命中(放行) · ≥2=正则编译失败/无法读取。
#   ≥2 一律 fail-closed(exit 1): 闸门自身失效时不作判定等于放行，
#   且绝不能打印成「零命中」—— 那等于把失效伪装成通过。
# ============================================================

HIST_DEPTH="${PRIVACY_HIST_DEPTH:-50}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PATTERNS_FILE=""
MSG_MODE=0
MSG_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message)
      if [ $# -lt 2 ]; then
        echo "[privacy-scan] 用法: $0 -m <msg_file> [patterns_file]"
        exit 1
      fi
      MSG_MODE=1
      MSG_FILE="$2"
      shift
      ;;
    -h|--help)
      echo "用法: $0 [-m|--message <msg_file>] [patterns_file]"
      exit 0
      ;;
    *)
      PATTERNS_FILE="$1"
      ;;
  esac
  shift
done

if [ -z "$PATTERNS_FILE" ]; then
  PATTERNS_FILE="$SELF_DIR/../.privacy-patterns.txt"
fi

# ---- 闸门状态检查：patterns 缺失 / 为空 → 显式告警，不静默通过 ----
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "[privacy-scan] ❌ 隐私闸门未启用: patterns 文件不存在 ($PATTERNS_FILE)"
  echo "[privacy-scan]    未执行任何隐私判定 · 本次提交不会被隐私词拦截"
  echo "[privacy-scan]    请创建该文件（禁词列表 · 本地文件不入库）后重新提交"
  exit 0
fi

# 注释行必须先剔掉再拼正则: 注释常在解释正则元字符(如未成对的括号)，
# 并进 alternation 会让整条正则编译失败；失败又曾被 `|| true` 吞成「零命中」，
# 等于一行注释就能让整个闸门静默失效。
PATTERNS="$(grep -vE '^[[:space:]]*(#|$)' "$PATTERNS_FILE" | paste -sd'|' -)"
if [ -z "$PATTERNS" ]; then
  echo "[privacy-scan] ❌ 隐私闸门未启用: patterns 文件为空 ($PATTERNS_FILE)"
  echo "[privacy-scan]    未执行任何隐私判定 · 本次提交不会被隐私词拦截"
  exit 0
fi

# 词库正则无效 → fail-closed。放在所有扫描点之前，三处调用同一份提示，
# 避免同一故障在不同模式下给出不同口径的结论。
die_invalid_patterns() {
  echo "[privacy-scan] ❌ BLOCK patterns_invalid: 词库正则无效（grep 退出码 $1）"
  echo "[privacy-scan]    patterns=$PATTERNS_FILE"
  echo "[privacy-scan]    闸门失效时不作判定等于放行，已按 fail-closed 挡住本次提交"
  echo "[privacy-scan]    修词库: 注释须整行以 # 开头；pattern 行本身须是合法正则（不得含未成对的 ( ) [ ] 等）"
}

# ---- message 模式：只扫 $1 传入的 message 文件 ----
if [ "$MSG_MODE" -eq 1 ]; then
  if [ ! -f "$MSG_FILE" ]; then
    echo "[privacy-scan] ❌ 隐私闸门无法判定: message 文件不存在 ($MSG_FILE)"
    exit 1
  fi
  MSG_HITS="$(grep -nE "($PATTERNS)" "$MSG_FILE")"
  MSG_RC=$?
  if [ "$MSG_RC" -ge 2 ]; then
    die_invalid_patterns "$MSG_RC"
    exit 1
  fi
  if [ -n "$MSG_HITS" ]; then
    echo "[privacy-scan] ❌ BLOCK commit_message_hits（本次 commit message 命中隐私词）:"
    printf '%s\n' "$MSG_HITS" | head -10
    echo "[privacy-scan] ❌ BLOCKED · 请清除隐私词后重试"
    exit 1
  fi
  echo "[privacy-scan] ✅ PASS commit_message_hits=0 file=$MSG_FILE"
  exit 0
fi

# ---- 仓库模式：staged diff ----
BLOCK=0
STAGED_HITS="$(git diff --cached | grep -nE "($PATTERNS)")"
STAGED_RC=$?
if [ "$STAGED_RC" -ge 2 ]; then
  die_invalid_patterns "$STAGED_RC"
  exit 1
fi
if [ -n "$STAGED_HITS" ]; then
  echo "[privacy-scan] ❌ BLOCK staged_diff_hits（staged diff 命中隐私词）:"
  printf '%s\n' "$STAGED_HITS" | head -10
  BLOCK=1
fi

# ---- 仓库模式：最近 N 次 commit message 仅告警 ----
HIST_LOG="$(git log -n "$HIST_DEPTH" --pretty=format:'%h %s%n%b' 2>/dev/null || true)"
# 同一正则已在上面 staged 那步编译过一次，rc≥2 实际不可达；
# 这里仍按 fail-closed 收口，保证文件里不残留任何会吞掉 grep 失败的点 ——
# 否则一旦将来改动正则拼装，失效就会伪装成「历史零命中」的干净结论。
HIST_HITS="$(printf '%s\n' "$HIST_LOG" | grep -E "($PATTERNS)")"
HIST_RC=$?
if [ "$HIST_RC" -ge 2 ]; then
  die_invalid_patterns "$HIST_RC"
  exit 1
fi
HIST_COUNT="$(printf '%s\n' "$HIST_HITS" | grep -c . || true)"
if [ "$HIST_COUNT" -gt 0 ]; then
  echo "[privacy-scan] ⚠️ WARN history_hits=${HIST_COUNT} depth=${HIST_DEPTH}（仅告警 · 不阻塞 commit）"
  printf '%s\n' "$HIST_HITS" | head -3 | sed 's/^/    样例: /'
  echo "    历史违规待清理（本次不阻塞）"
fi

if [ "$BLOCK" -ne 0 ]; then
  echo "[privacy-scan] ❌ BLOCKED · 请清除隐私词后重试"
  exit 1
fi

echo "[privacy-scan] ✅ PASS staged_diff_hits=0 history_hits=${HIST_COUNT}"
exit 0
