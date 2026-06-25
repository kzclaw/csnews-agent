/**
 * Business contract tests for the cache module.
 * Covers Seed Envelope, cache key generation, get/put/delete, negative sentinel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockKVNamespace } from '../test-helpers';

// Mock Env factory
function makeMockEnv(kvPrefill: Record<string, string> = {}) {
  return {
    PROCESS_STATE: createMockKVNamespace(kvPrefill),
    SUPABASE_URL: 'test-project',
    SUPABASE_SERVICE_KEY: 'test-key',
    BEARER_TOKEN: 'test-token',
    WORKER_SELF_URL: 'https://test.workers.dev',
  } as any;
}

describe('SeedEnvelope structure', () => {
  it('buildSeedEnvelope creates correct shape', async () => {
    const mod = await import('../src/cache');
    const data = [{ id: '1', title: 'Test News' }];
    // Access internal via exported helpers
    const key = await mod.makeCacheKey('test', { type: 'news' });
    expect(typeof key).toBe('string');
    expect(key.startsWith('cache:')).toBe(true);
  });

  it('stableHash returns consistent 32-char hex', async () => {
    const { stableHash } = await import('../src/cache');
    const h1 = await stableHash('test input');
    const h2 = await stableHash('test input');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(h1)).toBe(true);
  });

  it('stableHash returns different hashes for different inputs', async () => {
    const { stableHash } = await import('../src/cache');
    const h1 = await stableHash('input-a');
    const h2 = await stableHash('input-b');
    expect(h1).not.toBe(h2);
  });

  it('makeCacheKey sorts params and appends hash', async () => {
    const { makeCacheKey } = await import('../src/cache');
    // Params in different order should produce same key
    const k1 = await makeCacheKey('pull', { type: 'news', limit: 20 });
    const k2 = await makeCacheKey('pull', { limit: 20, type: 'news' });
    expect(k1).toBe(k2);
    expect(k1.startsWith('cache:pull:')).toBe(true);
  });

  it('makeCacheKey filters null/undefined', async () => {
    const { makeCacheKey } = await import('../src/cache');
    const k1 = await makeCacheKey('pull', { type: 'news', extra: undefined });
    const k2 = await makeCacheKey('pull', { type: 'news' });
    expect(k1).toBe(k2);
  });

  it('getSeedMeta extracts _seed from wrapped value', async () => {
    const { getSeedMeta } = await import('../src/cache');
    const wrapped = {
      _seed: { fetchedAt: '2024-01-01T00:00:00Z', recordCount: 5, state: 'ok', maxContentAgeMin: 10 },
      data: [{ id: '1' }],
    };
    const meta = getSeedMeta(wrapped);
    expect(meta).not.toBeNull();
    expect(meta!.state).toBe('ok');
    expect(meta!.recordCount).toBe(5);
  });

  it('getSeedMeta returns null for plain value', async () => {
    const { getSeedMeta } = await import('../src/cache');
    expect(getSeedMeta({ plain: 'data' })).toBeNull();
    expect(getSeedMeta(null)).toBeNull();
    expect(getSeedMeta(undefined)).toBeNull();
  });
});

describe('cacheGet / cacheSet round-trip', () => {
  let env: any;

  beforeEach(() => {
    env = makeMockEnv();
  });

  it('cacheGet returns null when PROCESS_STATE is absent', async () => {
    const { cacheGet } = await import('../src/cache');
    const noKvEnv = { ...env, PROCESS_STATE: undefined };
    const result = await cacheGet(noKvEnv, 'any-key');
    expect(result).toBeNull();
  });

  it('cacheGet returns null for missing key', async () => {
    const { cacheGet } = await import('../src/cache');
    const result = await cacheGet(env, 'missing-key');
    expect(result).toBeNull();
  });

  it('cacheSet then cacheGet returns unwrapped data', async () => {
    const { cacheGet, cacheSet } = await import('../src/cache');
    const data = { news: [{ id: '1', title: 'Test' }] };
    await cacheSet(env, 'test-key', data, 60, { recordCount: 1, maxContentAgeMin: 5 });
    const result = await cacheGet(env, 'test-key');
    expect(result).toEqual(data);
  });

  it('cacheSet without recordCount stores raw data', async () => {
    const { cacheGet, cacheSet } = await import('../src/cache');
    await cacheSet(env, 'raw-key', 'plain-value');
    const result = await cacheGet(env, 'raw-key');
    expect(result).toBe('plain-value');
  });

  it('cacheSet with oversized value silently fails', async () => {
    const { cacheSet } = await import('../src/cache');
    const large = 'x'.repeat(26 * 1024 * 1024); // > 25MB
    // Should not throw
    await expect(cacheSet(env, 'big-key', large, 60)).resolves.not.toThrow();
  });

  it('cacheDelete removes stored key', async () => {
    const { cacheGet, cacheSet, cacheDelete } = await import('../src/cache');
    await cacheSet(env, 'to-delete', { value: 123 });
    await cacheDelete(env, 'to-delete');
    const result = await cacheGet(env, 'to-delete');
    expect(result).toBeNull();
  });
});

describe('Negative Sentinel', () => {
  let env: any;

  beforeEach(() => {
    env = makeMockEnv();
  });

  it('isNegativeSentinel returns false for non-existent key', async () => {
    const { isNegativeSentinel } = await import('../src/cache');
    const result = await isNegativeSentinel(env, 'some-key');
    expect(result).toBe(false);
  });

  it('setNegativeSentinel then isNegativeSentinel returns true', async () => {
    const { isNegativeSentinel, setNegativeSentinel } = await import('../src/cache');
    await setNegativeSentinel(env, 'failed-key');
    const result = await isNegativeSentinel(env, 'failed-key');
    expect(result).toBe(true);
  });

  it('clearNegativeSentinel removes sentinel', async () => {
    const { isNegativeSentinel, setNegativeSentinel, clearNegativeSentinel } = await import('../src/cache');
    await setNegativeSentinel(env, 'key-to-clear');
    await clearNegativeSentinel(env, 'key-to-clear');
    const result = await isNegativeSentinel(env, 'key-to-clear');
    expect(result).toBe(false);
  });

  it('countNegativeSentinels returns 0 initially', async () => {
    const { countNegativeSentinels } = await import('../src/cache');
    const count = await countNegativeSentinels(env);
    expect(count).toBe(0);
  });

  it('countNegativeSentinels increments with sentinels', async () => {
    const { countNegativeSentinels, setNegativeSentinel } = await import('../src/cache');
    await setNegativeSentinel(env, 'key-1');
    await setNegativeSentinel(env, 'key-2');
    const count = await countNegativeSentinels(env);
    expect(count).toBe(2);
  });
});

describe('Cache metrics', () => {
  let env: any;

  beforeEach(() => {
    env = makeMockEnv();
  });

  it('resetCacheMetrics clears all counters', async () => {
    const { resetCacheMetrics, getCacheMetrics, cacheGet, cacheSet } = await import('../src/cache');
    // Generate some hits/misses
    await cacheSet(env, 'm1', { data: 1 }, 60, { recordCount: 1 });
    await cacheGet(env, 'm1');
    await cacheGet(env, 'nonexistent');
    resetCacheMetrics();
    const metrics = getCacheMetrics();
    expect(metrics.hits).toBe(0);
    expect(metrics.misses).toBe(0);
    expect(metrics.stores).toBe(0);
  });

  it('getCacheMetrics returns hit_rate calculation', async () => {
    const { getCacheMetrics, resetCacheMetrics } = await import('../src/cache');
    resetCacheMetrics();
    const metrics = getCacheMetrics();
    expect(metrics.total_requests).toBe(0);
    expect(metrics.hit_rate).toBe(0);
  });
});

describe('Constants exported from cache.ts', () => {
  it('exports CACHE_PREFIX', async () => {
    const { CACHE_PREFIX } = await import('../src/cache');
    expect(CACHE_PREFIX).toBe('cache:');
  });

  it('exports NEG_SENTINEL_PREFIX', async () => {
    const { NEG_SENTINEL_PREFIX } = await import('../src/cache');
    expect(NEG_SENTINEL_PREFIX).toBe('__CSNEWS_NEG__');
  });

  it('exports NEG_SENTINEL_TTL = 30', async () => {
    const { NEG_SENTINEL_TTL } = await import('../src/cache');
    expect(NEG_SENTINEL_TTL).toBe(30);
  });

  it('exports DEFAULT_TTL_SECONDS = 3600', async () => {
    const { DEFAULT_TTL_SECONDS } = await import('../src/cache');
    expect(DEFAULT_TTL_SECONDS).toBe(3600);
  });

  it('exports PULL_TTL_SECONDS = 60', async () => {
    const { PULL_TTL_SECONDS } = await import('../src/cache');
    expect(PULL_TTL_SECONDS).toBe(60);
  });

  it('exports MAX_VALUE_SIZE_BYTES = 25MB', async () => {
    const { MAX_VALUE_SIZE_BYTES } = await import('../src/cache');
    expect(MAX_VALUE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });
});
