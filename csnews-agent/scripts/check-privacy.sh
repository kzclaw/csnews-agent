#!/usr/bin/env bash
# Pre-commit privacy check: 5-class forbidden terms in staged changes
# Skip tooling directories (validate/ + .githooks/ + scripts/) which by-design contain pattern strings

set -e

# 5-class forbidden terms (regex alternation · required by hard rule)
# Note: standalone 拍 excluded (too many FPs: 拍卖/拍照/拍电影)
PATTERNS='戴|大虾|舒柯|戴大宝|戴舒柯拍板|拍板权|kzclaw|KR[1-9]|kr[1-9]|Phase[1-9]|T[1-9][0-9]{2}|M[1-5]|Foundation[ \t]+[1-9]|kwokzit\.info|/Users/zitkwok'

# Check staged changes, skip tooling directories
STAGED_FILES=$(git diff --cached --name-only --diff-filter=AM | grep -vE '^(csnews-agent/)?(\.githooks/|scripts/|validate/)' || true)

if [ -z "$STAGED_FILES" ]; then
  echo '✅ privacy check 0 命中 (no user code staged)'
  exit 0
fi

VIOLATIONS=$(git diff --cached -- "$STAGED_FILES" | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$PATTERNS" | head -10 || true)

if [ -n "$VIOLATIONS" ]; then
  echo '❌ 5-class forbidden terms detected in staged changes:'
  echo ''
  printf '%s\n' "$VIOLATIONS"
  echo ''
  echo 'See validate/privacy-grep.contract.ts for the full forbidden-terms list.'
  echo 'Replace forbidden terms with generic descriptions in your code/comments.'
  exit 1
fi

echo '✅ privacy check 5-class forbidden terms 0 命中'
exit 0