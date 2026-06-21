/**
 * CSNEWS Agent · trend 端点输入校验（v0.36.7 · 模块化）
 *
 * 唯一目标：守住"trend 端点输入校验规则就是这样"（业务契约）
 *
 * 业务红线：
 *   - type 必须是 topics / velocity / acceleration 三选一 (白名单)
 *   - since 必须是 ISO 8601 时间或相对时间 (24h / 7d / 30m)
 *   - limit 1-200 (上限 200)
 *   - 反爬限流 KV key 格式: trend_rate:<ip> (独立前缀)
 *   - 监控 KV key 格式: r2_trend_hits:YYYY-MM-DD
 *
 * 加新 type 时: ALLOWED_TYPES 加 + 此文件 describe 块补 1 个 it
 *

 */

// ISO 8601 时间 regex (简化版, 接受 2026-06-16 / 2026-06-16T10:00:00Z / 2026-06-16T10:00:00+08:00)
export const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const ALLOWED_TYPES = ['topics', 'velocity', 'acceleration'] as const;
export type TrendType = typeof ALLOWED_TYPES[number];

// 相对时间 regex: 24h / 7d / 30m
export const RELATIVE_TIME_REGEX = /^(\d+)([mhd])$/;

export const RATE_LIMIT_PER_MIN = 60;
export const RATE_KEY_PREFIX = 'trend_rate:';
export const TREND_HITS_KEY_PREFIX = 'r2_trend_hits:';

export const PAYLOAD_LIMIT_BYTES = 1024 * 1024; // 1 MB
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const DEFAULT_LIMIT = 20;

export interface ValidationResult {
  ok: boolean;
  error?: string;
  reason?: string;
}

/**
 * 解析相对时间 (24h / 7d / 30m) 为 ISO 8601
 */
export function resolveRelativeTime(rel: string): string | null {
  const m = RELATIVE_TIME_REGEX.exec(rel);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const now = Date.now();
  const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
  return new Date(now - ms).toISOString();
}

/**
 * 校验 type 是否在白名单内
 */
export function validateType(type: string | null): ValidationResult {
  if (!type || typeof type !== 'string') {
    return { ok: false, error: 'missing_type', reason: 'type 不能为空, 合法值: topics/velocity/acceleration' };
  }
  const normalized = type.toLowerCase();
  if (!ALLOWED_TYPES.includes(normalized as TrendType)) {
    return {
      ok: false,
      error: 'invalid_type',
      reason: `type 必须是 ${ALLOWED_TYPES.join('/')} 三选一`,
    };
  }
  return { ok: true, reason: normalized };
}

/**
 * 校验 since 参数 (ISO 8601 / 相对时间 / 默认 24h)
 */
export function validateSince(since: string | null): { ok: boolean; since?: string; error?: string; reason?: string } {
  if (!since) {
    return { ok: true, since: resolveRelativeTime('24h')! }; // 默认 24h
  }
  // 相对时间 (24h / 7d / 30m)
  const relative = resolveRelativeTime(since);
  if (relative) return { ok: true, since: relative };
  // ISO 8601
  if (ISO8601_REGEX.test(since)) {
    const d = new Date(since);
    if (isNaN(d.getTime())) {
      return { ok: false, error: 'invalid_since', reason: `since 不是有效时间: ${since}` };
    }
    return { ok: true, since: d.toISOString() };
  }
  return { ok: false, error: 'invalid_since', reason: `since 必须是 ISO 8601 或相对时间 (e.g. 24h / 7d / 30m), 实际: ${since}` };
}

/**
 * 校验 limit 参数 (1-200, 默认 20)
 */
export function validateLimit(limit: string | null): { ok: boolean; limit: number; error?: string; reason?: string } {
  if (!limit) return { ok: true, limit: DEFAULT_LIMIT };
  const n = parseInt(limit, 10);
  if (isNaN(n)) {
    return { ok: false, limit: DEFAULT_LIMIT, error: 'invalid_limit', reason: `limit 必须是整数, 实际: ${limit}` };
  }
  if (n < LIMIT_MIN || n > LIMIT_MAX) {
    return { ok: false, limit: DEFAULT_LIMIT, error: 'invalid_limit', reason: `limit 必须在 ${LIMIT_MIN}-${LIMIT_MAX} 之间, 实际: ${n}` };
  }
  return { ok: true, limit: n };
}

/**
 * 构造 rate limit Redis-style key
 */
export function rateKeyForIp(ip: string): string {
  return `${RATE_KEY_PREFIX}${ip || 'unknown'}`;
}

/**
 * 构造每日命中计数 key (YYYY-MM-DD)
 */
export function dailyHitsKeyForToday(date: Date = new Date()): string {
  return `${TREND_HITS_KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
}
