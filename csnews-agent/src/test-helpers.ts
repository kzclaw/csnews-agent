/**
 * CSNEWS Agent · 测试 mock helpers (v0.36.8 · KR0)
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */
import { vi } from 'vitest';

/**
 * 定位：业务契约验证的 mock 共享库
 * 用途：validate/*.contract.ts 里复用，不重复写 mock 逻辑
 *
 * KR0 规划 (v0.33+sweep · Foundation 0 第 2 步):
 *   - mock supabaseFetch (R2 + KV + Supabase DB 响应)
 *   - mock R2 bucket operations
 *   - mock KV namespace
 *   - mock Workers AI
 *   - 共享 fixture factory
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */

// ============================================================
// Mock supabaseFetch
// ============================================================

export interface MockSupabaseFetchOptions {
  json?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export function createMockSupabaseFetch(
  options: MockSupabaseFetchOptions = {}
): typeof fetch {
  const { json = {}, status = 200, headers = {} } = options;
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(json), {
      status,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
    })
  );
}

export function createMockSupabaseFetchWithRange(
  data: unknown[],
  total: number,
  start = 0,
  end = data.length - 1
): typeof fetch {
  return createMockSupabaseFetch({
    json: data,
    headers: {
      'content-range': `0-${end}/${total}`,
    },
  });
}

// ============================================================
// Mock R2 bucket
// ============================================================

export function createMockR2Bucket(): {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
  };
}

// ============================================================
// Mock KV namespace
// ============================================================

export function createMockKVNamespace(
  initial: Record<string, string> = {}
): {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const store = { ...initial };
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      return store[key] ?? null;
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      delete store[key];
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  };
}

// ============================================================
// Mock Workers AI
// ============================================================

export function createMockWorkersAI(
  result: unknown = { response: 'mocked response' }
): {
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn().mockResolvedValue(result),
  };
}

// ============================================================
// Shared fixtures
// ============================================================

export const SAMPLE_TOPICS = [
  { id: 'topic-001', topic_key: 'AI大模型', level: 'explosive', score: 9, news_count: 42 },
  { id: 'topic-002', topic_key: '新能源车', level: 'important', score: 6, news_count: 28 },
  { id: 'topic-003', topic_key: '半导体', level: 'follow', score: 3, news_count: 15 },
];

export const SAMPLE_NEWS = [
  {
    id: 'news-001',
    title: 'OpenAI 发布 GPT-5',
    content: 'OpenAI 今日正式发布 GPT-5，性能大幅提升...',
    source: 'tech-crunch',
    url: 'https://example.com/gpt5',
    published_at: '2026-06-16T00:00:00Z',
  },
  {
    id: 'news-002',
    title: '特斯拉自动驾驶新进展',
    content: '特斯拉 FSD 最新版本在城市道路上表现优异...',
    source: 'reuters',
    url: 'https://example.com/tesla-fsd',
    published_at: '2026-06-15T12:00:00Z',
  },
];

export const SAMPLE_ZSCORE_HISTORY = [8, 9, 10, 11, 12]; // μ=10, σ≈1.414
