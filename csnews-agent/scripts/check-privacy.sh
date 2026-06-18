#!/usr/bin/env bash
# Pre-commit privacy check: 5-class forbidden terms in staged changes
# Skip tooling directories (validate/ + .githooks/ + scripts/) which by-design contain pattern strings
# Patterns loaded from .privacy-patterns.txt (local, gitignored) — see .privacy-patterns.txt.example

set -e

# Load patterns from local file (gitignored, per-developer)
GIT_ROOT=$(git rev-parse --show-toplevel)
PATTERNS_FILE="$GIT_ROOT/.privacy-patterns.txt"
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "❌ .privacy-patterns.txt not found (戴舒柯 21:50 拍板)"
  echo "Run: cp .privacy-patterns.txt.example .privacy-patterns.txt"
  exit 1
fi
PATTERNS=$(paste -sd'|' "$PATTERNS_FILE")

# Check staged changes (paths relative to git root, regardless of cwd)
# Skip tooling directories
RAW_STAGED=$(git -C "$GIT_ROOT" diff --cached --name-only --diff-filter=AM)
STAGED_FILES=""
for f in $RAW_STAGED; do
  case "$f" in
    .githooks/*|.githooks) continue ;;
    scripts/*|scripts) continue ;;
    validate/*|validate) continue ;;
    csnews-agent/.githooks/*|csnews-agent/.githooks) continue ;;
    csnews-agent/scripts/*|csnews-agent/scripts) continue ;;
    csnews-agent/validate/*|csnews-agent/validate) continue ;;
  esac
  STAGED_FILES="$STAGED_FILES $f"
done
# Trim leading space
STAGED_FILES=$(echo "$STAGED_FILES" | sed 's/^ *//')

if [ -z "$STAGED_FILES" ]; then
  echo '✅ privacy check 0 命中 (no user code staged)'
  exit 0
fi

# Check each staged file for forbidden patterns in added lines
VIOLATIONS=""
for f in $STAGED_FILES; do
  MATCHES=$(git -C "$GIT_ROOT" diff --cached -- "$f" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$PATTERNS" | head -10 || true)
  if [ -n "$MATCHES" ]; then
    VIOLATIONS="${VIOLATIONS}${MATCHES}"$'\n'
  fi
done

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