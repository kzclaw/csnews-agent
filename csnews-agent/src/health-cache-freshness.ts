// ============================================================
// Pull cache freshness health checks (simplified)
// ============================================================

import { Env } from './shared';
import { CACHE_PREFIX, getSeedMeta } from './cache';

// Exported for health-checks.ts re-export layer (used by external type consumers)
export interface CacheKeyHealth {
  key: string;
  recordCount: number;
  maxContentAgeMin: number;
  fetchedAt: string;
  state: 'ok' | 'error' | 'empty';
  keyStatus: 'ok' | 'stale' | 'down';
}

export interface HealthGroup {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  keys: CacheKeyHealth[];
  cascadedFrom?: string;
}

const GROUP_TYPE_MAP: Record<string, string> = {
  news: 'news',
  topics: 'news',
  warnings: 'news',
  'fission-pending': 'news',
  entity: 'entity',
  event: 'event',
  trend: 'trend',
  knowledge: 'knowledge',
};

function keyStatusOf(maxContentAgeMin: number): 'ok' | 'stale' | 'down' {
  if (maxContentAgeMin < 0) return 'ok';
  if (maxContentAgeMin > 360) return 'down';
  if (maxContentAgeMin > 180) return 'stale';
  return 'ok';
}

function groupStatusOf(keys: CacheKeyHealth[]): 'ok' | 'degraded' | 'down' | 'unknown' {
  if (keys.length === 0) return 'unknown';
  let hasDown = false;
  let hasStale = false;
  for (const k of keys) {
    if (k.keyStatus === 'down') hasDown = true;
    else if (k.keyStatus === 'stale') hasStale = true;
  }
  if (hasDown) return 'down';
  if (hasStale) return 'degraded';
  return 'ok';
}

const EMPTY_GROUPS = (): Record<string, HealthGroup> => ({
  news: { status: 'unknown', keys: [] },
  entity: { status: 'unknown', keys: [] },
  event: { status: 'unknown', keys: [] },
  trend: { status: 'unknown', keys: [] },
  knowledge: { status: 'unknown', keys: [] },
  unknown: { status: 'unknown', keys: [] },
});

export async function checkPullCacheFreshness(
  env: Env,
  _ts: number
): Promise<{
  pull_cache_freshness: {
    groups: Record<string, HealthGroup>;
    overallStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  };
  checks: {
    pull_cache_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  if (!env.PROCESS_STATE) {
    return {
      pull_cache_freshness: { groups: EMPTY_GROUPS(), overallStatus: 'down' },
      checks: { pull_cache_freshness: { status: 'down', detail: 'PROCESS_STATE KV missing' } },
    };
  }

  const groupMap: Record<string, CacheKeyHealth[]> = {
    news: [],
    entity: [],
    event: [],
    trend: [],
    knowledge: [],
    unknown: [],
  };

  try {
    const list = await env.PROCESS_STATE.list({ prefix: CACHE_PREFIX + 'pull:' });
    for (const kvKey of list.keys || []) {
      try {
        const raw = await env.PROCESS_STATE.get(kvKey.name);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const seed = getSeedMeta(parsed);
        if (!seed || seed.state === 'error') {
          groupMap.unknown.push({
            key: kvKey.name,
            recordCount: 0,
            maxContentAgeMin: -1,
            fetchedAt: '',
            state: 'error',
            keyStatus: 'ok',
          });
          continue;
        }
        const data = parsed.data as { type?: string } | undefined;
        const groupName = GROUP_TYPE_MAP[data?.type ?? ''] ?? 'unknown';
        const maxContentAgeMin = seed.maxContentAgeMin >= 0 ? seed.maxContentAgeMin : -1;
        groupMap[groupName].push({
          key: kvKey.name,
          recordCount: seed.recordCount,
          maxContentAgeMin,
          fetchedAt: seed.fetchedAt,
          state: seed.state,
          keyStatus: keyStatusOf(maxContentAgeMin),
        });
      } catch {
        groupMap.unknown.push({
          key: kvKey.name,
          recordCount: 0,
          maxContentAgeMin: -1,
          fetchedAt: '',
          state: 'error',
          keyStatus: 'ok',
        });
      }
    }

    const groups: Record<string, HealthGroup> = {};
    for (const [name, keys] of Object.entries(groupMap)) {
      groups[name] = { status: groupStatusOf(keys), keys };
    }

    const newsKeys = groups.news?.keys ?? [];
    const newsMaxAge = newsKeys.reduce((max, k) => Math.max(max, k.maxContentAgeMin), -1);
    const overallStatus = groups.news?.status ?? 'unknown';

    return {
      pull_cache_freshness: { groups, overallStatus },
      checks: {
        pull_cache_freshness: {
          status: overallStatus,
          detail:
            newsKeys.length > 0 && newsMaxAge >= 0
              ? `news=${newsKeys.length} entries, oldest content ${newsMaxAge}min old`
              : `${newsKeys.length} entries, maxContentAgeMin unavailable (legacy)`,
        },
      },
    };
  } catch (e: unknown) {
    return {
      pull_cache_freshness: { groups: EMPTY_GROUPS(), overallStatus: 'unknown' },
      checks: {
        pull_cache_freshness: {
          status: 'unknown',
          detail: `list failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      },
    };
  }
}
