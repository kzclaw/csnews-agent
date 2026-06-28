// ============================================================
// health-checks.ts — backward-compatibility re-export layer
//
// All check functions live in focused sub-modules.
// This file re-exports everything for consumers that import
// from this path.
// ============================================================

// Re-export type from health-cache-freshness
import type { CacheKeyHealth, HealthGroup } from './health-cache-freshness';
export type { CacheKeyHealth, HealthGroup };

// Re-export all checks from focused sub-modules
export { checkSupabaseCounts } from './health-db';
export {
  checkR2LatestSupabaseWrite,
  checkEntityAndEventFreshness,
  checkZscoreSignals,
} from './health-db';
export { checkAiBudget, checkAiCallsBreakdown } from './health-ai';
export { checkR2LatestWrite, checkR2PrefixCounts } from './health-r2';
export { checkLastProcessAt, checkCacheMetrics, checkNegativeSentinel } from './health-kv';
export { checkPullCacheFreshness } from './health-cache-freshness';
export { checkMcpToolsCount } from './health-mcp';
export type { CheckResult } from './health-mcp';

// Checks that live directly in health-checks-internal
export { checkSecretResolved, checkCronHistory } from './health-checks-internal';

// Cascade utilities live in health-checks-internal
export {
  CASCADE_DEPENDENCY_CHAIN,
  applyCascadeDependencies,
  calcOverallStatusWithCascade,
} from './health-checks-internal';
