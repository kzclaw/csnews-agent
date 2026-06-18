#!/usr/bin/env bash
# scripts/check-privacy.sh
# 戴舒柯 18:17 拍板: 所有项目测试都要有检验 commit message 和注释不能含 5 类硬禁词
# 戴舒柯 20:43 反问强化: 必从 git root 路径跑 (相对路径会 0 命中 = 假盖戳)
# 戴舒柯 20:46 反问强化: pre-commit hook 强制 verify (不能依赖人)
#
# 注: hook 跳过 validate/ + .githooks/ + scripts/ (这些是工具链, by-design 含 patterns)
# 注: hook 不跳过 PRE_EXISTING_WHITELIST (跟 contract test 不同) — 强制 0 命中
# 历史违规文件清理走 v0.36.22 大清理, 不在本 hook 范围

set -e

# 5 类硬禁词 (戴舒柯 18:17 拍板)
# 注: 不含单字"拍" (太多误报, 拍卖/拍照/拍电影)
PATTERNS='戴|大虾|舒柯|戴大宝|戴舒柯拍板|拍板权|kzclaw|KR[1-9]|kr[1-9]|Phase[1-9]|T[1-9][0-9]{2}|M[1-5]|Foundation[ \t]+[1-9]|kwokzit\.info|/Users/zitkwok'

# 检查 staged changes (新增行 + 行内), 跳过工具链 (validate/ + .githooks/ + scripts/)
# 戴舒柯 20:43 反问: 必从 git root 路径跑
STAGED_FILES=$(git diff --cached --name-only --diff-filter=AM | grep -vE '^(csnews-agent/)?(\.githooks/|scripts/|validate/)' || true)

if [ -z "$STAGED_FILES" ]; then
  echo '✅ privacy grep 5 类硬禁词 0 命中 (no user code staged)'
  exit 0
fi

VIOLATIONS=$(git diff --cached -- "$STAGED_FILES" | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$PATTERNS" | head -10 || true)

if [ -n "$VIOLATIONS" ]; then
  echo '❌ 5 类硬禁词违规 detected in staged changes (戴舒柯 18:17 拍板):'
  echo ''
  printf '%s\n' "$VIOLATIONS"
  echo ''
  echo '戴舒柯 18:17 拍板: 所有项目测试都要有检验 commit message 和注释不能含 5 类硬禁词'
  echo '戴舒柯 20:43 反问: 必从 git root 路径跑 (相对路径会 0 命中 = 假盖戳)'
  echo '戴舒柯 20:46 反问: pre-commit hook 强制 verify (不能依赖人)'
  echo ''
  echo '修法: 用通用描述代替 (例如: kzclaw → 用户 / 戴舒柯 → 戴舒柯 / 拍板 → 拍板)'
  exit 1
fi

echo '✅ privacy grep 5 类硬禁词 0 命中'
exit 0