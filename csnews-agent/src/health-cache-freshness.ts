// ============================================================
// Pull cache freshness health checks
// ============================================================

import { Env } from './shared';
import { CACHE_PREFIX, getSeedMeta } from './cache';

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

function calcKeyStatus(maxContentAgeMin: number): 'ok' | 'stale' | 'down' {
  if (maxContentAgeMin < 0) return 'ok';
  if (maxContentAgeMin > 360) return 'down';
  if (maxContentAgeMin > 180) return 'stale';
  return 'ok';
}

function calcGroupStatus(keys: CacheKeyHealth[]): 'ok' | 'degraded' | 'down' | 'unknown' {
  if (keys.length === 0) return 'unknown';
  let hasDown = false;
  let hasStale = false;
  for (const k of keys) {
    if (k.keyStatus === 'down') hasDown = true;
    if (k.keyStatus === 'stale') hasStale = true;
  }
  if (hasDown) return 'down';
  if (hasStale) return 'degraded';
  return 'ok';
}

function mapTypeToGroup(type: string): string {
  if (type === 'news' || type === 'topics' || type === 'warnings' || type === 'fission-pending') {
    return 'news';
  }
  if (type === 'entity') return 'entity';
  if (type === 'event') return 'event';
  if (type === 'trend') return 'trend';
  if (type === 'knowledge') return 'knowledge';
  return 'unknown';
}

export async function checkPullCacheFreshness(
  env: Env,
  ts: number
): Promise<{
  pull_cache_freshness: {
    groups: Record<string, HealthGroup>;
    overallStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  };
  checks: {
    pull_cache_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  const groupKeys: Record<string, CacheKeyHealth[]> = {
    news: [],
    entity: [],
    event: [],
    trend: [],
    knowledge: [],
    unknown: [],
  };

  const checks: any = {};

  try {
    if (!env.PROCESS_STATE) {
      const emptyGroups = Object.fromEntries(
        Object.keys(groupKeys).map((k) => [k, { status: 'down' as const, keys: [] }])
      );
      return {
        pull_cache_freshness: { groups: emptyGroups, overallStatus: 'down' },
        checks: { pull_cache_freshness: { status: 'down', detail: 'PROCESS_STATE KV missing' } },
      };
    }

    const list = await env.PROCESS_STATE.list({ prefix: CACHE_PREFIX + 'pull:' });
    const kvKeys = list.keys || [];

    for (const kvKey of kvKeys) {
      try {
        const raw = await env.PROCESS_STATE.get(kvKey.name);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const seed = getSeedMeta(parsed);
        if (!seed || seed.state === 'error') {
          groupKeys.unknown.push({
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
        const type = data?.type ?? 'unknown';
        const groupName = mapTypeToGroup(type);
        const maxContentAgeMin = seed.maxContentAgeMin >= 0 ? seed.maxContentAgeMin : -1;

        groupKeys[groupName].push({
          key: kvKey.name,
          recordCount: seed.recordCount,
          maxContentAgeMin,
          fetchedAt: seed.fetchedAt,
          state: seed.state,
          keyStatus: calcKeyStatus(maxContentAgeMin),
        });
      } catch {
        groupKeys.unknown.push({
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
    for (const [name, keys] of Object.entries(groupKeys)) {
      groups[name] = {
        status: calcGroupStatus(keys),
        keys,
      };
    }

    const overallStatus = groups.news?.status ?? 'unknown';

    const newsCount = groups.news?.keys.length ?? 0;
    const newsMaxAge =
      groups.news?.keys.reduce((max, k) => Math.max(max, k.maxContentAgeMin), -1) ?? -1;
    checks.pull_cache_freshness = {
      status: overallStatus,
      detail:
        newsCount > 0 && newsMaxAge >= 0
          ? `news=${newsCount} entries, oldest content ${newsMaxAge}min old`
          : `${newsCount} entries, maxContentAgeMin unavailable (legacy)`,
    };

    return {
      pull_cache_freshness: { groups, overallStatus },
      checks: { pull_cache_freshness: checks.pull_cache_freshness },
    };
  } catch (e: any) {
    const emptyGroups = Object.fromEntries(
      Object.keys(groupKeys).map((k) => [k, { status: 'unknown' as const, keys: [] }])
    );
    return {
      pull_cache_freshness: { groups: emptyGroups, overallStatus: 'unknown' },
      checks: {
        pull_cache_freshness: { status: 'unknown', detail: `list failed: ${e?.message}` },
      },
    };
  }
}
