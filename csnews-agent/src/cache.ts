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
 * - Seed Envelope (v0.36.x): 所有 KV 缓存数据统一包装 _seed 元数据包, 用于 health 判断新鲜度
 */

import { Env } from './shared';

/**
 * Seed Envelope — 所有 KV 缓存数据的统一元数据包
 * 用于 health 端点判断数据新鲜度, 支持区分"news 表有数据但 trends 表空了"等局部故障
 */
export interface SeedEnvelope<T> {
  _seed: {
    /** ISO 8601 时间戳, 本次写入时间 */
    fetchedAt: string;
    /** 本次写入的记录数 */
    recordCount: number;
    /** 数据状态 */
    state: 'ok' | 'error' | 'empty';
    /**
     * 内容最大年龄(分钟), 用于 health 判断新鲜度
     * - pull 缓存: fetchedAt 到 items 中最新内容的年龄
     * - last_process_at: fetchedAt 的年龄
     * - 原子计数器(rate-limit/ai-budget): -1 (不参与 freshness 检查)
     */
    maxContentAgeMin: number;
  };
  /** 原有数据 */
  data: T;
}

/**
 * 构造 Seed Envelope (内部用)
 */
function buildSeedEnvelope<T>(
  data: T,
  recordCount: number,
  state: SeedEnvelope<T>['_seed']['state'],
  maxContentAgeMin: number
): SeedEnvelope<T> {
  return {
    _seed: {
      fetchedAt: new Date().toISOString(),
      recordCount,
      state,
      maxContentAgeMin,
    },
    data,
  };
}

/**
 * 尝试从 Seed Envelope 提取 data (向后兼容旧数据)
 * - 有 _seed 字段 → 返回 data
 * - 无 _seed 字段 → 返回原数据 (兼容 v0.36.25 之前的裸数据)
 */
function unwrapSeedEnvelope<T>(value: any): T {
  if (value && typeof value === 'object' && '_seed' in value && 'data' in value) {
    return value.data as T;
  }
  return value as T;
}

/**
 * 从 Seed Envelope 提取 _seed 元数据 (无 _seed 返回 null)
 */
export function getSeedMeta(value: any): SeedEnvelope<unknown>['_seed'] | null {
  if (value && typeof value === 'object' && '_seed' in value && 'data' in value) {
    return value._seed as SeedEnvelope<unknown>['_seed'];
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
 * 读缓存
 * - 命中: parse + unwrap SeedEnvelope + recordHit + return
 * - 未命中 / 解析错: recordMiss + return null (静默, 不阻塞主流程)
 * - 向后兼容: 无 _seed 字段返回原数据 (v0.36.25 之前裸数据)
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
    return unwrapSeedEnvelope(parsed);
  } catch (e) {
    metrics.misses++;
    return null;
  }
}

/**
 * 写缓存 (静默失败)
 * - 有 recordCount 时自动包装 SeedEnvelope
 * - 无 recordCount 时写裸数据 (rate-limit 等原子计数器场景)
 */
export async function cacheSet(
  env: Env,
  key: string,
  value: any,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  opts?: {
    /** 本次写入的记录数 (pull 缓存场景) */
    recordCount?: number;
    /** 内容最大年龄(分钟), 用于 health freshness 判断 */
    maxContentAgeMin?: number;
  }
): Promise<void> {
  if (!env.PROCESS_STATE) {
    metrics.store_failures++;
    return;
  }
  try {
    const toStore =
      opts?.recordCount !== undefined
        ? buildSeedEnvelope(value, opts.recordCount, 'ok', opts.maxContentAgeMin ?? -1)
        : value;
    const serialized = JSON.stringify(toStore);
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

// ============================================================
// Negative Sentinel
// ============================================================

/**
 * Negative Sentinel key 构造
 * 格式: __CSNEWS_NEG__<original_key>
 */
function negSentinelKey(key: string): string {
  return `${NEG_SENTINEL_PREFIX}${key}`;
}

/**
 * 检查是否有 Negative Sentinel (上游故障标记)
 * - 有 sentinel → 返回 true (跳过重试)
 * - 无 sentinel / 错 → 返回 false (正常 fetch)
 */
export async function isNegativeSentinel(env: Env, key: string): Promise<boolean> {
  if (!env.PROCESS_STATE) return false;
  try {
    const value = await env.PROCESS_STATE.get(negSentinelKey(key));
    return value !== null;
  } catch {
    return false;
  }
}

/**
 * 写入 Negative Sentinel (上游故障时调用)
 * 30s 内相同 key 的 fetch 会被跳过, 保护 AI budget
 */
export async function setNegativeSentinel(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.put(negSentinelKey(key), '1', {
      expirationTtl: NEG_SENTINEL_TTL,
    });
  } catch {
    // 静默
  }
}

/**
 * 清除 Negative Sentinel (fetch 成功时调用)
 * 成功获取数据后清理标记, 允许下次正常 fetch
 */
export async function clearNegativeSentinel(env: Env, key: string): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    await env.PROCESS_STATE.delete(negSentinelKey(key));
  } catch {
    // 静默
  }
}

/**
 * 统计当前生效的 Negative Sentinel 数量
 * 用于 health 端点 neg_sentinel_count 指标
 */
export async function countNegativeSentinels(env: Env): Promise<number> {
  if (!env.PROCESS_STATE) return 0;
  try {
    const list = await env.PROCESS_STATE.list({ prefix: NEG_SENTINEL_PREFIX });
    return list.keys?.length ?? 0;
  } catch {
    return 0;
  }
}
