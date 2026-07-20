/**
 * Business contract tests for process-vector.ts embedTitle().
 *
 * Verifies the title+summary concat logic so News Self Growth clustering
 * benefits from the extra semantic signal without changing the per-call
 * AI cost (still 1 bge-m3 call per news).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';

// Make a per-test mock that captures the actual `text` argument the
// embedTitle function sends to AI.run, so we can assert what got embedded.
function makeMockEnv() {
  const run = vi.fn(async (_model: string, payload: { text: string[] }) => {
    // Deterministic embedding derived from content (not just length) so
    // tests can distinguish identical vs different inputs even when two
    // different titles happen to share the same total length.
    const tag = payload.text[0];
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
      hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    }
    return {
      shape: [1, 1024] as [number, number],
      data: [{ embedding: new Array(1024).fill(0).map((_, i) => (i === 0 ? hash : 0)) }],
    };
  });
  return {
    AI: { run } as unknown as Ai,
  };
}

describe('embedTitle(title, summary?) — input shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('title-only (no summary) sends text: [title]', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    await embedTitle(env as any, '日本九州地震');
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const payload = (env.AI.run as any).mock.calls[0][1];
    expect(payload.text).toEqual(['日本九州地震']);
  });

  it('title+summary sends combined text "title summary" with single space sep', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    await embedTitle(env as any, '日本九州地震', '7.3 级 已致 10 人死亡');
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const payload = (env.AI.run as any).mock.calls[0][1];
    expect(payload.text).toEqual(['日本九州地震 7.3 级 已致 10 人死亡']);
  });

  it('empty-string summary falls back to title-only (no double-space)', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    await embedTitle(env as any, '日本九州地震', '   ');
    const payload = (env.AI.run as any).mock.calls[0][1];
    // Trim empty summary → just title
    expect(payload.text).toEqual(['日本九州地震']);
  });
});

describe('embedTitle — determinism (same input → identical embedding)', () => {
  it('same title+summary yields identical embedding across two calls', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    const e1 = await embedTitle(env as any, '日本九州地震', '7.3 级死亡 10 人');
    const e2 = await embedTitle(env as any, '日本九州地震', '7.3 级死亡 10 人');
    expect(e1).toEqual(e2);
    expect(e1.length).toBe(1024);
  });

  it('title-only is fully backward compatible (matches prior behavior)', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    const e1 = await embedTitle(env as any, '日本九州地震');
    const e2 = await embedTitle(env as any, '日本九州地震');
    expect(e1).toEqual(e2);
    // First embedding element reflects the content hash (deterministic)
    expect(typeof e1[0]).toBe('number');
    expect(e1[0]).not.toBe(0);
  });
});

describe('embedTitle — different inputs yield different embeddings', () => {
  it('same title + different summary → different combined input → different embedding', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    const e1 = await embedTitle(env as any, '日本九州地震', '7.3 级 已致 10 人死亡');
    const e2 = await embedTitle(env as any, '日本九州地震', '震后救援工作全面展开');
    // mock embedding uses content hash (different combined → different hash)
    expect(e1[0]).not.toBe(e2[0]);
  });

  it('different title + same summary → different combined input → different embedding', async () => {
    const env = makeMockEnv();
    const { embedTitle } = await import('../src/process-vector');
    const e1 = await embedTitle(env as any, '九州地震', '7.3 级 已致 10 人死亡');
    const e2 = await embedTitle(env as any, '地震救援', '7.3 级 已致 10 人死亡');
    expect(e1[0]).not.toBe(e2[0]);
  });
});

describe('embedTitle — failure handling', () => {
  it('returns empty array on AI.run throw (non-fatal)', async () => {
    const env = {
      AI: {
        run: vi.fn().mockRejectedValue(new Error('bge-m3 down')),
      },
    };
    const { embedTitle } = await import('../src/process-vector');
    const e = await embedTitle(env as any, 'title', 'summary');
    expect(e).toEqual([]);
  });

  it('returns empty array when AI returns unexpected shape', async () => {
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue({ shape: [0, 0], data: [] }),
      },
    };
    const { embedTitle } = await import('../src/process-vector');
    const e = await embedTitle(env as any, 'title');
    expect(e).toEqual([]);
  });
});
