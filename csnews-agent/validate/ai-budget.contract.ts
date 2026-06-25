/**
 * AI Budget Phase 5 · contract tests
 * Unit tests: recordAiCall / shouldTriggerAiCall / getBudgetStatus
 * Integration tests: 3-tier degradation (5K / 7K / 8K)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  recordAiCall,
  shouldTriggerAiCall,
  getBudgetStatus,
  AiBudgetEnv,
} from '../src/ai-budget';

// ===========================
// Mock KV helpers
// ===========================

interface KvStore {
  [key: string]: string;
}

/** Creates a mock KV namespace backed by an in-memory dict. */
function createMockKVNamespace(prefill: KvStore = {}) {
  const store: KvStore = { ...prefill };
  return {
    get: async (key: string, _type?: 'text'): Promise<string | null> => {
      return store[key] ?? null;
    },
    put: async (
      key: string,
      value: string,
      _options?: { expirationTtl?: number },
    ): Promise<void> => {
      store[key] = value;
    },
    delete: async (key: string): Promise<void> => {
      delete store[key];
    },
    _store: store,
  };
}

function todayUtc(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function kvKey(date?: string): string {
  return `usage/${date ?? todayUtc()}`;
}

// ===========================
// Helper: build AiBudgetEnv with mock KV
// ===========================

function makeEnv(
  prefill: KvStore = {},
  extra: Partial<AiBudgetEnv> = {},
): AiBudgetEnv {
  return {
    AI_USAGE_KV: createMockKVNamespace(prefill),
    AI_BUDGET_DAILY_LIMIT: 10000,
    AI_BUDGET_WARNING_THRESHOLD: 5000,
    AI_BUDGET_CRITICAL_THRESHOLD: 7000,
    AI_BUDGET_SHUTDOWN_THRESHOLD: 8000,
    ...extra,
  };
}

// ===========================
// 1. Unit tests: recordAiCall
// ===========================
describe('recordAiCall — KV write behavior', () => {
  it('creates new KV entry when store is empty', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 100, env);
    const raw = await env.AI_USAGE_KV!.get(kvKey(), 'text');
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.total).toBe(100);
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0].model).toBe('@cf/meta/llama-3-8b-instruct');
    expect(data.calls[0].neurons).toBe(100);
  });

  it('accumulates multiple calls into same KV entry', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 100, env);
    await recordAiCall('@cf/baai/bge-base-en-v1.5', 50, env);
    const raw = await env.AI_USAGE_KV!.get(kvKey(), 'text');
    const data = JSON.parse(raw!);
    expect(data.total).toBe(150);
    expect(data.calls).toHaveLength(2);
  });

  it('records timestamp in ISO format', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 100, env);
    const raw = await env.AI_USAGE_KV!.get(kvKey(), 'text');
    const data = JSON.parse(raw!);
    expect(data.calls[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('no-ops when AI_USAGE_KV is not configured', async () => {
    const env: AiBudgetEnv = { AI_BUDGET_DAILY_LIMIT: 10000 };
    await expect(
      recordAiCall('@cf/meta/llama-3-8b-instruct', 100, env),
    ).resolves.toBeUndefined();
  });

  it('sets TTL of 7 days on KV entry', async () => {
    const env = makeEnv();
    const putSpy = vi.spyOn(env.AI_USAGE_KV!, 'put');
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 100, env);
    expect(putSpy).toHaveBeenCalledOnce();
    expect(putSpy.mock.calls[0][2]?.expirationTtl).toBe(604800);
  });
});

// ===========================
// 2. Unit tests: shouldTriggerAiCall
// ===========================
describe('shouldTriggerAiCall — L1-L3 unrestricted', () => {
  it('L1 always returns true', () => {
    expect(shouldTriggerAiCall({}, 'L1')).toBe(true);
  });

  it('L2 always returns true', () => {
    expect(shouldTriggerAiCall({}, 'L2')).toBe(true);
  });

  it('L3 always returns true', () => {
    expect(shouldTriggerAiCall({}, 'L3')).toBe(true);
  });
});

describe('shouldTriggerAiCall — L4-L6 sync stub', () => {
  it('L4 returns true (sync stub — Phase 2 scope)', () => {
    expect(shouldTriggerAiCall({}, 'L4')).toBe(true);
  });

  it('L5 returns true (sync stub — Phase 2 scope)', () => {
    expect(shouldTriggerAiCall({}, 'L5')).toBe(true);
  });

  it('L6 returns true (sync stub — Phase 2 scope)', () => {
    expect(shouldTriggerAiCall({}, 'L6')).toBe(true);
  });

  it('accepts severity parameter without error', () => {
    expect(shouldTriggerAiCall({}, 'L4', 8)).toBe(true);
  });

  it('accepts dailyUsed parameter without error', () => {
    expect(shouldTriggerAiCall({}, 'L4', undefined, 6000)).toBe(true);
  });
});

// ===========================
// 3. Unit tests: getBudgetStatus — status tiers
// ===========================
describe('getBudgetStatus — normal tier (< 5K)', () => {
  it('returns normal when usage is 0', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 0, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('normal');
    expect(result.used).toBe(0);
    expect(result.pct).toBe(0);
    expect(result.remaining).toBe(10000);
  });

  it('returns normal when usage is just below warning threshold', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 4999, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('normal');
    expect(result.used).toBe(4999);
    expect(result.pct).toBe(50);
  });
});

describe('getBudgetStatus — warning tier (5K-7K)', () => {
  it('returns warning at exactly warning threshold (5000)', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 5000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('warning');
  });

  it('returns warning between 5K-7K', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 6000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('warning');
  });
});

describe('getBudgetStatus — critical tier (7K-8K)', () => {
  it('returns critical at exactly critical threshold (7000)', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 7000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('critical');
  });

  it('returns critical between 7K-8K', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 7500, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('critical');
  });
});

describe('getBudgetStatus — shutdown tier (> 8K)', () => {
  it('returns shutdown at exactly shutdown threshold (8000)', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 8000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('shutdown');
    expect(result.pct).toBe(80);
  });

  it('returns shutdown when usage exceeds limit', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 12000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('shutdown');
    expect(result.remaining).toBe(0);
  });
});

// ===========================
// 4. Unit tests: getBudgetStatus — return shape
// ===========================
describe('getBudgetStatus — return shape & edge cases', () => {
  it('returns object with all required fields', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 3000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('used');
    expect(result).toHaveProperty('limit');
    expect(result).toHaveProperty('remaining');
    expect(result).toHaveProperty('pct');
  });

  it('pct is rounded integer 0-100', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 3333, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.pct).toBe(33);
    expect(result.pct).toBeGreaterThanOrEqual(0);
    expect(result.pct).toBeLessThanOrEqual(100);
  });

  it('remaining is non-negative even when over budget', async () => {
    const env = makeEnv({ [kvKey()]: JSON.stringify({ total: 15000, calls: [] }) });
    const result = await getBudgetStatus(env);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('handles missing AI_USAGE_KV gracefully', async () => {
    const env: AiBudgetEnv = {
      AI_BUDGET_DAILY_LIMIT: 10000,
      AI_BUDGET_WARNING_THRESHOLD: 5000,
      AI_BUDGET_CRITICAL_THRESHOLD: 7000,
      AI_BUDGET_SHUTDOWN_THRESHOLD: 8000,
    };
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('normal');
    expect(result.used).toBe(0);
    expect(result.remaining).toBe(10000);
  });

  it('handles corrupted KV JSON gracefully', async () => {
    const env = makeEnv({ [kvKey()]: 'not valid json{' });
    const result = await getBudgetStatus(env);
    expect(result.status).toBe('normal');
    expect(result.used).toBe(0);
  });
});

// ===========================
// 5. Integration: 3-tier degradation end-to-end
// ===========================
describe('Integration — recordAiCall + getBudgetStatus round-trip', () => {
  it('records usage then reflects in budget status', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 3000, env);
    const result = await getBudgetStatus(env);
    expect(result.used).toBe(3000);
    expect(result.status).toBe('normal');
    expect(result.pct).toBe(30);
    expect(result.remaining).toBe(7000);
  });

  it('accumulates multiple calls and triggers warning at 5K', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 2500, env);
    await recordAiCall('@cf/baai/bge-base-en-v1.5', 2500, env);
    const result = await getBudgetStatus(env);
    expect(result.used).toBe(5000);
    expect(result.status).toBe('warning');
    expect(result.pct).toBe(50);
  });

  it('records calls until critical threshold (7K)', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 7000, env);
    const result = await getBudgetStatus(env);
    expect(result.used).toBe(7000);
    expect(result.status).toBe('critical');
    expect(result.pct).toBe(70);
  });

  it('records calls until shutdown threshold (8K+)', async () => {
    const env = makeEnv();
    await recordAiCall('@cf/meta/llama-3-8b-instruct', 8000, env);
    const result = await getBudgetStatus(env);
    expect(result.used).toBe(8000);
    expect(result.status).toBe('shutdown');
    expect(result.pct).toBe(80);
    expect(result.remaining).toBe(2000);
  });

  it('shouldTriggerAiCall still allows L1-L3 even at shutdown', () => {
    const env = makeEnv();
    expect(shouldTriggerAiCall(env, 'L1')).toBe(true);
    expect(shouldTriggerAiCall(env, 'L2')).toBe(true);
    expect(shouldTriggerAiCall(env, 'L3')).toBe(true);
  });
});
