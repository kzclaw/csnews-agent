/**
 * CSNEWS Agent · content 端点输入校验（v0.36.6 · 模块化）
 *
 * 唯一目标：守住"content 端点输入校验规则就是这样"（业务契约）
 *
 * 业务红线：
 *   - id 必须是 UUID v4 格式 (RFC 4122 简化版, 接受 v1-5)
 *   - format 必须是 text / html / json 三选一 (白名单)
 *   - rate limit key 格式: content_rate:<ip>
 *
 * 加新 format 时: 在 ALLOWED_FORMATS 加 + 此文件 describe 块补 1 个 it
 */

// UUID v4 regex (RFC 4122 简化版, 接受 v1-5 因为 Supabase uuid-ossp / pgcrypto 都可能生成)
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_FORMATS = ['text', 'html', 'json'] as const;
type ContentFormat = (typeof ALLOWED_FORMATS)[number];

export const RATE_LIMIT_PER_MIN = 60;
export const RATE_KEY_PREFIX = 'content_rate:';
const CONTENT_HITS_KEY_PREFIX = 'r2_content_hits:';

export const PAYLOAD_LIMIT_BYTES = 1024 * 1024; // 1 MB

export interface ValidationResult {
  ok: boolean;
  error?: string;
  reason?: string;
}

/**
 * 校验 id 是否为 UUID 格式
 */
export function validateId(id: string): ValidationResult {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'invalid_id', reason: 'id 不能为空' };
  }
  if (!UUID_REGEX.test(id)) {
    return {
      ok: false,
      error: 'invalid_id',
      reason: 'id 必须是 UUID 格式 (e.g. 550e8400-e29b-41d4-a716-446655440000)',
    };
  }
  return { ok: true };
}

/**
 * 校验 format 是否在白名单内
 */
export function validateFormat(format: string): ValidationResult {
  if (!format || typeof format !== 'string') {
    return { ok: false, error: 'invalid_format', reason: 'format 不能为空, 默认为 json' };
  }
  const normalized = format.toLowerCase();
  if (!ALLOWED_FORMATS.includes(normalized as ContentFormat)) {
    return {
      ok: false,
      error: 'invalid_format',
      reason: `format 必须是 ${ALLOWED_FORMATS.join('/')} 三选一`,
    };
  }
  return { ok: true };
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
  return `${CONTENT_HITS_KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
}

/**
 * HTML escape helper (避免 XSS)
 */
export function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}
