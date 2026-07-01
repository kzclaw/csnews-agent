// ============================================================
// health-main.ts — top-level health endpoint handler
// ============================================================
// Orchestrates all health checks from health-checks.ts sub-modules.
// 17 dimensions covering: cron, KV, R2, Supabase, cache, AI budget,
// entity/event freshness, Neurons usage, and MCP tools.
// ============================================================

import { Env, jsonResponse } from './shared';
import { MCP_TOOLS_COUNT } from './mcp-tools';
import {
  checkLastProcessAt,
  checkSecretResolved,
  checkSupabaseCounts,
  checkR2LatestWrite,
  checkR2LatestSupabaseWrite,
  checkR2PrefixCounts,
  checkCronHistory,
  checkZscoreSignals,
  checkAiBudget,
  checkEntityAndEventFreshness,
  checkCacheMetrics,
  checkPullCacheFreshness,
  checkAiCallsBreakdown,
  checkLastProcessStoredReason,
  checkWorkerGitSha,
} from './health-checks';
import { DATA_STORE_ARCHITECTURE } from './health-db';

export async function handleHealthAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const ts = Date.now();
  // v0.37.16: added 'info' status to the union so cold-archive / by-design
  // signals don't get conflated with degraded or down.
  const checks: Record<
    string,
    { status: 'ok' | 'info' | 'degraded' | 'down' | 'unknown'; detail: any }
  > = {};
  const result: any = { status: 'ok', ts };

  // v0.37.17 (v0.37.17 board decision): worker_version 字段改成从 PROCESS_STATE KV 读 `worker_git_sha`
  // (deploy 之后由 csnews-write-version.sh 包装脚本写). fallback 'unknown' 表示 KV 还没写入
  // (例如首次 deploy + 还没跑过 bin/csnews-write-version.sh). 之后再额外存顶层 worker_git_sha 字段
  // 让 dashboard / 监控脚本能直接拿到结构化 {sha, updated_at}.
  const workerVersionResult = await checkWorkerGitSha(env);
  const storedSha = workerVersionResult.worker_git_sha;
  if (storedSha && !('error' in storedSha) && (storedSha as any).sha) {
    result.worker_version = (storedSha as any).sha;
    result.worker_git_sha = storedSha;
  } else {
    result.worker_version = 'unknown';
    result.worker_git_sha = storedSha;
  }
  checks.worker_git_sha = workerVersionResult.checks.worker_git_sha;

  // 1-2. last_process_at + cron_health
  const lastProcessResult = await checkLastProcessAt(env, ts);
  result.last_process_at = lastProcessResult.last_process_at;
  result.cron_health = lastProcessResult.cron_health;
  checks.last_process_at = lastProcessResult.checks.last_process_at;
  checks.cron_health = lastProcessResult.checks.cron_health;

  // 3. secret_resolved
  const secretResult = checkSecretResolved(env);
  checks.secret_resolved = secretResult.checks.secret_resolved;

  // 4-5. supabase_counts + supabase_reachable
  const supabaseResult = await checkSupabaseCounts(env);
  result.supabase_counts = supabaseResult.supabase_counts;
  checks.supabase_reachable = supabaseResult.checks.supabase_reachable;

  // 6. r2_latest_write (cold archive)
  const r2LatestResult = await checkR2LatestWrite(env, ts);
  result.r2_latest_write = r2LatestResult.r2_latest_write;
  // v0.37.16: explicit cold-archive alias so consumers don't have to know
  // the storage role from the field name alone.
  result.r2_cold_archive_latest_write = r2LatestResult.r2_latest_write;
  checks.r2_latest_write = r2LatestResult.checks.r2_latest_write;

  // 7. r2_latest_supabase_write (primary store)
  const r2SupabaseResult = await checkR2LatestSupabaseWrite(env, ts);
  result.r2_latest_supabase_write = r2SupabaseResult.r2_latest_supabase_write;
  // v0.37.16: canonical name for the primary-store health field.
  // Old name kept as alias for backward compatibility.
  result.supabase_latest_write = r2SupabaseResult.r2_latest_supabase_write;
  checks.r2_latest_supabase_write = r2SupabaseResult.checks.r2_latest_supabase_write;
  // Also expose the check under the new canonical name so dashboards can
  // aggregate status without having to know the legacy key.
  checks.supabase_latest_write = r2SupabaseResult.checks.r2_latest_supabase_write;

  // 7.1 v0.37.16: top-level data_store_architecture — single source of truth
  // for which store is primary vs cold archive, so consumers (dashboard,
  // scripts, alerts) don't have to reverse-engineer the layout.
  result.data_store_architecture = DATA_STORE_ARCHITECTURE;

  // 7.2 v0.37.16: surface "why R2 isn't getting new writes" from the most
  // recent process run. Read from PROCESS_STATE KV (TTL 2h, refreshed each
  // hourly cron). Avoids re-running the full process pipeline on every
  // health call.
  const storedReasonResult = await checkLastProcessStoredReason(env);
  result.last_process_stored_reason = storedReasonResult.last_process_stored_reason;
  checks.last_process_stored_reason = storedReasonResult.checks.last_process_stored_reason;

  // 8. r2_prefix_counts (aggregate prefix-level status)
  const r2PrefixResult = await checkR2PrefixCounts(env);
  result.r2_prefix_counts = r2PrefixResult.r2_prefix_counts;
  const r2PrefixErrorCount = Object.values(r2PrefixResult.r2_prefix_counts).filter(
    (v) => typeof v === 'object' && 'error' in v
  ).length;
  checks.r2_prefix_counts = {
    status:
      r2PrefixErrorCount === 0
        ? 'ok'
        : r2PrefixErrorCount < Object.keys(r2PrefixResult.r2_prefix_counts).length
          ? 'degraded'
          : 'down',
    detail: `${r2PrefixErrorCount}/${Object.keys(r2PrefixResult.r2_prefix_counts).length} prefixes failed`,
  };

  // 9. cron_history
  const cronHistoryResult = await checkCronHistory(env, ts);
  result.cron_history = cronHistoryResult.cron_history;
  checks.cron_history = cronHistoryResult.checks.cron_history;

  // 10. zscore_signals_today
  const zscoreResult = await checkZscoreSignals(env, ts);
  result.zscore_signals_today = zscoreResult.zscore_signals_today;
  checks.zscore_signals_today = zscoreResult.checks.zscore_signals_today;

  // 11. ai_budget_today
  const aiBudgetResult = await checkAiBudget(env);
  result.ai_budget_today = aiBudgetResult.ai_budget_today;
  checks.ai_budget_today = aiBudgetResult.checks.ai_budget_today;

  // 11.1 Phase 4: 顶层 alias (matches the Phase 4 design JSON example:
  //   neurons_daily_limit / neurons_remaining are also available as ai_budget_today
  //   sub-object fields, but flattened here so business consumers can read them
  //   directly from the top-level response.)
  if (aiBudgetResult.ai_budget_today && !('error' in aiBudgetResult.ai_budget_today)) {
    const ab = aiBudgetResult.ai_budget_today;
    result.neurons_daily_limit = ab.daily_limit;
    result.neurons_remaining = ab.remaining;
  }

  // 12-13. entity_freshness + event_freshness
  const freshnessResult = await checkEntityAndEventFreshness(env);
  result.entity_freshness = freshnessResult.entity_freshness;
  result.event_freshness = freshnessResult.event_freshness;
  checks.entity_freshness = freshnessResult.checks.entity_freshness;
  checks.event_freshness = freshnessResult.checks.event_freshness;

  // 14. cache_metrics
  const cacheResult = checkCacheMetrics();
  result.cache_metrics = cacheResult.cache_metrics;
  checks.cache_metrics = cacheResult.checks.cache_metrics;

  // 15. pull_cache_freshness
  const pullCacheFreshnessResult = await checkPullCacheFreshness(env, ts);
  result.pull_cache_freshness = pullCacheFreshnessResult.pull_cache_freshness;
  checks.pull_cache_freshness = pullCacheFreshnessResult.checks.pull_cache_freshness;

  // 16-18. neurons + budget_status + ai_calls_breakdown
  const aiCallsResult = await checkAiCallsBreakdown(env);
  result.neurons_used_today = aiCallsResult.neurons_used_today;
  result.ai_budget_status = aiCallsResult.ai_budget_status;
  result.ai_calls_breakdown = aiCallsResult.ai_calls_breakdown;
  checks.ai_calls_breakdown = aiCallsResult.checks.ai_calls_breakdown;

  // 19. mcp_tools_count (static count from handler registration)
  result.mcp_tools_count = MCP_TOOLS_COUNT;

  // ---- aggregate overall status ----
  const statuses = Object.values(checks)
    .filter(
      (c): c is { status: 'ok' | 'info' | 'degraded' | 'down' | 'unknown'; detail: any } =>
        c != null && 'status' in c
    )
    .map((c) => c.status as string);

  if (statuses.includes('down')) result.status = 'down';
  else if (statuses.includes('degraded')) result.status = 'degraded';
  else if (statuses.every((s) => s === 'ok' || s === 'info' || s === 'unknown'))
    result.status = 'ok';
  else result.status = 'degraded';

  result.checks = checks;

  return jsonResponse(result, cors, { status: 200 });
}
