/**
 * CSNEWS Agent · knowledge 端点业务红线契约（v0.36.7 · KR0 · v0.33+sweep·FT-KR0 续）
 *
 * 唯一目标：守住"knowledge 端点 API 契约就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - validateType: daily/topic 二选一白名单
 *   - validateSince: ISO 8601 / 相对时间 (24h/7d/30m) / 默认 24h
 *   - validateLimit: 1-200 整数 / 默认 20
 *   - validateTopicId: UUID 格式 / type=topic 必填 / type=daily 可选
 *   - resolveRelativeTime: 24h/7d/30m 解析
 *   - rateKeyForIp: KV key 格式 knowledge_rate:<ip>
 *   - dailyHitsKeyForToday: KV key 格式 r2_knowledge_hits:YYYY-MM-DD
 *   - knowledgeR2Key: R2 路径 knowledge/yyyymm/<topic_id>-<ts>.md
 *   - KNOWLEDGE_INDEX_KEY: knowledge/_index.json
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */
import { describe, it, expect } from 'vitest';
import {
  validateType, validateSince, validateLimit, validateTopicId,
  resolveRelativeTime, rateKeyForIp, dailyHitsKeyForToday,
  knowledgeR2Key, KNOWLEDGE_INDEX_KEY,
  ISO8601_REGEX, UUID_REGEX, ALLOWED_TYPES, RELATIVE_TIME_REGEX,
  RATE_LIMIT_PER_MIN, PAYLOAD_LIMIT_BYTES, RATE_KEY_PREFIX, KNOWLEDGE_HITS_KEY_PREFIX,
  LIMIT_MIN, LIMIT_MAX, DEFAULT_LIMIT,
} from '../src/knowledge-validation';

// ============================================================
// resolveRelativeTime
// ============================================================
describe('resolveRelativeTime · 相对时间解析', () => {
  it('24h 必须返 24 小时前 ISO 8601', () => {
    const result = resolveRelativeTime('24h');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t = Date.parse(result!);
    const expected = Date.now() - 24 * 3600 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000);
  });

  it('7d 必须返 7 天前', () => {
    const result = resolveRelativeTime('7d');
    const t = Date.parse(result!);
    const expected = Date.now() - 7 * 86400 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000);
  });

  it('30m 必须返 30 分钟前', () => {
    const result = resolveRelativeTime('30m');
    const t = Date.parse(result!);
    const expected = Date.now() - 30 * 60 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000);
  });

  it('1h 必须返 1 小时前', () => {
    const result = resolveRelativeTime('1h');
    expect(result).toBeTruthy();
  });

  it('非法格式 (hello) 必须返 null', () => {
    expect(resolveRelativeTime('hello')).toBe(null);
  });
});

// ============================================================
// validateType
// ============================================================
describe('validateType · type 白名单', () => {
  it('daily 合法', () => {
    const r = validateType('daily');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('daily');
  });

  it('topic 合法', () => {
    const r = validateType('topic');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('topic');
  });

  it('大小写不敏感 DAILY → daily', () => {
    const r = validateType('DAILY');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('daily');
  });

  it('null 必须返 missing_type', () => {
    const r = validateType(null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_type');
  });

  it('空字符串必须返 missing_type', () => {
    const r = validateType('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_type');
  });

  it('非法值 (foo) 必须返 invalid_type', () => {
    const r = validateType('foo');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_type');
  });

  it('ALLOWED_TYPES 必须含 daily + topic 二值', () => {
    expect(ALLOWED_TYPES).toEqual(['daily', 'topic']);
  });
});

// ============================================================
// validateSince
// ============================================================
describe('validateSince · since 参数校验', () => {
  it('null 默认 24h 前', () => {
    const r = validateSince(null);
    expect(r.ok).toBe(true);
    expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('24h 相对时间合法', () => {
    const r = validateSince('24h');
    expect(r.ok).toBe(true);
    expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('7d 相对时间合法', () => {
    const r = validateSince('7d');
    expect(r.ok).toBe(true);
  });

  it('ISO 8601 完整格式合法 (2026-06-16T10:00:00Z)', () => {
    const r = validateSince('2026-06-16T10:00:00Z');
    expect(r.ok).toBe(true);
    expect(r.since).toBe('2026-06-16T10:00:00.000Z');
  });

  it('ISO 8601 简化格式合法 (2026-06-16)', () => {
    const r = validateSince('2026-06-16');
    expect(r.ok).toBe(true);
  });

  it('非法 since (hello) 必须返 invalid_since', () => {
    const r = validateSince('hello');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_since');
  });

  it('ISO8601_REGEX 匹配 2026-06-16', () => {
    expect(ISO8601_REGEX.test('2026-06-16')).toBe(true);
  });

  it('ISO8601_REGEX 匹配 2026-06-16T10:00:00Z', () => {
    expect(ISO8601_REGEX.test('2026-06-16T10:00:00Z')).toBe(true);
  });

  it('ISO8601_REGEX 不匹配 2026/06/16', () => {
    expect(ISO8601_REGEX.test('2026/06/16')).toBe(false);
  });
});

// ============================================================
// validateLimit
// ============================================================
describe('validateLimit · limit 参数校验', () => {
  it('null 默认 20', () => {
    const r = validateLimit(null);
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(DEFAULT_LIMIT);
  });

  it('1 必须合法', () => {
    const r = validateLimit('1');
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(1);
  });

  it('200 必须合法', () => {
    const r = validateLimit('200');
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(200);
  });

  it('0 必须返 invalid_limit', () => {
    const r = validateLimit('0');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_limit');
  });

  it('201 必须返 invalid_limit', () => {
    const r = validateLimit('201');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_limit');
  });

  it('非整数 (abc) 必须返 invalid_limit', () => {
    const r = validateLimit('abc');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_limit');
  });

  it('边界常量必须正确', () => {
    expect(LIMIT_MIN).toBe(1);
    expect(LIMIT_MAX).toBe(200);
    expect(DEFAULT_LIMIT).toBe(20);
  });
});

// ============================================================
// validateTopicId
// ============================================================
describe('validateTopicId · topic_id UUID 校验', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const invalidUuid = 'not-a-uuid';

  it('type=topic + 合法 UUID 必须通过', () => {
    const r = validateTopicId(validUuid, 'topic');
    expect(r.ok).toBe(true);
    expect(r.topicId).toBe(validUuid.toLowerCase());
  });

  it('type=topic + null 必须返 missing_topic_id', () => {
    const r = validateTopicId(null, 'topic');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_topic_id');
  });

  it('type=topic + 非法 UUID 必须返 invalid_topic_id', () => {
    const r = validateTopicId(invalidUuid, 'topic');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_topic_id');
  });

  it('type=daily + null topic_id 必须通过 (type=daily 可选)', () => {
    const r = validateTopicId(null, 'daily');
    expect(r.ok).toBe(true);
    expect(r.topicId).toBe(undefined);
  });

  it('type=daily + 合法 UUID 必须通过', () => {
    const r = validateTopicId(validUuid, 'daily');
    expect(r.ok).toBe(true);
    expect(r.topicId).toBe(validUuid.toLowerCase());
  });

  it('UUID 大写自动转小写', () => {
    const r = validateTopicId(validUuid.toUpperCase(), 'topic');
    expect(r.ok).toBe(true);
    expect(r.topicId).toBe(validUuid.toLowerCase());
  });

  it('UUID_REGEX 匹配合法 UUID', () => {
    expect(UUID_REGEX.test(validUuid)).toBe(true);
  });

  it('UUID_REGEX 不匹配非 UUID', () => {
    expect(UUID_REGEX.test(invalidUuid)).toBe(false);
  });
});

// ============================================================
// rateKeyForIp / dailyHitsKeyForToday
// ============================================================
describe('rateKeyForIp · KV rate limit key 格式', () => {
  it('合法 IP 必须返 knowledge_rate:<ip>', () => {
    expect(rateKeyForIp('1.2.3.4')).toBe('knowledge_rate:1.2.3.4');
  });

  it('空 IP 必须返 knowledge_rate:unknown', () => {
    expect(rateKeyForIp('')).toBe('knowledge_rate:unknown');
  });
});

describe('dailyHitsKeyForToday · KV daily hits key 格式', () => {
  it('2026-06-16 必须返 r2_knowledge_hits:2026-06-16', () => {
    const d = new Date('2026-06-16T10:00:00Z');
    expect(dailyHitsKeyForToday(d)).toBe('r2_knowledge_hits:2026-06-16');
  });

  it('默认 today 必须返 today YYYY-MM-DD', () => {
    const key = dailyHitsKeyForToday();
    expect(key).toMatch(/^r2_knowledge_hits:\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================
// knowledgeR2Key / KNOWLEDGE_INDEX_KEY
// ============================================================
describe('knowledgeR2Key · R2 路径生成', () => {
  it('标准 topic_id + ts 必须返 knowledge/yyyymm/<topic_id>-<ts>.md', () => {
    const topicId = '550e8400-e29b-41d4-a716-446655440000';
    const ts = new Date('2026-06-16T10:00:00Z');
    const key = knowledgeR2Key(topicId, ts);
    expect(key).toMatch(/^knowledge\/202606\/550e8400-e29b-41d4-a716-446655440000-/);
    expect(key.endsWith('.md')).toBe(true);
  });

  it('默认 ts 必须返 knowledge/yyyymm/.../...md 格式', () => {
    const topicId = '550e8400-e29b-41d4-a716-446655440000';
    const key = knowledgeR2Key(topicId);
    expect(key).toMatch(/^knowledge\/\d{6}\/550e8400-e29b-41d4-a716-446655440000-/);
    expect(key.endsWith('.md')).toBe(true);
  });
});

describe('KNOWLEDGE_INDEX_KEY · 常量', () => {
  it('必须等于 knowledge/_index.json', () => {
    expect(KNOWLEDGE_INDEX_KEY).toBe('knowledge/_index.json');
  });
});

// ============================================================
// 业务常量
// ============================================================
describe('knowledge-validation 业务常量', () => {
  it('RATE_LIMIT_PER_MIN 必须 60', () => {
    expect(RATE_LIMIT_PER_MIN).toBe(60);
  });

  it('PAYLOAD_LIMIT_BYTES 必须 1MB', () => {
    expect(PAYLOAD_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('RATE_KEY_PREFIX 必须 knowledge_rate:', () => {
    expect(RATE_KEY_PREFIX).toBe('knowledge_rate:');
  });

  it('KNOWLEDGE_HITS_KEY_PREFIX 必须 r2_knowledge_hits:', () => {
    expect(KNOWLEDGE_HITS_KEY_PREFIX).toBe('r2_knowledge_hits:');
  });

  it('RELATIVE_TIME_REGEX 匹配 24h', () => {
    expect(RELATIVE_TIME_REGEX.test('24h')).toBe(true);
  });

  it('RELATIVE_TIME_REGEX 匹配 7d', () => {
    expect(RELATIVE_TIME_REGEX.test('7d')).toBe(true);
  });

  it('RELATIVE_TIME_REGEX 匹配 30m', () => {
    expect(RELATIVE_TIME_REGEX.test('30m')).toBe(true);
  });
});
