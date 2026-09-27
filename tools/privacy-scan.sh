#!/bin/sh
# ============================================================
# privacy-scan.sh · commit 隐私扫描（.husky/pre-commit Step 1 调用）
#
# 用法: privacy-scan.sh [patterns_file]
#   patterns_file 缺省 = <脚本所在目录>/../.privacy-patterns.txt
#
# 对 cwd 所在 git 仓库做三级判定:
#   1. staged diff 命中              → block (exit 1)
#   2. 本次 commit message 命中       → block (exit 1) · 读 .git/COMMIT_EDITMSG
#   3. 最近 N 次 commit message 命中   → 仅告警 (exit 0)
#
# 级别 3 只告警不阻塞: 历史 commit 已固化，改动前仓库无法再提交
# ============================================================

HIST_DEPTH="${PRIVACY_HIST_DEPTH:-50}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PATTERNS_FILE="${1:-$SELF_DIR/../.privacy-patterns.txt}"

if [ ! -f "$PATTERNS_FILE" ]; then
  echo "[privacy-scan] ⏭ patterns 文件不存在 ($PATTERNS_FILE) · 扫描跳过"
  exit 0
fi

PATTERNS="$(grep -vE '^[[:space:]]*$' "$PATTERNS_FILE" | paste -sd'|' -)"
if [ -z "$PATTERNS" ]; then
  echo "[privacy-scan] ⏭ patterns 文件为空 · 扫描跳过"
  exit 0
fi

BLOCK=0

# ---- 级别 1: staged diff 命中 → block ----
STAGED_HITS="$(git diff --cached | grep -nE "($PATTERNS)" || true)"
if [ -n "$STAGED_HITS" ]; then
  echo "[privacy-scan] ❌ BLOCK staged_diff_hits（staged diff 命中隐私词）:"
  printf '%s\n' "$STAGED_HITS" | head -10
  BLOCK=1
fi

# ---- 级别 2: 本次 commit message 命中 → block ----
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
EDITMSG="$GIT_DIR/COMMIT_EDITMSG"
if [ -f "$EDITMSG" ]; then
  MSG_HITS="$(grep -nE "($PATTERNS)" "$EDITMSG" || true)"
  if [ -n "$MSG_HITS" ]; then
    echo "[privacy-scan] ❌ BLOCK commit_message_hits（本次 commit message 命中隐私词）:"
    printf '%s\n' "$MSG_HITS" | head -10
    BLOCK=1
  fi
else
  echo "[privacy-scan] ⏭ 无 COMMIT_EDITMSG · 跳过 commit message 扫描"
fi

# ---- 级别 3: 最近 N 次 commit message 命中 → 仅告警 ----
HIST_LOG="$(git log -n "$HIST_DEPTH" --pretty=format:'%h %s%n%b' 2>/dev/null || true)"
HIST_HITS="$(printf '%s\n' "$HIST_LOG" | grep -E "($PATTERNS)" || true)"
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

echo "[privacy-scan] ✅ PASS staged_diff_hits=0 commit_message_hits=0 history_hits=${HIST_COUNT}"
exit 0
