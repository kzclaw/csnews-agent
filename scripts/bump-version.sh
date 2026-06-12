#!/bin/bash
# ============================================================
# scripts/bump-version.sh
# kzclaw 2026-06-12 21:40 确定 v0.36.3
# pre-commit hook: 自动把 csnews-agent/wrangler.toml 的 WORKER_VERSION 替换成当前 git commit 短 hash
# ============================================================

set -e

WRANGLER_TOML="csnews-agent/wrangler.toml"

if [ ! -f "$WRANGLER_TOML" ]; then
  echo "[bump-version] $WRANGLER_TOML 不存在, 跳过"
  exit 0
fi

# 仅当 wrangler.toml 已被 staged 时替换
if ! git diff --cached --name-only | grep -q "^$WRANGLER_TOML$"; then
  echo "[bump-version] $WRANGLER_TOML 未被 staged, 跳过 (本次 commit 不改 wrangler.toml)"
  exit 0
fi

# 读 STAGED 版本 (含当前 staged 改动) 的 git tree hash
STAGED_HASH=$(git write-tree)
SHORT_HASH=$(git rev-parse --short "$STAGED_HASH")

OLD_VERSION=$(grep "^WORKER_VERSION" "$WRANGLER_TOML" | sed -E 's/.*= *"([^"]+)".*/\1/')

if grep -q "^WORKER_VERSION" "$WRANGLER_TOML"; then
  sed -i.bak -E "s|^WORKER_VERSION *= *\"[^\"]*\"|WORKER_VERSION = \"$SHORT_HASH\"|" "$WRANGLER_TOML"
  rm -f "$WRANGLER_TOML.bak"
  echo "[bump-version] $OLD_VERSION -> $SHORT_HASH"
  git add "$WRANGLER_TOML"
else
  echo "[bump-version] wrangler.toml 没有 WORKER_VERSION 字段, 跳过"
  exit 0
fi
