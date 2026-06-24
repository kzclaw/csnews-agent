// ============================================================
// KV health checks
// ============================================================

import { Env } from './shared';
import { getCacheMetrics, countNegativeSentinels } from './cache';

// ============================================================
// 1. last_process_at + cron_health derived
// ============================================================
export async function checkLastProcessAt(
  env: Env,
  ts: number
): Promise<{
  last_process_at: string | null | { error: string };
  cron_health: 'ok' | 'degraded' | 'down';
  checks: {
    last_process_at: { status: 'ok' | 'degraded' | 'down'; detail: string };
    cron_health: { status: 'ok' | 'degraded' | 'down'; detail: string };
  };
}> {
  const checks: any = {};
  let lastProcessAt: string | null | { error: string } = null;

  try {
    if (env.PROCESS_STATE) {
      const raw = await env.PROCESS_STATE.get('last_process_at');
      if (!raw) {
        lastProcessAt = null;
        checks.last_process_at = { status: 'degraded', detail: 'KV empty' };
      } else {
        try {
          const { getSeedMeta } = await import('./cache');
          const parsed = JSON.parse(raw);
          const seed = getSeedMeta(parsed);
          if (seed && seed.state !== 'error') {
            const inner = parsed.data as { last_process_at?: string } | undefined;
            lastProcessAt = inner?.last_process_at ?? null;
            checks.last_process_at = {
              status: 'ok',
              detail: `envelope: state=${seed.state} age=${Math.round((ts - Date.parse(seed.fetchedAt)) / 60000)}min`,
            };
          } else {
            lastProcessAt = raw;
            checks.last_process_at = { status: 'ok', detail: raw };
          }
        } catch {
          lastProcessAt = raw;
          checks.last_process_at = { status: 'ok', detail: raw };
        }
      }
    } else {
      lastProcessAt = null;
      checks.last_process_at = { status: 'down', detail: 'PROCESS_STATE KV binding missing' };
    }
  } catch (e: any) {
    lastProcessAt = { error: e?.message || 'kv unavailable' };
    checks.last_process_at = { status: 'down', detail: e?.message };
  }

  let cronHealth: 'ok' | 'degraded' | 'down' = 'ok';
  if (typeof lastProcessAt === 'string') {
    const lastMs = Date.parse(lastProcessAt);
    if (Number.isFinite(lastMs)) {
      const ageMs = ts - lastMs;
      if (ageMs > 3 * 3600_000) cronHealth = 'down';
      else if (ageMs > 1.5 * 3600_000) cronHealth = 'degraded';
    }
  } else if (checks.last_process_at.status === 'down') {
    cronHealth = 'down';
  } else {
    cronHealth = 'degraded';
  }

  checks.cron_health = {
    status: cronHealth,
    detail:
      typeof lastProcessAt === 'string'
        ? `${Math.round((ts - Date.parse(lastProcessAt)) / 60000)} min ago`
        : 'no last_process_at recorded',
  };

  return {
    last_process_at: lastProcessAt,
    cron_health: cronHealth,
    checks: {
      last_process_at: checks.last_process_at,
      cron_health: checks.cron_health,
    },
  };
}

// ============================================================
// 2. cache_metrics — pull KV cache hit rate
// ============================================================
export function checkCacheMetrics(): {
  cache_metrics:
    | {
        hits: number;
        misses: number;
        stores: number;
        store_failures: number;
        total_requests: number;
        hit_rate: number;
      }
    | { error: string };
  checks: {
    cache_metrics: { status: 'ok' | 'degraded' | 'unknown'; detail: string };
  };
} {
  let cacheMetrics:
    | {
        hits: number;
        misses: number;
        stores: number;
        store_failures: number;
        total_requests: number;
        hit_rate: number;
      }
    | { error: string } = {
    hits: 0,
    misses: 0,
    stores: 0,
    store_failures: 0,
    total_requests: 0,
    hit_rate: 0,
  };
  const checks: any = {};

  try {
    const m = getCacheMetrics();
    cacheMetrics = {
      hits: m.hits,
      misses: m.misses,
      stores: m.stores,
      store_failures: m.store_failures,
      total_requests: m.total_requests,
      hit_rate: Number(m.hit_rate.toFixed(4)),
    };
    if (m.total_requests === 0) {
      checks.cache_metrics = {
        status: 'unknown',
        detail: 'no cache requests yet (cold start or no pull traffic this isolate)',
      };
    } else if (m.hit_rate >= 0.5) {
      checks.cache_metrics = {
        status: 'ok',
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests)`,
      };
    } else {
      checks.cache_metrics = {
        status: 'degraded',
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests, < 50%)`,
      };
    }
  } catch (e: any) {
    cacheMetrics = { error: e?.message || 'cache metrics read failed' };
    checks.cache_metrics = { status: 'unknown', detail: e?.message };
  }

  return {
    cache_metrics: cacheMetrics,
    checks: { cache_metrics: checks.cache_metrics },
  };
}

// ============================================================
// 3. neg_sentinel_count — current active Negative Sentinel count
// ============================================================
export async function checkNegativeSentinel(env: Env): Promise<{
  neg_sentinel_count: number;
  checks: {
    neg_sentinel: { status: 'ok' | 'degraded'; detail: string };
  };
}> {
  const count = await countNegativeSentinels(env);
  return {
    neg_sentinel_count: count,
    checks: {
      neg_sentinel: {
        status: count === 0 ? 'ok' : 'degraded',
        detail:
          count === 0
            ? 'no active sentinels (upstream healthy)'
            : `${count} sentinel${count > 1 ? 's' : ''} active (${count} endpoint${count > 1 ? 's' : ''} skipping upstream)`,
      },
    },
  };
}
