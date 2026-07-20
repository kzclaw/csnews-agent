/**
 * AI Budget Phase 5 · Integration — 3-tier degradation end-to-end
 *
 * Validates the full workflow from Neurons usage accumulation (5K / 7K / 8K)
 * through shouldTriggerAiCall threshold checks to Phase 3 writeDegradedX
 * helpers writing R2 placeholders and PATCHing Supabase degraded=true.
 *
 * These tests cover the cross-module integration that unit tests in
 * ai-budget.contract.ts (budget tier calculations) and
 * ai-degradation.contract.ts (individual helper behavior) cannot verify
 * in isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  shouldTriggerAiCall,
  type AiBudgetEnv,
} from '../src/ai-budget';
import {
  writeDegradedWarning,
  writeDegradedFission,
  writeDegradedKnowledge,
  type AiDegradationEnv,
} from '../src/ai-degradation';

// ===========================
// Mock helpers (shared with ai-degradation.contract.ts)
// ===========================

interface R2Store {
  [key: string]: { body: string; contentType?: string };
}

function createMockR2(prefill: R2Store = {}) {
  const store: R2Store = { ...prefill };
  return {
    put: async (
      key: string,
      body: string,
      options?: { httpMetadata?: { contentType: string } },
    ) => {
      store[key] = { body, contentType: options?.httpMetadata?.contentType };
    },
    _store: store,
  };
}

function createMockSupabase(responses: { patch?: { ok: boolean; body?: string } } = {}) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  return {
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method || 'GET',
        url,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      const r = responses.patch ?? { ok: true, body: '[]' };
      return {
        ok: r.ok,
        text: async () => r.body || '',
        status: r.ok ? 200 : 500,
      };
    },
    _calls: calls,
  };
}

/**
 * Construct an env whose AI_USAGE_KV reads back a fixed daily usage value.
 * The dynamic today-UTC key avoids timezone brittleness in tests.
 */
function makeEnvWithUsage(usage: number, extra: Partial<AiBudgetEnv> = {}): AiBudgetEnv {
  const todayUtc = new Date().toISOString().slice(0, 10);
  return {
    AI_USAGE_KV: {
      get: async (key: string) => {
        if (key === `usage/${todayUtc}`) {
          return JSON.stringify({ total: usage, calls: [] });
        }
        return null;
      },
    },
    AI_BUDGET_DAILY_LIMIT: 10000,
    AI_BUDGET_WARNING_THRESHOLD: 5000,
    AI_BUDGET_CRITICAL_THRESHOLD: 7000,
    AI_BUDGET_SHUTDOWN_THRESHOLD: 8000,
    ...extra,
  };
}

// ===========================
// 1. Threshold matrix at each tier (5K / 7K / 8K)
// ===========================

describe('Integration — shouldTriggerAiCall threshold matrix at 5K / 7K / 8K', () => {
  it('5K (warning tier) — L4 / L5 / L6 all allowed', async () => {
    // 5K maps to warning (5K-7K). Per-AI-level thresholds from
    // ai-budget.ts: L4<7K · L5<8K · L6<10K. At 5K:
    //   L4 (5K<7K)  → allowed
    //   L5 (5K<8K)  → allowed
    //   L6 (5K<10K) → allowed (L6 has the most generous 10K budget)
    const env = makeEnvWithUsage(5000);
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(true);
  });

  it('7K (critical tier) — L4 blocked, L5 / L6 allowed', async () => {
    // 7K maps to critical (7K-8K). L4 blocked (>= critical 7K).
    // L5 still allowed (7K < shutdown 8K). L6 still allowed (7K < daily limit 10K).
    const env = makeEnvWithUsage(7000);
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(true);
  });

  it('8.5K (shutdown tier) — L4 / L5 blocked, L6 still allowed, L1-L3 still allowed', async () => {
    // 8.5K > shutdown threshold 8K → L4 / L5 blocked.
    // L6 still allowed (8.5K < daily limit 10K).
    // L1-L3 are always allowed by design.
    const env = makeEnvWithUsage(8500);
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L1')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L2')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L3')).resolves.toBe(true);
  });

  it('10K (daily limit) — L4 / L5 / L6 all blocked, L1-L3 still allowed', async () => {
    // 10K = daily limit. L6 blocked (NOT < 10K).
    // L4 / L5 already blocked at 8K+.
    // L1-L3 always allowed.
    const env = makeEnvWithUsage(10000);
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L1')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L2')).resolves.toBe(true);
    await expect(shouldTriggerAiCall(env, 'L3')).resolves.toBe(true);
  });
});

// ===========================
// 2. L4 workflow: 7K triggers warning → writeDegradedWarning
// ===========================

describe('Integration — L4 warning degradation at 7K', () => {
  it('7K usage · shouldTriggerAiCall L4=false · writeDegradedWarning writes R2 + marks Supabase', async () => {
    const env = makeEnvWithUsage(7000);

    // 1. shouldTriggerAiCall L4 returns false (>= critical 7K)
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(false);

    // 2. Simulate news-process.ts recordTrendWithMember behavior:
    //    after warning is inserted by the SQL function, if L4 budget exhausted,
    //    mark degraded=true and write the L4 placeholder.
    const r2 = createMockR2();
    const supabase = createMockSupabase({ patch: { ok: true } });
    const degradationEnv: AiDegradationEnv = {
      ...env,
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(supabase.fetch as any);

    const { r2Key, marked } = await writeDegradedWarning(degradationEnv, 'warn-001');

    expect(marked).toBe(true);
    expect(r2Key).toMatch(/^ai-degraded\/\d{4}-\d{2}-\d{2}\/warn-001\.md$/);
    expect(r2._store[r2Key].body).toContain('AI budget critical'); // 7K = critical tier
    expect(r2._store[r2Key].body).toContain('Warning 未走 LLM 深度分析');
    expect(supabase._calls[0].url).toContain('/rest/v1/warnings?id=eq.warn-001');
    expect(supabase._calls[0].body).toEqual({ degraded: true, report_r2_key: r2Key });

    fetchSpy.mockRestore();
  });

  it('5K usage · shouldTriggerAiCall L4=true (still allowed) — no degradation triggered', async () => {
    // At 5K, L4 is allowed (5K < critical 7K). Caller would proceed with
    // the normal LLM path, not the degradation path.
    const env = makeEnvWithUsage(5000);
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(true);
    // No call to writeDegradedWarning → no R2 / Supabase writes happen.
  });
});

// ===========================
// 3. L5 workflow: 8K triggers fission → writeDegradedFission
// ===========================

describe('Integration — L5 fission degradation at 8K', () => {
  it('8K usage · shouldTriggerAiCall L5=false · writeDegradedFission writes R2 only (no Supabase)', async () => {
    // 8K maps to shutdown (>= 8K). L5 blocked (>= shutdown).
    const env = makeEnvWithUsage(8000);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(false);

    // Simulate endpoints-core.ts handleFissionAction behavior:
    //    keep the skipped response shape, add a degraded_r2_key field.
    //    No Supabase writes (fission_searches belongs to csnews-fission worker).
    const r2 = createMockR2();
    const degradationEnv: AiDegradationEnv = {
      ...env,
      csnews_raw: r2 as any,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const r2Key = await writeDegradedFission(degradationEnv, 'seed-abc', {
      seed: 'AI 革命',
    });

    expect(r2Key).toMatch(/^fission-degraded\/\d{4}-\d{2}-\d{2}\/seed-abc\.md$/);
    expect(r2._store[r2Key].body).toContain('AI budget shutdown');
    expect(r2._store[r2Key].body).toContain('Fission 跳过 LLM');
    expect(r2._store[r2Key].body).toContain('**Seed**: AI 革命');
    // No fetch call to Supabase (writeDegradedFission is R2-only)
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('7K usage · shouldTriggerAiCall L5=true (still allowed)', async () => {
    // At 7K (critical), L5 is allowed (7K < shutdown 8K).
    const env = makeEnvWithUsage(7000);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(true);
  });
});

// ===========================
// 4. L6 workflow: 10K triggers knowledge → writeDegradedKnowledge
// ===========================

describe('Integration — L6 knowledge degradation at 10K', () => {
  it('10K usage · shouldTriggerAiCall L6=false · writeDegradedKnowledge writes R2 + marks Supabase', async () => {
    // 10K = daily limit. L6 blocked (>= daily limit).
    const env = makeEnvWithUsage(10000);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(false);

    // Simulate endpoints-trend.ts runKnowledgeGeneration L6 hook behavior:
    //    instead of returning 0, write a degraded knowledge record per
    //    pending warning so downstream consumers can identify today's
    //    degraded insights and retry tomorrow.
    const r2 = createMockR2();
    const supabase = createMockSupabase({ patch: { ok: true } });
    const degradationEnv: AiDegradationEnv = {
      ...env,
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(supabase.fetch as any);

    const { r2Key, marked } = await writeDegradedKnowledge(
      degradationEnv,
      'topic-001',
      'warn-001',
      { topic_key: 'AI_Rev', warning_type: 'acceleration', severity: '5' },
    );

    expect(marked).toBe(true);
    expect(r2Key).toMatch(/^knowledge-degraded\/\d{4}-\d{2}-\d{2}\/topic-001-warn-001\.md$/);
    expect(r2._store[r2Key].body).toContain('AI budget shutdown'); // 10K = shutdown tier
    expect(r2._store[r2Key].body).toContain('Knowledge 写空 insight');
    expect(supabase._calls[0].url).toContain('/rest/v1/knowledge?id=eq.warn-001');
    expect(supabase._calls[0].body).toEqual({
      degraded: true,
      report_r2_key: r2Key,
      insight: 'AI budget exceeded, retry next day',
      confidence: 0,
    });

    fetchSpy.mockRestore();
  });

  it('8.5K usage · shouldTriggerAiCall L6=true (still allowed, below daily limit)', async () => {
    // At 8.5K (shutdown tier), L4/L5 are blocked but L6 is still allowed
    // (8.5K < daily limit 10K). This is why we need Phase 5/6 Spec Kit
    // documentation to clarify the per-AI-level threshold design.
    const env = makeEnvWithUsage(8500);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(true);
  });
});

// ===========================
// 5. End-to-end full flow: 8.5K triggers L4/L5/L6 all degraded
// ===========================

describe('Integration — 10K triggers all three degradation paths in one workflow', () => {
  it('10K usage · all three helpers write to R2 + Supabase concurrently', async () => {
    const env = makeEnvWithUsage(10000);

    // Verify all three are blocked at 10K (daily limit)
    await expect(shouldTriggerAiCall(env, 'L4')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L5')).resolves.toBe(false);
    await expect(shouldTriggerAiCall(env, 'L6')).resolves.toBe(false);

    // Set up mock R2 + Supabase for all three helpers
    const r2 = createMockR2();
    const supabase = createMockSupabase({ patch: { ok: true } });
    const degradationEnv: AiDegradationEnv = {
      ...env,
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(supabase.fetch as any);

    // L4 (news-process.ts recordTrendWithMember)
    const l4 = await writeDegradedWarning(degradationEnv, 'warn-001');
    // L5 (endpoints-core.ts handleFissionAction)
    const l5r2Key = await writeDegradedFission(degradationEnv, 'seed-abc');
    // L6 (endpoints-trend.ts runKnowledgeGeneration)
    const l6 = await writeDegradedKnowledge(degradationEnv, 'topic-001', 'warn-001');

    expect(l4.marked).toBe(true);
    expect(l6.marked).toBe(true);
    // L5 only writes R2 (no Supabase)
    expect(l5r2Key).toMatch(/^fission-degraded\//);

    // Verify all three R2 keys exist with expected prefixes
    expect(l4.r2Key).toMatch(/^ai-degraded\//);
    expect(l5r2Key).toMatch(/^fission-degraded\//);
    expect(l6.r2Key).toMatch(/^knowledge-degraded\//);

    // Verify two Supabase PATCH calls (L4 to warnings, L6 to knowledge)
    // L5 has no Supabase call.
    const patchCalls = supabase._calls.filter((c) => c.method === 'PATCH');
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0].url).toContain('/rest/v1/warnings?id=eq.warn-001');
    expect(patchCalls[1].url).toContain('/rest/v1/knowledge?id=eq.warn-001');

    fetchSpy.mockRestore();
  });
});

// ===========================
// 6. Fail-soft: Supabase PATCH failure does not break R2 writes
// ===========================

describe('Integration — Supabase PATCH failure is non-fatal (fail-soft)', () => {
  it('L4 degraded: R2 written + Supabase PATCH fails → marked=false but r2Key still returned', async () => {
    const env = makeEnvWithUsage(7000);
    const r2 = createMockR2();
    const supabase = createMockSupabase({ patch: { ok: false, body: '500 server error' } });
    const degradationEnv: AiDegradationEnv = {
      ...env,
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(supabase.fetch as any);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { r2Key, marked } = await writeDegradedWarning(degradationEnv, 'warn-001');

    // R2 was written
    expect(r2Key).toMatch(/^ai-degraded\//);
    expect(r2._store[r2Key]).toBeDefined();
    // Supabase marked=false but caller still gets r2Key for traceability
    expect(marked).toBe(false);

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});