#!/usr/bin/env bash
# Pre-commit privacy check: 5-class forbidden terms in staged changes
# Skip tooling directories (validate/ + .githooks/ + scripts/) which by-design contain pattern strings
# Patterns loaded from .privacy-patterns.txt (local, gitignored) — see .privacy-patterns.txt.example

set -e

# Load patterns from local file (gitignored, per-developer)
PATTERNS_FILE=".privacy-patterns.txt"
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "❌ .privacy-patterns.txt not found (戴舒柯 21:50 拍板)"
  echo "Run: cp .privacy-patterns.txt.example .privacy-patterns.txt"
  exit 1
fi
PATTERNS=$(paste -sd'|' "$PATTERNS_FILE")

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
  echo 'See .privacy-patterns.txt for the forbidden-terms list.'
  echo 'Replace forbidden terms with generic descriptions in your code/comments.'
  exit 1
fi

echo '✅ privacy check 5-class forbidden terms 0 命中'
exit 0