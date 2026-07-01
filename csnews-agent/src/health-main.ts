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
} from './health-checks';

export async function handleHealthAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const ts = Date.now();
  const checks: Record<string, { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: any }> =
    {};
  const result: any = { status: 'ok', ts };
  result.worker_version = env.WORKER_VERSION || 'unknown';

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

  // 6. r2_latest_write
  const r2LatestResult = await checkR2LatestWrite(env, ts);
  result.r2_latest_write = r2LatestResult.r2_latest_write;
  checks.r2_latest_write = r2LatestResult.checks.r2_latest_write;

  // 7. r2_latest_supabase_write
  const r2SupabaseResult = await checkR2LatestSupabaseWrite(env, ts);
  result.r2_latest_supabase_write = r2SupabaseResult.r2_latest_supabase_write;
  checks.r2_latest_supabase_write = r2SupabaseResult.checks.r2_latest_supabase_write;

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
      (c): c is { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: any } =>
        c != null && 'status' in c
    )
    .map((c) => c.status as string);

  if (statuses.includes('down')) result.status = 'down';
  else if (statuses.includes('degraded')) result.status = 'degraded';
  else if (statuses.every((s) => s === 'ok' || s === 'unknown')) result.status = 'ok';
  else result.status = 'degraded';

  result.checks = checks;

  return jsonResponse(result, cors, { status: 200 });
}
