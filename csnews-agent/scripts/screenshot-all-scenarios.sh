#!/usr/bin/env bash
# Screenshot archival script for 5-layer security net verification.
# Uses Playwright MCP to screenshot the pull-viewer across 22 core scenarios.
# Screenshots stored at: csnews-agent/screenshots/<commit-hash>/
# Usage: bash screenshot-all-scenarios.sh [<commit-hash>]
#   commit-hash: optional; defaults to current git HEAD short hash.
#
# Required env vars:
#   CSNEWS_WORKER_URL  — e.g. https://your-worker.workers.dev/api/v1
#   CSNEWS_BEARER_TOKEN — bearer token for the worker API

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
GIT_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
VIEWER_PATH="$GIT_ROOT/tools/pull-viewer.html"
OUT_DIR="$AGENT_DIR/screenshots"

# Commit hash: arg1 or git HEAD
COMMIT_HASH="${1:-$(git -C "$GIT_ROOT" log -1 --format='%H')}"
SCREENSHOT_DIR="$OUT_DIR/$COMMIT_HASH"

# Required env vars
WORKER_URL="${CSNEWS_WORKER_URL:-}"
BEARER_TOKEN="${CSNEWS_BEARER_TOKEN:-}"

if [ -z "$WORKER_URL" ] || [ -z "$BEARER_TOKEN" ]; then
  echo "ERROR: CSNEWS_WORKER_URL and CSNEWS_BEARER_TOKEN must be set."
  echo "  export CSNEWS_WORKER_URL='https://your-worker.workers.dev/api/v1'"
  echo "  export CSNEWS_BEARER_TOKEN='your-token-here'"
  exit 1
fi

# ── Idempotent ────────────────────────────────────────────────────────────────
if [ -d "$SCREENSHOT_DIR" ]; then
  echo "Screenshots already exist for commit $COMMIT_HASH — skipping (idempotent)."
  echo "  dir: $SCREENSHOT_DIR"
  exit 0
fi

echo "=== Screenshot archival — commit $COMMIT_HASH ==="
echo "  worker  : $WORKER_URL"
echo "  out dir : $SCREENSHOT_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────────
# Call a Playwright MCP tool with JSON args.
# Usage: mcp <tool-name> <json-args-string>
mcp() {
  local tool="$1"
  local args="${2:-'{}'}"
  mavis mcp call playwright "$tool" "$args" 2>/dev/null
}

# Navigate to URL and wait for page load.
nav() {
  local url="$1"
  mcp browser_navigate "{\"url\": \"$url\"}" > /dev/null
  sleep 1.5
}

# Evaluate JavaScript expression in the page context.
eval_js() {
  local expr="$1"
  # Escape quotes for JSON; use cat <<< to avoid shell expansion issues.
  local escaped
  escaped="$(printf '%s' "$expr" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  mcp browser_evaluate "{\"expression\": $escaped}" > /dev/null
}

# Take a screenshot of the current page.
# Usage: shot <scenario-name>
shot() {
  local name="$1"
  local out="$SCREENSHOT_DIR/${name}.png"
  mcp browser_take_screenshot "{\"path\": \"$out\", \"fullPage\": true}" > /dev/null
  echo "  [OK] $name"
}

# ── Setup ────────────────────────────────────────────────────────────────────
mkdir -p "$SCREENSHOT_DIR"

# Convert file path to file:// URL
VIEWER_URL="file://$VIEWER_PATH"

echo "Opening viewer at $VIEWER_URL ..."
nav "$VIEWER_URL"

# Set localStorage config so the viewer uses the real worker.
# localStorage key follows: '<base>:config' where <base> = 'csnews-console'.
# The viewer uses: STORAGE.get('config', { baseUrl: '', token: '' })
eval_js "localStorage.setItem('csnews-console:config', JSON.stringify({baseUrl:'$WORKER_URL', token:'$BEARER_TOKEN'}))"

# Reload so the app picks up the config and fetches initial data.
echo "Reloading with config ..."
nav "$VIEWER_URL"
sleep 2  # let initial fetch settle

# ── Scenario 1: Dashboard overview ──────────────────────────────────────────
echo "Scenario 1/22: Dashboard overview ..."
eval_js "STATE.dashTab='overview'; switchView('dashboard'); renderDashTab();"
sleep 2
shot "01-dashboard-overview"

# ── Scenario 2: Reader news list ─────────────────────────────────────────────
echo "Scenario 2/22: Reader news list ..."
eval_js "switchView('reader');"
sleep 2
shot "02-reader-news-list"

# ── Scenario 3: Settings modal ───────────────────────────────────────────────
echo "Scenario 3/22: Settings modal ..."
eval_js "openSettings();"
sleep 1
shot "03-settings-modal"
eval_js "closeSettings();"
sleep 0.5

# ── Scenario 4: Pull News endpoint response ──────────────────────────────────
echo "Scenario 4/22: Pull News endpoint ..."
eval_js "STATE.dashTab='overview'; switchView('dashboard'); STATE.selectedEndpoint='pull-news'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "04-pull-news-endpoint"

# ── Scenario 5: Pull Topics endpoint response ─────────────────────────────────
echo "Scenario 5/22: Pull Topics endpoint ..."
eval_js "STATE.selectedEndpoint='pull-topics'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "05-pull-topics-endpoint"

# ── Scenario 6: Pull Warnings endpoint response ───────────────────────────────
echo "Scenario 6/22: Pull Warnings endpoint ..."
eval_js "STATE.selectedEndpoint='pull-warnings'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "06-pull-warnings-endpoint"

# ── Scenario 7: Pull Fission-pending endpoint response ────────────────────────
echo "Scenario 7/22: Pull Fission-pending endpoint ..."
eval_js "STATE.selectedEndpoint='pull-fission-pending'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "07-pull-fission-pending-endpoint"

# ── Scenario 8: Dashboard — Logs tab ─────────────────────────────────────────
echo "Scenario 8/22: Dashboard Logs tab ..."
eval_js "STATE.dashTab='logs'; renderDashTab();"
sleep 2
shot "08-dashboard-logs-tab"

# ── Scenario 9: Dashboard — Health tab ────────────────────────────────────────
echo "Scenario 9/22: Dashboard Health tab ..."
eval_js "STATE.dashTab='health'; renderDashTab();"
sleep 2
shot "09-dashboard-health-tab"

# ── Scenario 10: Health endpoint response ─────────────────────────────────────
echo "Scenario 10/22: Health endpoint ..."
eval_js "STATE.selectedEndpoint='health'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "10-health-endpoint"

# ── Scenario 11: Trend endpoint response ───────────────────────────────────────
echo "Scenario 11/22: Trend endpoint ..."
eval_js "STATE.selectedEndpoint='trend'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "11-trend-endpoint"

# ── Scenario 12: Entity endpoint response ─────────────────────────────────────
echo "Scenario 12/22: Entity endpoint ..."
eval_js "STATE.selectedEndpoint='entity'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "12-entity-endpoint"

# ── Scenario 13: Event endpoint response ─────────────────────────────────────
echo "Scenario 13/22: Event endpoint ..."
eval_js "STATE.selectedEndpoint='event'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "13-event-endpoint"

# ── Scenario 14: Event Clusters endpoint response ─────────────────────────────
echo "Scenario 14/22: Event Clusters endpoint ..."
eval_js "STATE.selectedEndpoint='event-clusters'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "14-event-clusters-endpoint"

# ── Scenario 15: Entity Review (entity-review dash tab) ───────────────────────
echo "Scenario 15/22: Entity Review dashboard tab ..."
eval_js "STATE.dashTab='entity-review'; renderDashTab();"
sleep 1
eval_js "refreshEntityReview();"
sleep 3
shot "15-entity-review-tab"

# ── Scenario 16: Entity Candidates endpoint response ──────────────────────────
echo "Scenario 16/22: Entity Candidates endpoint ..."
eval_js "STATE.selectedEndpoint='entity-candidates'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "16-entity-candidates-endpoint"

# ── Scenario 17: Entity Finalized endpoint response ────────────────────────────
echo "Scenario 17/22: Entity Finalized endpoint ..."
eval_js "STATE.selectedEndpoint='entity-finalized'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "17-entity-finalized-endpoint"

# ── Scenario 18: Knowledge daily endpoint response ──────────────────────────
echo "Scenario 18/22: Knowledge daily endpoint ..."
eval_js "STATE.selectedEndpoint='knowledge'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "18-knowledge-daily-endpoint"

# ── Scenario 19: Logs endpoint response ──────────────────────────────────────
echo "Scenario 19/22: Logs endpoint ..."
eval_js "STATE.selectedEndpoint='logs'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "19-logs-endpoint"

# ── Scenario 20: Content endpoint response ────────────────────────────────────
# Get first UUID from the pull-news response to use as content id.
echo "Scenario 20/22: Content endpoint ..."
eval_js "STATE.selectedEndpoint='content'; renderData();"
# Fill the content id param with a placeholder (actual UUID would come from STATE.items).
eval_js "const idInput = document.getElementById('param-id'); if(idInput) idInput.value = '00000000-0000-4000-8000-000000000001';"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "20-content-endpoint"

# ── Scenario 21: Event Cluster detail endpoint response ──────────────────────
echo "Scenario 21/22: Event Cluster detail endpoint ..."
eval_js "STATE.selectedEndpoint='event-cluster'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "21-event-cluster-endpoint"

# ── Scenario 22: Entity Selflearn endpoint response ──────────────────────────
echo "Scenario 22/22: Entity Selflearn endpoint ..."
eval_js "STATE.selectedEndpoint='entity-selflearn'; renderData();"
sleep 1
eval_js "runEndpoint();"
sleep 3
shot "22-entity-selflearn-endpoint"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== All 22 scenarios captured ==="
echo "  commit : $COMMIT_HASH"
echo "  out    : $SCREENSHOT_DIR"
echo "  files  : $(ls "$SCREENSHOT_DIR" | wc -l | tr -d ' ') PNGs"
echo ""
echo "Screenshot archival complete."

# Clean up browser session.
mcp browser_close '{}' > /dev/null 2>&1 || true

exit 0
