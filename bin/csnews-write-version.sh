#!/usr/bin/env bash
# ============================================================
# csnews-write-version.sh — v0.37.17
#
# Push 完成后,把当前 HEAD 的 git short SHA 写入 PROCESS_STATE KV 的
# `worker_git_sha` key,让 health 端点能拿到当前部署的真实 commit 编号。
#
# board decision v0.37.17: 直接用 commit 编号作为 worker_version,不再人手改
# wrangler.toml [vars].WORKER_VERSION。deploy 阶段由 csnews-self-push-loop
# 派活给 csnews main session,本脚本是 main session 跑完 `git push origin main`
# 之后**立刻**调用的 (push 在 CF auto-deploy 队列里,KV 写入秒级生效)。
#
# 用法:
#   ./bin/csnews-write-version.sh                  # 自动从 .git/HEAD 拿 commit
#   ./bin/csnews-write-version.sh 56926d7           # 显式指定 (CI / 修复旧值)
#
# 需要的工具:
#   - CLOUDFLARE_API_TOKEN env (wrangler secret 用的 token)
#   - wrangler CLI (csnews-agent devDep 装好)
#   - 当前 dir 是 csnews-agent/ 子目录 (wrangler.toml 在这)
#
# 退出码:
#   0  = worker_git_sha 写入成功
#   1  = wrangler kv:key put 失败 (CF 错误)
#   2  = 拿不到 commit SHA (git repo 不存在或 detached HEAD)
#   3  = CLOUDFLARE_API_TOKEN 缺失
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../csnews-agent"

# 接受 explicit arg 或从 git 自动取
if [ -n "$1" ]; then
  SHA="$1"
else
  if ! SHA="$(git rev-parse --short HEAD 2>/dev/null)"; then
    echo "[csnews-write-version] FAIL: unable to read commit SHA from git — check .git exists in $(pwd)" >&2
    exit 2
  fi
fi

# trim whitespace
SHA="$(echo "$SHA" | tr -d '[:space:]')"
if ! echo "$SHA" | grep -qE '^[0-9a-f]{4,40}$'; then
  echo "[csnews-write-version] FAIL: commit SHA '$SHA' is not a valid git hash" >&2
  exit 2
fi

# 缺 CLOUDFLARE_API_TOKEN 直接退出
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "[csnews-write-version] FAIL: CLOUDFLARE_API_TOKEN env missing — request token from Mavis / read MEMORY.md for token id" >&2
  exit 3
fi

UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

# 写入 KV — 用 JSON envelope (跟 last_process_at 一致格式) 让 health 端点能解析 updated_at
PAYLOAD="$(printf '{"_seed":{"fetchedAt":"%s","recordCount":1,"state":"ok","maxContentAgeMin":0},"data":{"worker_git_sha":{"sha":"%s","updated_at":"%s"}}}' \
  "$UPDATED_AT" "$SHA" "$UPDATED_AT")"

# PROCESS_STATE namespace id (paired with the CF API token; see MEMORY.md for token storage)
NS_ID="3be3cd1e5da544cd9b323f3b8a4af7a0"

echo "[csnews-write-version] writing PROCESS_STATE worker_git_sha = $SHA (updated_at=$UPDATED_AT)"

if ! echo "$PAYLOAD" | npx wrangler kv key put \
    "worker_git_sha" \
    --namespace-id "$NS_ID" \
    --remote - 2>&1; then
  echo "[csnews-write-version] FAIL: wrangler kv:key put failed — check token has Workers KV Storage:Edit scope" >&2
  exit 1
fi

echo "[csnews-write-version] OK: worker_git_sha=$SHA written to KV"
echo "[csnews-write-version]   verify with: curl 'https://csnews.kwokzit.info/api/v1?action=health'"
