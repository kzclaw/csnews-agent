// ============================================================
// health-checks.ts · aggregator entry point
//
// All check functions live in focused sub-modules.
// This file re-exports everything for backward compatibility
// and keeps cascade dependency utilities.
// ============================================================

import type { CacheKeyHealth, HealthGroup } from './health-kv';
export type { CacheKeyHealth, HealthGroup };

// Re-export all checks from focused sub-modules
export { checkSupabaseCounts } from './health-db';
export { checkR2LatestSupabaseWrite, checkEntityAndEventFreshness, checkZscoreSignals } from './health-db';
export { checkAiBudget, checkAiCallsBreakdown } from './health-ai';
export { checkR2LatestWrite, checkR2PrefixCounts } from './health-r2';
export { checkLastProcessAt, checkCacheMetrics, checkPullCacheFreshness, checkNegativeSentinel } from './health-kv';
export { checkMcpToolsCount } from './health-mcp';
export type { CheckResult } from './health-mcp';

// Checks that live directly in this file (no dedicated submodule)
export { checkSecretResolved, checkCronHistory } from './health-checks-internal';

// ============================================================
// Cascade dependency chain
// ============================================================

/**
 * Cascade dependency chain definition.
 * Upstream down → downstream automatically degraded (even if its own keys are healthy).
 *
 * Chain:
 *   news (core)
 *     ↓
 *   entity (depends on news)
 *     ↓
 *   event (depends on entity)
 *
 *   trend (depends on entity)
 *     ↓
 *   knowledge (depends on trend)
 */
export const CASCADE_DEPENDENCY_CHAIN: Record<string, string | undefined> = {
  news: undefined,
  entity: 'news',
  event: 'entity',
  trend: 'entity',
  knowledge: 'trend',
};

/**
 * Apply cascade dependency degradation.
 * Upstream down → current group degraded (preserve keys info, mark cascadedFrom).
 * Upstream degraded → current group unchanged (only its own status matters).
 */
export function applyCascadeDependencies(
  groups: Record<string, HealthGroup>
): Record<string, HealthGroup> {
  const result: Record<string, HealthGroup> = {};
  const order = ['news', 'entity', 'event', 'trend', 'knowledge'];
  const processed = new Set<string>();

  for (const name of order) {
    if (!groups[name]) continue;
    const group = { ...groups[name] };
    const upstream = CASCADE_DEPENDENCY_CHAIN[name];

    if (upstream && groups[upstream] && groups[upstream].status === 'down') {
      group.status = 'degraded';
      group.cascadedFrom = upstream;
    }

    result[name] = group;
    processed.add(name);
  }

  for (const [name, group] of Object.entries(groups)) {
    if (!processed.has(name)) {
      result[name] = group;
    }
  }

  return result;
}

/**
 * Calculate overall status after cascade.
 * Any group down → global down.
 * Any group degraded (including cascade) → global degraded.
 * All ok → ok.
 */
export function calcOverallStatusWithCascade(
  groups: Record<string, HealthGroup>
): 'ok' | 'degraded' | 'down' {
  let hasDown = false;
  let hasDegraded = false;

  for (const group of Object.values(groups)) {
    if (group.status === 'down') hasDown = true;
    if (group.status === 'degraded') hasDegraded = true;
  }

  if (hasDown) return 'down';
  if (hasDegraded) return 'degraded';
  return 'ok';
}
