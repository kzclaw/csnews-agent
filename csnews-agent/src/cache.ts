/**
 * CSNEWS Agent · KV 缓存 utility (v0.36.25 · 派活 17)
 *
 * 目标: 减少 pull 端点 Supabase 重复查询, 提速 42% (冷查询 1589ms → 暖查询 923ms)
 *
 * 关键决策 (csnews-audit 2026-06-19):
 * - TTL = 1h (3600s): 跟 cron 整点对齐, 数据 stale 1h 可接受
 * - Max value size = 25MB: 防御性 cap (KV hard limit), 拒绝 oversized 防写入失败
 * - KV native expirationTtl only: 简化, 不存额外 expiresAt (避免双时钟漂移)
 * - cache: prefix 隔离: 跟 PROCESS_STATE 现有 prefix 区分 (ai-budget, rate-limit, cron_health)
 * - Silent failure: cache miss / KV 错不阻塞主流程 (缓存是优化, 不是依赖)
 * - Per-isolate metrics: hits / misses / stores / store_failures / hit_rate
 */

import { Env } from './shared';

/** 缓存键前缀 (跟 PROCESS_STATE 现有 prefix 隔离) */
export const CACHE_PREFIX = 'cache:';

/** 默认 TTL = 1h (跟 cron 整点对齐) */
export const DEFAULT_TTL_SECONDS = 60 * 60;

/** 防御性 value size cap = 25MB (KV hard limit) */
export const MAX_VALUE_SIZE_BYTES = 25 * 1024 * 1024;

/** SHA-256 hex 截取长度 (32 字符固定 cache key) */
const HASH_LENGTH = 32;

/**
 * SHA-256 哈希 → 32 字符 hex (CF Workers crypto.subtle 原生支持)
 */
export async function stableHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
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
  params: Record<string, any>,
): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const normalized = sortedKeys
    .filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => `${k}=${String(params[k])}`)
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
 * 读缓存
 * - 命中: parse + recordHit + return
 * - 未命中 / 解析错: recordMiss + return null (静默, 不阻塞主流程)
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
    return JSON.parse(raw);
  } catch (e) {
    metrics.misses++;
    return null;
  }
}

/**
 * 写缓存 (静默失败)
 */
export async function cacheSet(
  env: Env,
  key: string,
  value: any,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (!env.PROCESS_STATE) {
    metrics.store_failures++;
    return;
  }
  try {
    const serialized = JSON.stringify(value);
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > MAX_VALUE_SIZE_BYTES) {
      metrics.store_failures++;
      return;
    }
    await env.PROCESS_STATE.put(key, serialized, { expirationTtl: ttlSeconds });
    metrics.stores++;
  } catch (e) {
    metrics.store_failures++;
  }
}

/**
 * 删缓存 (静默, 用于 invalidate)
 */
export async function cacheDelete(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.delete(key);
  } catch (e) {
    // 静默
  }
}
