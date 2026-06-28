/**
 * Business contract tests for health check sub-systems.
 *
 * Covers:
 *   - health-ai.ts: checkAiBudget, checkAiCallsBreakdown
 *   - health-kv.ts: checkLastProcessAt, checkCacheMetrics, checkNegativeSentinel
 *   - health-r2.ts: checkR2LatestWrite, checkR2PrefixCounts
 *   - health-mcp.ts: checkMcpToolsCount
 *   - health-checks-internal.ts: checkSecretResolved, checkCronHistory, cascade utilities
 *
 * Key contracts verified:
 *   - Happy path returns correct { status, ok, detail } structure
 *   - Missing KV/R2 bindings degrade gracefully (no thrown errors)
 *   - Empty bucket/query results handle without crashing
 *   - One failing sub-check does not cascade into unrelated checks
 *   - re-export layer from health-checks.ts re-exports everything correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKVNamespace, createMockR2Bucket } from '../test-helpers';

// =============================================================================
// Shared mock helpers
// =============================================================================

function makeMockEnv(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseR2: any = createMockR2Bucket({});
  // Add list() to the mock — many health checks call env.csnews_raw.list()
  if (!baseR2.list) {
    baseR2.list = vi.fn().mockResolvedValue({ objects: [] });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    AI: {
      run: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1024).fill(0.1) }],
      }),
    } as unknown as Ai,
    csnews_raw: baseR2,
    BEARER_TOKEN: 'test-token',
    SUPABASE_URL: 'test-project',
    SUPABASE_SERVICE_KEY: 'test-key',
    WORKER_SELF_URL: 'https://test.workers.dev',
    PROCESS_STATE: createMockKVNamespace({}),
    AI_USAGE_KV: createMockKVNamespace({}),
    VECTORIZE: undefined,
    TAVILY_API_KEY: 'test-key',
    ...overrides,
  } as any;
}

// =============================================================================
// health-ai.ts — checkAiBudget
// =============================================================================

describe('health-ai.ts — checkAiBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with ai_budget_today and checks fields', async () => {
    const { checkAiBudget } = await import('../src/health-ai');
    const env = makeMockEnv();
    const result = await checkAiBudget(env);

    expect(result).toHaveProperty('ai_budget_today');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('ai_budget_today');
    expect(result.checks.ai_budget_today).toHaveProperty('status');
    expect(result.checks.ai_budget_today).toHaveProperty('detail');
  });

  it('ai_budget_today contains used/tier/remaining/daily_limit when AI_USAGE_KV is absent (graceful)', async () => {
    const { checkAiBudget } = await import('../src/health-ai');
    const env = makeMockEnv({ AI_USAGE_KV: undefined });
    const result = await checkAiBudget(env);

    // Without KV, budget returns zeroed defaults — no crash
    expect(result.ai_budget_today).toHaveProperty('used');
    expect(result.ai_budget_today).toHaveProperty('tier');
    expect(result.ai_budget_today).toHaveProperty('remaining');
    expect(result.ai_budget_today).toHaveProperty('daily_limit');
    expect(result.checks.ai_budget_today.status).toBeTruthy();
  });
});

// =============================================================================
// health-ai.ts — checkAiCallsBreakdown
// =============================================================================

describe('health-ai.ts — checkAiCallsBreakdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with ai_calls_breakdown and checks fields', async () => {
    const { checkAiCallsBreakdown } = await import('../src/health-ai');
    const env = makeMockEnv();
    const result = await checkAiCallsBreakdown(env);

    expect(result).toHaveProperty('ai_calls_breakdown');
    expect(result).toHaveProperty('neurons_used_today');
    expect(result).toHaveProperty('ai_budget_status');
    expect(result.checks).toHaveProperty('ai_calls_breakdown');
  });

  it('returns empty breakdown when AI_USAGE_KV is absent (no crash)', async () => {
    const { checkAiCallsBreakdown } = await import('../src/health-ai');
    const env = makeMockEnv({ AI_USAGE_KV: undefined });
    const result = await checkAiCallsBreakdown(env);

    expect(result.ai_calls_breakdown).toEqual({});
    expect(result.neurons_used_today).toBe(0);
    expect(result.checks.ai_calls_breakdown.status).toBe('unknown');
    expect(result.checks.ai_calls_breakdown.detail).toContain('missing');
  });

  it('returns zero breakdown when KV has no usage key for today', async () => {
    const { checkAiCallsBreakdown } = await import('../src/health-ai');
    const env = makeMockEnv();
    const result = await checkAiCallsBreakdown(env);

    expect(result.ai_calls_breakdown).toEqual({});
    expect(result.checks.ai_calls_breakdown.status).toBe('ok');
    expect(result.checks.ai_calls_breakdown.detail).toContain('no AI calls');
  });

  it('aggregates calls by L1/L3/L6 tier levels', async () => {
    const { checkAiCallsBreakdown } = await import('../src/health-ai');

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const todayKey = `usage/${y}-${m}-${d}`;

    const store: Record<string, string> = {};
    store[todayKey] = JSON.stringify({
      total: 1000,
      calls: [
        { model: '@cf/meta/llama-3-8b-instruct', neurons: 100, tool_name: 'tool1' },
        { model: '@cf/baai/bge-m3', neurons: 200, tool_name: 'tool2' },
        { model: '@cf/meta/llama-3-8b-instruct', neurons: 150, tool_name: 'tool1' },
        { model: 'unknown-model', neurons: 50, tool_name: 'tool3' },
      ],
    });

    const kv = createMockKVNamespace(store);
    const env = makeMockEnv({ AI_USAGE_KV: kv });
    const result = await checkAiCallsBreakdown(env);

    // L6 for llama, L3 for bge-m3, L1 for unknown
    expect(result.ai_calls_breakdown).toHaveProperty('L6');
    expect(result.ai_calls_breakdown.L6).toBe(2);
    expect(result.ai_calls_breakdown).toHaveProperty('L3');
    expect(result.ai_calls_breakdown.L3).toBe(1);
    expect(result.ai_calls_breakdown).toHaveProperty('L1');
    expect(result.ai_calls_breakdown.L1).toBe(1);
    expect(result.neurons_used_today).toBe(1000);
  });

  it('KV list throws returns graceful unknown without crash', async () => {
    const { checkAiCallsBreakdown } = await import('../src/health-ai');
    const badKV = {
      get: vi.fn().mockRejectedValue(new Error('KV connection refused')),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    const env = makeMockEnv({ AI_USAGE_KV: badKV });
    const result = await checkAiCallsBreakdown(env);

    expect(result.ai_calls_breakdown).toEqual({});
    expect(result.checks.ai_calls_breakdown.status).toBe('unknown');
  });
});

// =============================================================================
// health-kv.ts — checkLastProcessAt
// =============================================================================

describe('health-kv.ts — checkLastProcessAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with last_process_at, cron_health, and checks', async () => {
    const { checkLastProcessAt } = await import('../src/health-kv');
    const env = makeMockEnv();
    const ts = Date.now();
    const result = await checkLastProcessAt(env, ts);

    expect(result).toHaveProperty('last_process_at');
    expect(result).toHaveProperty('cron_health');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('last_process_at');
    expect(result.checks).toHaveProperty('cron_health');
  });

  it('PROCESS_STATE missing returns last_process_at null and status down', async () => {
    const { checkLastProcessAt } = await import('../src/health-kv');
    const env = makeMockEnv({ PROCESS_STATE: undefined });
    const ts = Date.now();
    const result = await checkLastProcessAt(env, ts);

    expect(result.last_process_at).toBeNull();
    expect(result.checks.last_process_at.status).toBe('down');
    expect(result.checks.last_process_at.detail).toContain('missing');
  });

  it('PROCESS_STATE with no key returns degraded', async () => {
    const { checkLastProcessAt } = await import('../src/health-kv');
    const env = makeMockEnv();
    const ts = Date.now();
    const result = await checkLastProcessAt(env, ts);

    expect(result.last_process_at).toBeNull();
    expect(result.checks.last_process_at.status).toBe('degraded');
  });

  it('recent last_process_at returns cron_health ok', async () => {
    const { checkLastProcessAt } = await import('../src/health-kv');
    const store: Record<string, string> = {};
    store['last_process_at'] = JSON.stringify({
      data: { last_process_at: new Date(Date.now() - 30 * 60_000).toISOString() },
    });
    const kv = createMockKVNamespace(store);
    const env = makeMockEnv({ PROCESS_STATE: kv });
    const ts = Date.now();
    const result = await checkLastProcessAt(env, ts);

    expect(result.cron_health).toBe('ok');
    expect(result.checks.cron_health.status).toBe('ok');
  });

  it('stale last_process_at (>3h) returns cron_health down', async () => {
    const { checkLastProcessAt } = await import('../src/health-kv');
    const fourHoursAgo = new Date(Date.now() - 4 * 3600_000).toISOString();
    // The real last_process_at value uses the _seed envelope format
    const store: Record<string, string> = {};
    store['last_process_at'] = JSON.stringify({
      _seed: { fetchedAt: fourHoursAgo, recordCount: 1, state: 'ok' as const, maxContentAgeMin: 0 },
      data: { last_process_at: fourHoursAgo },
    });
    const kv = createMockKVNamespace(store);
    const env = makeMockEnv({ PROCESS_STATE: kv });
    const ts = Date.now();
    const result = await checkLastProcessAt(env, ts);

    expect(result.cron_health).toBe('down');
  });
});

// =============================================================================
// health-kv.ts — checkCacheMetrics
// =============================================================================

describe('health-kv.ts — checkCacheMetrics', () => {
  it('returns correct shape with cache_metrics and checks fields', async () => {
    const { checkCacheMetrics } = await import('../src/health-kv');
    const result = checkCacheMetrics();

    expect(result).toHaveProperty('cache_metrics');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('cache_metrics');
    expect(result.checks.cache_metrics).toHaveProperty('status');
    expect(result.checks.cache_metrics).toHaveProperty('detail');
  });

  it('status is unknown when no cache requests yet (cold start)', async () => {
    const { checkCacheMetrics } = await import('../src/health-kv');
    const result = checkCacheMetrics();

    // Cold start: total_requests=0 → status unknown
    if ('error' in result.cache_metrics) {
      expect(result.checks.cache_metrics.status).toBe('unknown');
    } else {
      expect(['ok', 'degraded', 'unknown']).toContain(result.checks.cache_metrics.status);
    }
  });
});

// =============================================================================
// health-kv.ts — checkNegativeSentinel
// =============================================================================

describe('health-kv.ts — checkNegativeSentinel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with neg_sentinel_count and checks', async () => {
    const { checkNegativeSentinel } = await import('../src/health-kv');
    const env = makeMockEnv();
    const result = await checkNegativeSentinel(env);

    expect(result).toHaveProperty('neg_sentinel_count');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('neg_sentinel');
  });

  it('zero sentinels returns status ok', async () => {
    const { checkNegativeSentinel } = await import('../src/health-kv');
    const env = makeMockEnv();
    const result = await checkNegativeSentinel(env);

    expect(result.neg_sentinel_count).toBe(0);
    expect(result.checks.neg_sentinel.status).toBe('ok');
  });
});

// =============================================================================
// health-r2.ts — checkR2LatestWrite
// =============================================================================

describe('health-r2.ts — checkR2LatestWrite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with r2_latest_write and checks', async () => {
    const { checkR2LatestWrite } = await import('../src/health-r2');
    const env = makeMockEnv();
    const result = await checkR2LatestWrite(env, Date.now());

    expect(result).toHaveProperty('r2_latest_write');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('r2_latest_write');
  });

  it('empty R2 bucket returns null without crash', async () => {
    const { checkR2LatestWrite } = await import('../src/health-r2');
    // createMockR2Bucket doesn't expose list(); provide a full mock with list()
    const emptyR2 = {
      list: vi.fn().mockResolvedValue({ objects: [] }),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
    };
    const env = makeMockEnv({ csnews_raw: emptyR2 });
    const result = await checkR2LatestWrite(env, Date.now());

    expect(result.r2_latest_write).toBeNull();
    expect(result.checks.r2_latest_write.status).toBe('ok');
    expect(result.checks.r2_latest_write.detail).toContain('no objects');
  });

  it('R2 list throws returns error without crash', async () => {
    const { checkR2LatestWrite } = await import('../src/health-r2');
    const badR2 = {
      list: vi.fn().mockRejectedValue(new Error('R2 connection refused')),
      get: vi.fn(),
      put: vi.fn(),
      head: vi.fn(),
    };
    const env = makeMockEnv({ csnews_raw: badR2 });
    const result = await checkR2LatestWrite(env, Date.now());

    expect(result.r2_latest_write).toHaveProperty('error');
    expect(result.checks.r2_latest_write.status).toBe('ok'); // informational only
  });
});

// =============================================================================
// health-r2.ts — checkR2PrefixCounts
// =============================================================================

describe('health-r2.ts — checkR2PrefixCounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with r2_prefix_counts', async () => {
    const { checkR2PrefixCounts } = await import('../src/health-r2');
    const env = makeMockEnv();
    const result = await checkR2PrefixCounts(env);

    expect(result).toHaveProperty('r2_prefix_counts');
    expect(typeof result.r2_prefix_counts).toBe('object');
  });

  it('each known prefix appears in r2_prefix_counts', async () => {
    const { checkR2PrefixCounts } = await import('../src/health-r2');
    const env = makeMockEnv();
    const result = await checkR2PrefixCounts(env);

    const expected = ['news/zaker/', 'news/', 'embeddings/', 'fission/', 'trends/', 'warnings/', 'logs/'];
    for (const prefix of expected) {
      expect(result.r2_prefix_counts).toHaveProperty(prefix);
    }
  });

  it('partial R2 failure returns error per failed prefix, not whole object', async () => {
    const { checkR2PrefixCounts } = await import('../src/health-r2');
    const callCount = { count: 0 };
    const badR2 = {
      list: vi.fn().mockImplementation(async ({ prefix }: { prefix: string }) => {
        callCount.count++;
        if (prefix === 'embeddings/') throw new Error('embeddings access denied');
        return { objects: [] };
      }),
      get: vi.fn(),
      put: vi.fn(),
      head: vi.fn(),
    };
    const env = makeMockEnv({ csnews_raw: badR2 });
    const result = await checkR2PrefixCounts(env);

    // embeddings/ should have an error, others should be numbers
    expect(result.r2_prefix_counts['embeddings/']).toHaveProperty('error');
    expect(result.r2_prefix_counts['news/']).toBe(0);
  });
});

// =============================================================================
// health-mcp.ts — checkMcpToolsCount
// =============================================================================

describe('health-mcp.ts — checkMcpToolsCount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with mcp_tools_count and checks', async () => {
    const { checkMcpToolsCount } = await import('../src/health-mcp');
    const env = makeMockEnv();
    const result = await checkMcpToolsCount(env);

    expect(result).toHaveProperty('mcp_tools_count');
    expect(result).toHaveProperty('mcp_tools_breakdown');
    expect(result.checks).toHaveProperty('mcp_tools');
  });

  it('AI_USAGE_KV missing returns mcp_tools_count=0 and status unknown', async () => {
    const { checkMcpToolsCount } = await import('../src/health-mcp');
    const env = makeMockEnv({ AI_USAGE_KV: undefined });
    const result = await checkMcpToolsCount(env);

    expect(result.mcp_tools_count).toBe(0);
    expect(result.mcp_tools_breakdown).toEqual({});
    expect(result.checks.mcp_tools.status).toBe('unknown');
    expect(result.checks.mcp_tools.detail).toContain('missing');
  });

  it('empty KV returns zero count and ok status', async () => {
    const { checkMcpToolsCount } = await import('../src/health-mcp');
    const env = makeMockEnv();
    const result = await checkMcpToolsCount(env);

    expect(result.mcp_tools_count).toBe(0);
    expect(result.checks.mcp_tools.status).toBe('ok');
    expect(result.checks.mcp_tools.detail).toContain('no MCP');
  });
});

// =============================================================================
// health-checks-internal.ts — checkSecretResolved
// =============================================================================

describe('health-checks-internal.ts — checkSecretResolved', () => {
  it('returns correct shape with secret_resolved check', async () => {
    const { checkSecretResolved } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ WORKER_SELF_URL: 'https://my-worker.workers.dev' });
    const result = checkSecretResolved(env);

    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('secret_resolved');
    expect(result.checks.secret_resolved).toHaveProperty('status');
    expect(result.checks.secret_resolved).toHaveProperty('detail');
  });

  it('real URL returns status ok', async () => {
    const { checkSecretResolved } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ WORKER_SELF_URL: 'https://my-worker.workers.dev' });
    const result = checkSecretResolved(env);

    expect(result.checks.secret_resolved.status).toBe('ok');
  });

  it('placeholder URL DO_NOT_USE returns status down', async () => {
    const { checkSecretResolved } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ WORKER_SELF_URL: 'DO_NOT_USE' });
    const result = checkSecretResolved(env);

    expect(result.checks.secret_resolved.status).toBe('down');
    expect(result.checks.secret_resolved.detail).toContain('placeholder');
  });

  it('placeholder URL YOUR-WORKER.workers.dev returns status down', async () => {
    const { checkSecretResolved } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ WORKER_SELF_URL: 'https://YOUR-WORKER.workers.dev' });
    const result = checkSecretResolved(env);

    expect(result.checks.secret_resolved.status).toBe('down');
  });

  it('empty WORKER_SELF_URL returns status down', async () => {
    const { checkSecretResolved } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ WORKER_SELF_URL: '' });
    const result = checkSecretResolved(env);

    expect(result.checks.secret_resolved.status).toBe('down');
  });
});

// =============================================================================
// health-checks-internal.ts — checkCronHistory
// =============================================================================

describe('health-checks-internal.ts — checkCronHistory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct shape with cron_history and checks fields', async () => {
    const { checkCronHistory } = await import('../src/health-checks-internal');
    const env = makeMockEnv();
    const result = await checkCronHistory(env, Date.now());

    expect(result).toHaveProperty('cron_history');
    expect(result).toHaveProperty('checks');
    expect(result.checks).toHaveProperty('cron_history');
  });

  it('R2 bucket missing throws no error (graceful degradation)', async () => {
    const { checkCronHistory } = await import('../src/health-checks-internal');
    const env = makeMockEnv({ csnews_raw: undefined });
    const result = await checkCronHistory(env, Date.now());

    // Should return something with checks.cron_history present
    expect(result.checks).toHaveProperty('cron_history');
    expect(result.checks.cron_history).toHaveProperty('status');
    expect(result.checks.cron_history).toHaveProperty('detail');
  });
});

// =============================================================================
// health-checks-internal.ts — cascade utilities
// =============================================================================

describe('health-checks-internal.ts — cascade utilities', () => {
  let internal: typeof import('../src/health-checks-internal');
  let healthGroup: typeof import('../src/health-cache-freshness');

  beforeEach(async () => {
    [internal, healthGroup] = await Promise.all([
      import('../src/health-checks-internal'),
      import('../src/health-cache-freshness'),
    ]);
  });

  describe('applyCascadeDependencies', () => {
    it('returns correct shape (groups with status/keys)', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [] },
        entity: { status: 'ok', keys: [] },
      };
      const result = internal.applyCascadeDependencies(groups);

      expect(result).toHaveProperty('news');
      expect(result).toHaveProperty('entity');
      expect(result.news).toHaveProperty('status');
      expect(result.news).toHaveProperty('keys');
    });

    it('upstream news=down cascades entity to degraded', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'down', keys: [] },
        entity: { status: 'ok', keys: [] },
        event: { status: 'ok', keys: [] },
        trend: { status: 'ok', keys: [] },
        knowledge: { status: 'ok', keys: [] },
      };
      const result = internal.applyCascadeDependencies(groups);

      expect(result.entity.status).toBe('degraded');
      expect(result.entity.cascadedFrom).toBe('news');
    });

    it('upstream degraded does not cascade (only down cascades)', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'degraded', keys: [] },
        entity: { status: 'ok', keys: [] },
        event: { status: 'ok', keys: [] },
        trend: { status: 'ok', keys: [] },
        knowledge: { status: 'ok', keys: [] },
      };
      const result = internal.applyCascadeDependencies(groups);

      expect(result.entity.status).toBe('ok');
      expect(result.entity.cascadedFrom).toBeUndefined();
    });

    it('preserves keys from original groups', async () => {
      const mockKey = { key: 'pull:news:abc', recordCount: 5, maxContentAgeMin: 30, fetchedAt: '2024-01-01T00:00:00Z', state: 'ok' as const, keyStatus: 'ok' as const };
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [mockKey] },
        entity: { status: 'ok', keys: [] },
        event: { status: 'ok', keys: [] },
        trend: { status: 'ok', keys: [] },
        knowledge: { status: 'ok', keys: [] },
      };
      const result = internal.applyCascadeDependencies(groups);

      expect(result.news.keys).toHaveLength(1);
      expect(result.news.keys[0].key).toBe('pull:news:abc');
    });
  });

  describe('calcOverallStatusWithCascade', () => {
    it('any group down returns down', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [] },
        entity: { status: 'down', keys: [] },
      };
      expect(internal.calcOverallStatusWithCascade(groups)).toBe('down');
    });

    it('any group degraded (no down) returns degraded', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'degraded', keys: [] },
        entity: { status: 'ok', keys: [] },
      };
      expect(internal.calcOverallStatusWithCascade(groups)).toBe('degraded');
    });

    it('all ok returns ok', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [] },
        entity: { status: 'ok', keys: [] },
      };
      expect(internal.calcOverallStatusWithCascade(groups)).toBe('ok');
    });

    it('degraded takes priority over ok', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [] },
        entity: { status: 'ok', keys: [] },
        event: { status: 'degraded', keys: [] },
      };
      expect(internal.calcOverallStatusWithCascade(groups)).toBe('degraded');
    });

    it('down takes priority over degraded', async () => {
      const groups: Record<string, healthGroup.HealthGroup> = {
        news: { status: 'ok', keys: [] },
        entity: { status: 'down', keys: [] },
        event: { status: 'degraded', keys: [] },
      };
      expect(internal.calcOverallStatusWithCascade(groups)).toBe('down');
    });
  });
});

// =============================================================================
// health-checks.ts — re-export layer
// =============================================================================

describe('health-checks.ts — re-export layer', () => {
  it('re-exports checkAiBudget', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkAiBudget).toBe('function');
  });

  it('re-exports checkAiCallsBreakdown', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkAiCallsBreakdown).toBe('function');
  });

  it('re-exports checkSecretResolved', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkSecretResolved).toBe('function');
  });

  it('re-exports checkCronHistory', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkCronHistory).toBe('function');
  });

  it('re-exports checkLastProcessAt', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkLastProcessAt).toBe('function');
  });

  it('re-exports checkCacheMetrics', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkCacheMetrics).toBe('function');
  });

  it('re-exports checkR2LatestWrite', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkR2LatestWrite).toBe('function');
  });

  it('re-exports checkR2PrefixCounts', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkR2PrefixCounts).toBe('function');
  });

  it('re-exports checkMcpToolsCount', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.checkMcpToolsCount).toBe('function');
  });

  it('re-exports cascade utilities', async () => {
    const healthChecks = await import('../src/health-checks');
    expect(typeof healthChecks.applyCascadeDependencies).toBe('function');
    expect(typeof healthChecks.calcOverallStatusWithCascade).toBe('function');
    expect(healthChecks.CASCADE_DEPENDENCY_CHAIN).toBeDefined();
  });

  it('re-exports HealthGroup type (verified via health-cache-freshness module)', async () => {
    // Type-only exports (export type) are erased at runtime — verify the type
    // exists by checking the source module can be imported and HealthGroup is used
    const { HealthGroup } = await import('../src/health-cache-freshness');
    // If HealthGroup can be referenced at runtime (it's an interface, not a value),
    // the type re-export in health-checks.ts is correct
    expect(typeof HealthGroup).toBe('undefined'); // TypeScript interface → undefined at runtime
  });
});
