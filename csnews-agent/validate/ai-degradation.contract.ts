/**
 * AI Budget Phase 3 · degradation contract tests
 * 覆盖 getDegradationMessage / writeDegradedR2 / markAsDegraded / L4-L6 helpers
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getDegradationMessage,
  writeDegradedR2,
  markAsDegraded,
  writeDegradedKnowledge,
  writeDegradedFission,
  writeDegradedWarning,
  type AiDegradationEnv,
} from '../src/ai-degradation';

// ===========================
// Mock helpers
// ===========================

interface R2Store {
  [key: string]: { body: string; contentType?: string };
}

function createMockR2(prefill: R2Store = {}) {
  const store: R2Store = { ...prefill };
  return {
    put: async (key: string, body: string, options?: { httpMetadata?: { contentType: string } }) => {
      store[key] = { body, contentType: options?.httpMetadata?.contentType };
    },
    _store: store,
  };
}

function createMockKV(prefill: Record<string, string> = {}) {
  const store: Record<string, string> = { ...prefill };
  return {
    get: async (key: string) => store[key] ?? null,
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

function makeEnv(overrides: Partial<AiDegradationEnv> = {}): AiDegradationEnv {
  // 用动态今天 UTC 算 prefill key（避免测试运行时区问题）
  const todayUtc = new Date().toISOString().slice(0, 10);
  return {
    AI_USAGE_KV: createMockKV({
      [`usage/${todayUtc}`]: JSON.stringify({ total: 8000, calls: [] }), // shutdown threshold
    }),
    AI_BUDGET_DAILY_LIMIT: 10000,
    AI_BUDGET_WARNING_THRESHOLD: 5000,
    AI_BUDGET_CRITICAL_THRESHOLD: 7000,
    AI_BUDGET_SHUTDOWN_THRESHOLD: 8000,
    ...overrides,
  };
}

// ===========================
// 1. Unit: getDegradationMessage
// ===========================

describe('getDegradationMessage — 降级文案', () => {
  it('L4 默认文案', () => {
    expect(getDegradationMessage('L4')).toBe('AI budget exceeded for L4 threshold');
  });

  it('L5 默认文案', () => {
    expect(getDegradationMessage('L5')).toBe('AI budget exceeded for L5 threshold');
  });

  it('L6 默认文案', () => {
    expect(getDegradationMessage('L6')).toBe('AI budget exceeded for L6 threshold');
  });

  it('自定义 reason', () => {
    expect(getDegradationMessage('L5', 'Manual override')).toBe(
      'Manual override for L5 threshold',
    );
  });
});

// ===========================
// 2. Unit: writeDegradedR2
// ===========================

describe('writeDegradedR2 — R2 占位写入', () => {
  it('L4 返回 ai-degraded/{date}/{id}.md 路径', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any });
    const r2Key = await writeDegradedR2(env, 'L4', 'warn-123', {
      topic_key: 'AI_Revolution',
      warning_type: 'acceleration',
    });
    expect(r2Key).toMatch(/^ai-degraded\/\d{4}-\d{2}-\d{2}\/warn-123\.md$/);
    // 验证 markdown 写入
    const written = r2._store[r2Key];
    expect(written).toBeDefined();
    expect(written.contentType).toBe('text/markdown');
    expect(written.body).toContain('# L4 Degraded Insight');
    expect(written.body).toContain('**Topic**: AI_Revolution');
    expect(written.body).toContain('**Warning 类型**: acceleration');
    expect(written.body).toContain('AI budget shutdown'); // status 字段
    expect(written.body).toContain('8000 Neurons'); // used 字段
    expect(written.body).toContain('Warning 未走 LLM 深度分析'); // L4 行为说明
  });

  it('L5 返回 fission-degraded/{date}/{id}.md 路径', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any });
    const r2Key = await writeDegradedR2(env, 'L5', 'seed-abc', {
      seed: 'AI 革命',
    });
    expect(r2Key).toMatch(/^fission-degraded\/\d{4}-\d{2}-\d{2}\/seed-abc\.md$/);
    expect(r2._store[r2Key].body).toContain('Fission 跳过 LLM');
    expect(r2._store[r2Key].body).toContain('**Seed**: AI 革命');
  });

  it('L6 返回 knowledge-degraded/{date}/{id}.md 路径', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any });
    const r2Key = await writeDegradedR2(env, 'L6', 'topic-warn', {
      topic_key: 'Topic_Key',
    });
    expect(r2Key).toMatch(/^knowledge-degraded\/\d{4}-\d{2}-\d{2}\/topic-warn\.md$/);
    expect(r2._store[r2Key].body).toContain('Knowledge 写空 insight');
  });

  it('csnews_raw 未配置时仍返回 path（fail-soft）', async () => {
    const env = makeEnv(); // 无 csnews_raw
    const r2Key = await writeDegradedR2(env, 'L4', 'warn-x');
    expect(r2Key).toMatch(/^ai-degraded\/\d{4}-\d{2}-\d{2}\/warn-x\.md$/);
  });

  it('AI_USAGE_KV 未配置时 budget line fallback (fail-open)', async () => {
    const r2 = createMockR2();
    const env = makeEnv({
      csnews_raw: r2 as any,
      AI_USAGE_KV: undefined, // 显式 unset → getBudgetStatus fail-open 返 normal
    });
    const r2Key = await writeDegradedR2(env, 'L4', 'warn-y');
    // fail-open 行为：used=0 · status=normal · 仍写入 budget line
    expect(r2._store[r2Key].body).toContain('AI budget normal');
    expect(r2._store[r2Key].body).toContain('已用 0 Neurons');
  });
});

// ===========================
// 3. Unit: markAsDegraded
// ===========================

describe('markAsDegraded — Supabase PATCH degraded=true', () => {
  it('warnings 表 PATCH 成功', async () => {
    const mockSupabase = createMockSupabase({ patch: { ok: true } });
    const env = makeEnv({
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    // 用 vi.spyOn 替换 global fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );

    const marked = await markAsDegraded(env, 'warnings', 'warn-001', {
      r2Key: 'ai-degraded/2026-07-01/warn-001.md',
    });

    expect(marked).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockSupabase._calls[0].method).toBe('PATCH');
    expect(mockSupabase._calls[0].url).toContain('/rest/v1/warnings?id=eq.warn-001');
    expect(mockSupabase._calls[0].body).toEqual({
      degraded: true,
      report_r2_key: 'ai-degraded/2026-07-01/warn-001.md',
    });

    fetchSpy.mockRestore();
  });

  it('knowledge 表 PATCH + extra fields', async () => {
    const mockSupabase = createMockSupabase({ patch: { ok: true } });
    const env = makeEnv({
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );

    const marked = await markAsDegraded(env, 'knowledge', 'k-001', {
      r2Key: 'knowledge-degraded/2026-07-01/k-001.md',
      insight: 'AI budget exceeded, retry next day',
      confidence: 0,
    });

    expect(marked).toBe(true);
    expect(mockSupabase._calls[0].body).toEqual({
      degraded: true,
      report_r2_key: 'knowledge-degraded/2026-07-01/k-001.md',
      insight: 'AI budget exceeded, retry next day',
      confidence: 0,
    });

    fetchSpy.mockRestore();
  });

  it('Supabase 未配置时返 false（fail-soft）', async () => {
    const env = makeEnv(); // 无 SUPABASE_URL
    const marked = await markAsDegraded(env, 'warnings', 'warn-002');
    expect(marked).toBe(false);
  });

  it('PATCH HTTP 500 时返 false + log error', async () => {
    const mockSupabase = createMockSupabase({ patch: { ok: false, body: '500 server error' } });
    const env = makeEnv({
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const marked = await markAsDegraded(env, 'warnings', 'warn-003');

    expect(marked).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('PATCH throw 时返 false', async () => {
    const env = makeEnv({
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const marked = await markAsDegraded(env, 'warnings', 'warn-004');

    expect(marked).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// ===========================
// 4. Integration: writeDegradedKnowledge (L6 一站式)
// ===========================

describe('writeDegradedKnowledge — L6 一站式降级', () => {
  it('R2 写入 + Supabase mark 成功', async () => {
    const r2 = createMockR2();
    const mockSupabase = createMockSupabase({ patch: { ok: true } });
    const env = makeEnv({
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );

    const { r2Key, marked } = await writeDegradedKnowledge(
      env,
      'topic-1',
      'warn-1',
      { topic_key: 'AI_Rev', warning_type: 'acceleration', severity: '4' },
    );

    expect(r2Key).toMatch(/^knowledge-degraded\/\d{4}-\d{2}-\d{2}\/topic-1-warn-1\.md$/);
    expect(marked).toBe(true);
    expect(r2._store[r2Key].body).toContain('Knowledge 写空 insight');
    expect(mockSupabase._calls[0].body.insight).toBe(
      'AI budget exceeded, retry next day',
    );

    fetchSpy.mockRestore();
  });

  it('R2 写入成功但 Supabase PATCH 失败仍返 r2Key（fail-soft）', async () => {
    const r2 = createMockR2();
    const mockSupabase = createMockSupabase({ patch: { ok: false, body: 'error' } });
    const env = makeEnv({
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { r2Key, marked } = await writeDegradedKnowledge(env, 'topic-2', 'warn-2');

    expect(r2Key).toMatch(/^knowledge-degraded\//);
    expect(marked).toBe(false); // Supabase fail 但 r2Key 仍返
    expect(r2._store[r2Key]).toBeDefined();

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// ===========================
// 5. Integration: writeDegradedFission (L5 一站式)
// ===========================

describe('writeDegradedFission — L5 一站式降级', () => {
  it('写 R2 占位（不调 Supabase）', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any });

    const r2Key = await writeDegradedFission(env, 'seed-123', {
      seed: 'AI 革命',
    });

    expect(r2Key).toMatch(/^fission-degraded\/\d{4}-\d{2}-\d{2}\/seed-123\.md$/);
    expect(r2._store[r2Key].body).toContain('Fission 跳过 LLM');
    expect(r2._store[r2Key].body).toContain('**Seed**: AI 革命');
  });

  it('不传 context 时不报错（context 默认值）', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any });

    const r2Key = await writeDegradedFission(env, 'seed-456');

    expect(r2Key).toMatch(/^fission-degraded\//);
    expect(r2._store[r2Key].body).toContain('_无额外 context_');
  });
});

// ===========================
// 6. Integration: writeDegradedWarning (L4 一站式)
// ===========================

describe('writeDegradedWarning — L4 一站式降级', () => {
  it('R2 + Supabase mark degraded=true', async () => {
    const r2 = createMockR2();
    const mockSupabase = createMockSupabase({ patch: { ok: true } });
    const env = makeEnv({
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );

    const { r2Key, marked } = await writeDegradedWarning(env, 'warn-100', {
      topic_key: 'AI_Rev',
      warning_type: 'acceleration',
      severity: '5',
    });

    expect(r2Key).toMatch(/^ai-degraded\/\d{4}-\d{2}-\d{2}\/warn-100\.md$/);
    expect(marked).toBe(true);
    expect(r2._store[r2Key].body).toContain('Warning 未走 LLM 深度分析');
    expect(mockSupabase._calls[0].url).toContain('/rest/v1/warnings?id=eq.warn-100');
    expect(mockSupabase._calls[0].body).toEqual({
      degraded: true,
      report_r2_key: r2Key,
    });

    fetchSpy.mockRestore();
  });

  it('不带 context 调用（news-process.ts 集成场景）', async () => {
    const r2 = createMockR2();
    const mockSupabase = createMockSupabase({ patch: { ok: true } });
    const env = makeEnv({
      csnews_raw: r2 as any,
      SUPABASE_URL: 'test.supabase.co',
      SUPABASE_SERVICE_KEY: 'test-key',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      mockSupabase.fetch as any,
    );

    const { r2Key, marked } = await writeDegradedWarning(env, 'warn-200');

    expect(marked).toBe(true);
    expect(r2Key).toMatch(/^ai-degraded\//);
    expect(r2._store[r2Key].body).toContain('_无额外 context_');

    fetchSpy.mockRestore();
  });
});

// ===========================
// 7. Edge cases
// ===========================

describe('Edge cases', () => {
  it('R2 写入失败时 writeDegradedR2 不抛错', async () => {
    const env = makeEnv({
      csnews_raw: {
        put: async () => {
          throw new Error('R2 down');
        },
      } as any,
    });
    // 不抛错 · 仍返 path（fail-soft 设计）
    const r2Key = await writeDegradedR2(env, 'L4', 'warn-300');
    expect(r2Key).toMatch(/^ai-degraded\//);
  });

  it('writeDegradedKnowledge 时 Supabase 未配置只写 R2', async () => {
    const r2 = createMockR2();
    const env = makeEnv({ csnews_raw: r2 as any }); // 无 Supabase

    const { r2Key, marked } = await writeDegradedKnowledge(env, 'topic-x', 'warn-x');

    expect(marked).toBe(false); // Supabase 未配
    expect(r2Key).toMatch(/^knowledge-degraded\//); // R2 仍写
    expect(r2._store[r2Key]).toBeDefined();
  });
});