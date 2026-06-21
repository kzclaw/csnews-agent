/**
 * CSNEWS Agent · knowledge 端点输入校验（v0.36.7 · 模块化）
 *
 * 唯一目标：守住"knowledge 端点输入校验规则就是这样"（业务契约）
 *
 * 业务红线：
 *   - type 必须是 daily / topic 二选一 (白名单)
 *     - daily = 拉所有 topic 累积的 knowledge index 列表 (按 created_at desc, 早晨日报入口)
 *     - topic = 拉单个 topic_id 的所有 knowledge 记录 (按 created_at desc)
 *   - since 必须是 ISO 8601 时间或相对时间 (24h / 7d / 30m) (跟 trend 同款)
 *   - limit 1-200 (上限 200) (跟 trend 同款)
 *   - topic_id 必须是 UUID 格式 (仅 type=topic 时必填)
 *   - 反爬限流 KV key 格式: knowledge_rate:<ip> (跟 trend 同模式, 独立前缀)
 *   - 监控 KV key 格式: r2_knowledge_hits:YYYY-MM-DD
 *
 * 加新 type 时: ALLOWED_TYPES 加 + 此文件 describe 块补 1 个 it
 */

// ISO 8601 时间 regex (跟 trend 同款, 简化版)
export const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// UUID v4 regex (Postgres gen_random_uuid() 默认 v4)
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALLOWED_TYPES = ['daily', 'topic'] as const;
export type KnowledgeType = typeof ALLOWED_TYPES[number];

// 相对时间 regex: 24h / 7d / 30m (跟 trend 同款)
export const RELATIVE_TIME_REGEX = /^(\d+)([mhd])$/;

export const RATE_LIMIT_PER_MIN = 60;
export const RATE_KEY_PREFIX = 'knowledge_rate:';
export const KNOWLEDGE_HITS_KEY_PREFIX = 'r2_knowledge_hits:';

export const PAYLOAD_LIMIT_BYTES = 1024 * 1024; // 1 MB (跟 trend 同款)
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
    return { ok: false, error: 'missing_type', reason: 'type 不能为空, 合法值: daily/topic' };
  }
  const normalized = type.toLowerCase();
  if (!ALLOWED_TYPES.includes(normalized as KnowledgeType)) {
    return {
      ok: false,
      error: 'invalid_type',
      reason: `type 必须是 ${ALLOWED_TYPES.join('/')} 二选一`,
    };
  }
  return { ok: true, reason: normalized };
}

/**
 * 校验 since 参数 (ISO 8601 / 相对时间 / 默认 24h) (跟 trend 同款)
 */
export function validateSince(since: string | null): { ok: boolean; since?: string; error?: string; reason?: string } {
  if (!since) {
    return { ok: true, since: resolveRelativeTime('24h')! }; // 默认 24h (早晨日报默认看 24h)
  }
  const relative = resolveRelativeTime(since);
  if (relative) return { ok: true, since: relative };
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
 * 校验 limit 参数 (1-200, 默认 20) (跟 trend 同款)
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
 * 校验 topic_id 参数 (UUID 格式, 仅 type=topic 时必填)
 */
export function validateTopicId(topicId: string | null, type: string | null): { ok: boolean; topicId?: string; error?: string; reason?: string } {
  if (type === 'topic') {
    if (!topicId) {
      return { ok: false, error: 'missing_topic_id', reason: 'type=topic 时 topic_id 必填' };
    }
    if (!UUID_REGEX.test(topicId)) {
      return { ok: false, error: 'invalid_topic_id', reason: `topic_id 必须是 UUID 格式, 实际: ${topicId}` };
    }
    return { ok: true, topicId: topicId.toLowerCase() };
  }
  // type=daily 时 topic_id 可选
  return { ok: true, topicId: topicId ? topicId.toLowerCase() : undefined };
}

/**
 * 构造 rate limit Redis-style key (跟 trend 同模式, 独立前缀)
 */
export function rateKeyForIp(ip: string): string {
  return `${RATE_KEY_PREFIX}${ip || 'unknown'}`;
}

/**
 * 构造每日命中计数 key (YYYY-MM-DD) (跟 trend 同模式, 独立前缀)
 */
export function dailyHitsKeyForToday(date: Date = new Date()): string {
  return `${KNOWLEDGE_HITS_KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
}

/**
 * 构造 R2 knowledge 路径: knowledge/yyyymm/<topic_id>-<ts>.md
 * 早晨日报金句 Markdown 模板路径
 */
export function knowledgeR2Key(topicId: string, ts: Date = new Date()): string {
  const yyyymm = ts.toISOString().slice(0, 7).replace('-', ''); // 202606
  const tsStr = ts.toISOString().replace(/[:.]/g, '-');
  return `knowledge/${yyyymm}/${topicId}-${tsStr}.md`;
}

/**
 * 构造 R2 knowledge index 路径: knowledge/_index.json
 * 早晨日报入口 = 单 GET 拿全部 knowledge 索引
 */
export const KNOWLEDGE_INDEX_KEY = 'knowledge/_index.json';
