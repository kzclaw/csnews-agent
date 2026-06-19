/**
 * CSNEWS Agent · KV 缓存 utility 契约验证
 *
 * 30 场景覆盖:
 * - constants (3): CACHE_PREFIX / DEFAULT_TTL_SECONDS / MAX_VALUE_SIZE_BYTES
 * - stableHash (5): 长度 / 确定性 / 不同输入 / 中文 / 空字符串
 * - makeCacheKey (5): 格式 / 顺序无关 / type 区分 / namespace 区分 / null 过滤
 * - cacheGet (5): undefined env / 命中 / 未命中 / 解析错 / KV 抛错
 * - cacheSet (5): undefined env / 正常写 / TTL 参数 / oversized / KV 抛错
 * - cacheDelete (3): 正常 / undefined / 抛错
 * - metrics (4): reset / total_requests / hit_rate / 0 请求 hit_rate=0
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CACHE_PREFIX,
  DEFAULT_TTL_SECONDS,
  MAX_VALUE_SIZE_BYTES,
  stableHash,
  makeCacheKey,
  cacheGet,
  cacheSet,
  cacheDelete,
  getCacheMetrics,
  resetCacheMetrics,
} from '../src/cache';

// Mock Env factory (PROCESS_STATE 可选, override by 测试)
function mockEnv(overrides: any = {}): any {
  return {
    PROCESS_STATE: undefined,
    ...overrides,
  };
}

describe('cache · constants', () => {
  it('CACHE_PREFIX = "cache:" (跟 PROCESS_STATE 现有 prefix 隔离)', () => {
    expect(CACHE_PREFIX).toBe('cache:');
  });

  it('DEFAULT_TTL_SECONDS = 1h (3600)', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(60 * 60);
  });

  it('MAX_VALUE_SIZE_BYTES = 25MB (KV hard limit 防御性 cap)', () => {
    expect(MAX_VALUE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('cache · stableHash', () => {
  it('输出 32 字符 hex (固定长度 cache key)', async () => {
    const h = await stableHash('hello');
    expect(h).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(h)).toBe(true);
  });

  it('同输入 → 同 hash (deterministic)', async () => {
    const h1 = await stableHash('hello world');
    const h2 = await stableHash('hello world');
    expect(h1).toBe(h2);
  });

  it('不同输入 → 不同 hash', async () => {
    const h1 = await stableHash('a');
    const h2 = await stableHash('b');
    expect(h1).not.toBe(h2);
  });

  it('中文输入 → 32 字符 hex (UTF-8 多字节也 OK)', async () => {
    const h = await stableHash('中文新闻标题');
    expect(h).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(h)).toBe(true);
  });

  it('空字符串 → 32 字符 hex (不 crash)', async () => {
    const h = await stableHash('');
    expect(h).toHaveLength(32);
  });
});

describe('cache · makeCacheKey', () => {
  it('基础格式: cache:{namespace}:{hash}', async () => {
    const k = await makeCacheKey('pull', { type: 'news' });
    expect(k.startsWith('cache:pull:')).toBe(true);
  });

  it('params key 顺序无关 (排序后 join)', async () => {
    const k1 = await makeCacheKey('pull', { a: 1, b: 2 });
    const k2 = await makeCacheKey('pull', { b: 2, a: 1 });
    expect(k1).toBe(k2);
  });

  it('不同 type → 不同 key (filter 区分)', async () => {
    const k1 = await makeCacheKey('pull', { type: 'news' });
    const k2 = await makeCacheKey('pull', { type: 'topics' });
    expect(k1).not.toBe(k2);
  });

  it('不同 namespace → 不同 key', async () => {
    const k1 = await makeCacheKey('pull', { type: 'news' });
    const k2 = await makeCacheKey('trend', { type: 'news' });
    expect(k1).not.toBe(k2);
  });

  it('null / undefined 过滤 (跟 missing 一致)', async () => {
    const k1 = await makeCacheKey('pull', { a: 1, b: null });
    const k2 = await makeCacheKey('pull', { a: 1 });
    expect(k1).toBe(k2);

    const k3 = await makeCacheKey('pull', { a: 1, b: undefined });
    expect(k3).toBe(k2);
  });
});

describe('cache · cacheGet', () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  it('PROCESS_STATE undefined → 返 null + recordMiss (不抛)', async () => {
    const env = mockEnv();
    const result = await cacheGet(env, 'cache:foo');
    expect(result).toBeNull();
    expect(getCacheMetrics().misses).toBe(1);
  });

  it('命中: KV 有值 + parse 成功 → 返对象 + recordHit', async () => {
    const fakeKV: any = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ x: 1 })),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    const result = await cacheGet(env, 'cache:foo');
    expect(result).toEqual({ x: 1 });
    expect(getCacheMetrics().hits).toBe(1);
  });

  it('未命中: KV 返 null → recordMiss + 返 null', async () => {
    const fakeKV: any = {
      get: vi.fn().mockResolvedValue(null),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    const result = await cacheGet(env, 'cache:foo');
    expect(result).toBeNull();
    expect(getCacheMetrics().misses).toBe(1);
  });

  it('解析错: KV 有值 + parse 失败 → recordMiss + 静默', async () => {
    const fakeKV: any = {
      get: vi.fn().mockResolvedValue('not json'),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    const result = await cacheGet(env, 'cache:foo');
    expect(result).toBeNull();
    expect(getCacheMetrics().misses).toBe(1);
  });

  it('KV.get 抛错 → recordMiss + 静默 (不抛)', async () => {
    const fakeKV: any = {
      get: vi.fn().mockRejectedValue(new Error('KV down')),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    const result = await cacheGet(env, 'cache:foo');
    expect(result).toBeNull();
    expect(getCacheMetrics().misses).toBe(1);
  });
});

describe('cache · cacheSet', () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  it('PROCESS_STATE undefined → recordStoreFailure + 静默', async () => {
    const env = mockEnv();
    await cacheSet(env, 'cache:foo', { x: 1 });
    expect(getCacheMetrics().storeFailures).toBe(1);
  });

  it('正常写: KV.put + recordStore (TTL 默认 1h)', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const fakeKV: any = { put: putSpy };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheSet(env, 'cache:foo', { x: 1 });
    expect(putSpy).toHaveBeenCalledWith('cache:foo', JSON.stringify({ x: 1 }), { expirationTtl: 60 * 60 });
    expect(getCacheMetrics().stores).toBe(1);
  });

  it('TTL 参数生效 (自定义 TTL)', async () => {
    const putSpy = vi.fn().mockResolvedValue(undefined);
    const fakeKV: any = { put: putSpy };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheSet(env, 'cache:foo', { x: 1 }, 300);
    expect(putSpy).toHaveBeenCalledWith('cache:foo', JSON.stringify({ x: 1 }), { expirationTtl: 300 });
  });

  it('oversized (>25MB) 拒绝 → recordStoreFailure + 不调 KV.put', async () => {
    const putSpy = vi.fn();
    const fakeKV: any = { put: putSpy };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    const huge = 'x'.repeat(26 * 1024 * 1024); // 26MB string
    await cacheSet(env, 'cache:foo', huge);
    expect(putSpy).not.toHaveBeenCalled();
    expect(getCacheMetrics().storeFailures).toBe(1);
  });

  it('KV.put 抛错 → recordStoreFailure + 静默 (不抛)', async () => {
    const fakeKV: any = {
      put: vi.fn().mockRejectedValue(new Error('KV put failed')),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheSet(env, 'cache:foo', { x: 1 });
    expect(getCacheMetrics().storeFailures).toBe(1);
  });
});

describe('cache · cacheDelete', () => {
  it('正常 delete (静默成功)', async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const fakeKV: any = { delete: deleteSpy };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheDelete(env, 'cache:foo');
    expect(deleteSpy).toHaveBeenCalledWith('cache:foo');
  });

  it('PROCESS_STATE undefined → 静默 no-op (不抛)', async () => {
    const env = mockEnv();
    await cacheDelete(env, 'cache:foo');
  });

  it('KV.delete 抛错 → 静默 (不抛)', async () => {
    const fakeKV: any = {
      delete: vi.fn().mockRejectedValue(new Error('KV delete failed')),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheDelete(env, 'cache:foo');
  });
});

describe('cache · metrics', () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  it('reset 后: 全部 0, hit_rate = 0', () => {
    const m = getCacheMetrics();
    expect(m).toEqual({ hits: 0, misses: 0, stores: 0, storeFailures: 0, total_requests: 0, hit_rate: 0 });
  });

  it('total_requests = hits + misses (派生字段自动算)', async () => {
    const fakeKV: any = {
      get: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({ a: 1 }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ b: 2 })),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheGet(env, 'k1');
    await cacheGet(env, 'k2');
    await cacheGet(env, 'k3');
    const m = getCacheMetrics();
    expect(m.total_requests).toBe(3);
    expect(m.hits).toBe(2);
    expect(m.misses).toBe(1);
  });

  it('hit_rate = hits / (hits + misses)', async () => {
    const fakeKV: any = {
      get: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({ a: 1 }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ b: 2 })),
    };
    const env = mockEnv({ PROCESS_STATE: fakeKV });
    await cacheGet(env, 'k1');
    await cacheGet(env, 'k2');
    await cacheGet(env, 'k3');
    const m = getCacheMetrics();
    expect(m.hit_rate).toBeCloseTo(2 / 3, 2);
  });

  it('0 请求时 hit_rate = 0 (不 NaN)', () => {
    const m = getCacheMetrics();
    expect(m.hit_rate).toBe(0);
    expect(Number.isNaN(m.hit_rate)).toBe(false);
  });
});
