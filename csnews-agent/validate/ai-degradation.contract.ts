/**
 * CSNEWS Agent · AI 降级策略业务契约 (Phase 3)
 *
 * 业务红线:
 *   - getDegradationMessage 4 种 level 返回对应文案，非法 level 返回兜底
 *   - writeDegradedInsight: R2 存在时写成功，不存在时跳过
 *   - markAsDegraded: 合法 table PATCH 成功，非法 table 跳过，网络失败静默
 *
 * 详见：tasks/csnews-agent-okr.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getDegradationMessage,
  writeDegradedInsight,
  markAsDegraded,
} from '../src/ai-degradation';
import type { Env } from '../src/shared';
import { createMockR2Bucket } from '../src/test-helpers';

// ============================================================
// getDegradationMessage — 4 种 level
// ============================================================
describe('getDegradationMessage · 降级文案', () => {
  it('warning → 返回 warning 文案', () => {
    const msg = getDegradationMessage('warning');
    expect(msg).toContain('AI 预算接近上限');
  });

  it('critical → 返回 critical 文案', () => {
    const msg = getDegradationMessage('critical');
    expect(msg).toContain('AI 预算已达临界值');
  });

  it('shutdown → 返回 shutdown 文案', () => {
    const msg = getDegradationMessage('shutdown');
    expect(msg).toContain('AI 预算已耗尽');
  });

  it('非法 level → 返回兜底文案', () => {
    const msg = getDegradationMessage('unknown-level' as any);
    expect(msg).toBe('AI 预算超额，功能暂时降级。');
  });
});

// ============================================================
// writeDegradedInsight — 2 种场景
// ============================================================
describe('writeDegradedInsight · R2 占位文档', () => {
  const makeEnv = (r2Put: ReturnType<typeof vi.fn>) => {
    const r2 = createMockR2Bucket();
    r2.put = r2Put;
    return {
      csnews_raw: r2,
      AI_USAGE_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({ total: 6000, calls: [] })
        ),
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Env;
  };

  it('csnews_raw 存在 → 写入成功，put 被调用', async () => {
    const putMock = vi.fn().mockResolvedValue({});
    const env = makeEnv(putMock);

    await writeDegradedInsight(env, 'warning-001', 'warning', 'AI大模型');

    expect(putMock).toHaveBeenCalledOnce();
    const [key, content] = (putMock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toMatch(/^ai-degraded\/\d{4}-\d{2}-\d{2}\/warning-001\.md$/);
    expect(content).toContain('warning');
    expect(content).toContain('AI大模型');
    expect(content).toContain('6000'); // neurons_used
  });

  it('csnews_raw 不存在 → put 不被调用，不抛异常', async () => {
    const env = { csnews_raw: undefined } as unknown as Env;
    await expect(
      writeDegradedInsight(env, 'warning-001', 'warning', 'AI大模型')
    ).resolves.not.toThrow();
  });
});

// ============================================================
// markAsDegraded — 3 种场景
// ============================================================
describe('markAsDegraded · Supabase 标记', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const makeEnv = (fetchMock: typeof fetch) => {
    return {
      SUPABASE_URL: 'irkydywmreqcrmrxmfzy',
      SUPABASE_SERVICE_KEY: 'mock-service-key',
      fetch: fetchMock,
    } as unknown as Env;
  };

  it('合法 table + 响应成功 → PATCH 被调用一次', async () => {
    const patchMock = vi.fn().mockResolvedValue(
      new Response('', { status: 200 })
    );
    globalThis.fetch = patchMock;
    const env = makeEnv(patchMock as unknown as typeof fetch);

    await markAsDegraded(env, 'warning-001', 'warnings');

    expect(patchMock).toHaveBeenCalledOnce();
    const [url, options] = patchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rest/v1/warnings?id=eq.warning-001');
    expect(options.method).toBe('PATCH');
    expect(options.body).toContain('"degraded":true');
  });

  it('非法 table → fetch 不被调用，不抛异常', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const env = makeEnv(fetchMock as unknown as typeof fetch);

    await expect(
      markAsDegraded(env, 'warning-001', 'unknown_table' as any)
    ).resolves.not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PATCH 响应非 200 → fetch 被调用，异常静默', async () => {
    const patchMock = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    globalThis.fetch = patchMock;
    const env = makeEnv(patchMock as unknown as typeof fetch);

    await expect(
      markAsDegraded(env, 'warning-001', 'warnings')
    ).resolves.not.toThrow();
    expect(patchMock).toHaveBeenCalledOnce();
  });
});
