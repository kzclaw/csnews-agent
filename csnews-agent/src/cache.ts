/**
 * CSNEWS Agent · KV 缓存 utility
 *
 * - TTL = 1h (3600s): 跟 cron 整点对齐
 * - Max value size = 25MB: 防御性 cap (KV hard limit)
 * - Silent failure: cache miss / KV 错不阻塞主流程
 * - Seed Envelope: 所有 KV 缓存数据统一包装 _seed 元数据包, 用于 health 判断新鲜度
 */

import { Env } from './shared';

/** Seed Envelope 元数据包 (用于 health 端点判断数据新鲜度) */
export type SeedMeta = {
  fetchedAt: string;
  recordCount: number;
  state: 'ok' | 'error' | 'empty';
  maxContentAgeMin: number;
};

/** 提取 _seed 元数据 (无 _seed 返回 null) */
export function getSeedMeta(value: any): SeedMeta | null {
  if (value?._seed?.fetchedAt !== undefined && value?.data !== undefined) {
    return value._seed as SeedMeta;
  }
  return null;
}

/** 缓存键前缀 (跟 PROCESS_STATE 现有 prefix 隔离) */
export const CACHE_PREFIX = 'cache:';

/** Negative Sentinel key 前缀 (标记上游故障, 30s 内跳过重试) */
const NEG_SENTINEL_PREFIX = '__CSNEWS_NEG__';

/** Negative Sentinel TTL = 30s (上游故障时保护 AI budget) */
const NEG_SENTINEL_TTL = 30;

/** 默认 TTL = 1h (跟 cron 整点对齐) */
const DEFAULT_TTL_SECONDS = 60 * 60;

/** Pull 端点 TTL = 60s (热点数据快速失效，减少 stale) */
export const PULL_TTL_SECONDS = 60;

/** 防御性 value size cap = 25MB (KV hard limit) */
const MAX_VALUE_SIZE_BYTES = 25 * 1024 * 1024;

/** SHA-256 hex 截取长度 (32 字符固定 cache key) */
const HASH_LENGTH = 32;

/**
 * SHA-256 哈希 → 32 字符 hex (CF Workers crypto.subtle 原生支持)
 */
export async function stableHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_LENGTH);
}

/**
 * 构造 cache key
 * - 格式: cache:{namespace}:{hash}
 * - params key 排序后 join, 顺序无关
 * - null / undefined 过滤
 */
export async function makeCacheKey(
  namespace: string,
  params: Record<string, any>
): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const normalized = sortedKeys
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  const hash = await stableHash(normalized);
  return `${CACHE_PREFIX}${namespace}:${hash}`;
}

/** Module-level metrics (per-isolate 独立 V8) */
export interface CacheMetrics {
  hits: number;
  misses: number;
  stores: number;
  store_failures: number;
  total_requests: number;
  hit_rate: number;
}

let metrics: CacheMetrics = {
  hits: 0,
  misses: 0,
  stores: 0,
  store_failures: 0,
  total_requests: 0,
  hit_rate: 0,
};

export function getCacheMetrics(): CacheMetrics {
  const total = metrics.hits + metrics.misses;
  return {
    ...metrics,
    total_requests: total,
    hit_rate: total > 0 ? metrics.hits / total : 0,
  };
}

export function resetCacheMetrics(): void {
  metrics = { hits: 0, misses: 0, stores: 0, store_failures: 0, total_requests: 0, hit_rate: 0 };
}

/**
 * 读缓存 — 命中 unwrap SeedEnvelope, 未命中/错返回 null (静默)
 * 向后兼容: 无 _seed 字段返回原数据 (v0.36.25 之前裸数据)
 */
export async function cacheGet(env: Env, key: string): Promise<any | null> {
  if (!env.PROCESS_STATE) {
    metrics.misses++;
    return null;
  }
  try {
    const raw = await env.PROCESS_STATE.get(key);
    if (!raw) {
      metrics.misses++;
      return null;
    }
    metrics.hits++;
    const parsed = JSON.parse(raw);
    return parsed?._seed?.fetchedAt !== undefined ? parsed.data : parsed;
  } catch {
    metrics.misses++;
    return null;
  }
}

/** 写缓存 — 有 recordCount 时自动包装 SeedEnvelope, 无 recordCount 时写裸数据 */
export async function cacheSet(
  env: Env,
  key: string,
  value: any,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  opts?: { recordCount?: number; maxContentAgeMin?: number }
): Promise<void> {
  if (!env.PROCESS_STATE) {
    metrics.store_failures++;
    return;
  }
  try {
    const toStore =
      opts?.recordCount !== undefined
        ? {
            _seed: {
              fetchedAt: new Date().toISOString(),
              recordCount: opts.recordCount,
              state: 'ok' as const,
              maxContentAgeMin: opts.maxContentAgeMin ?? -1,
            },
            data: value,
          }
        : value;
    const serialized = JSON.stringify(toStore);
    if (new TextEncoder().encode(serialized).length > MAX_VALUE_SIZE_BYTES) {
      metrics.store_failures++;
      return;
    }
    await env.PROCESS_STATE.put(key, serialized, { expirationTtl: ttlSeconds });
    metrics.stores++;
  } catch {
    metrics.store_failures++;
  }
}

/** 删缓存 (静默) */
export async function cacheDelete(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.delete(key);
  } catch {}
}

// ============================================================
// Negative Sentinel
// ============================================================

/** 检查是否有 Negative Sentinel (上游故障标记) */
export async function isNegativeSentinel(env: Env, key: string): Promise<boolean> {
  if (!env.PROCESS_STATE) return false;
  try {
    return (await env.PROCESS_STATE.get(`${NEG_SENTINEL_PREFIX}${key}`)) !== null;
  } catch {
    return false;
  }
}

/** 写入 Negative Sentinel (30s 跳过重试, 保护 AI budget) */
export async function setNegativeSentinel(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.put(`${NEG_SENTINEL_PREFIX}${key}`, '1', {
      expirationTtl: NEG_SENTINEL_TTL,
    });
  } catch {}
}

/** 清除 Negative Sentinel (fetch 成功时调用) */
export async function clearNegativeSentinel(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.delete(`${NEG_SENTINEL_PREFIX}${key}`);
  } catch {}
}

/** 统计当前生效的 Negative Sentinel 数量 */
export async function countNegativeSentinels(env: Env): Promise<number> {
  if (!env.PROCESS_STATE) return 0;
  try {
    return (await env.PROCESS_STATE.list({ prefix: NEG_SENTINEL_PREFIX })).keys?.length ?? 0;
  } catch {
    return 0;
  }
}
