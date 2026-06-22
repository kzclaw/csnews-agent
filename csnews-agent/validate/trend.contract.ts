/**
 * CSNEWS Agent · trend 端点业务红线契约（v0.36.7 · KR0 · v0.33+sweep·FT-KR0 续）
 *
 * 唯一目标：守住"trend 端点 API 契约就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - validateType: topics/velocity/acceleration 三选一白名单
 *   - validateSince: ISO 8601 / 相对时间 (24h/7d/30m) / 默认 24h
 *   - validateLimit: 1-200 整数 / 默认 20
 *   - resolveRelativeTime: 24h/7d/30m 解析
 *   - rateKeyForIp: KV key 格式 trend_rate:<ip>
 *   - dailyHitsKeyForToday: KV key 格式 r2_trend_hits:YYYY-MM-DD
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */
import { describe, it, expect } from 'vitest';
import {
  validateType,
  validateSince,
  validateLimit,
  resolveRelativeTime,
  rateKeyForIp,
  dailyHitsKeyForToday,
  ISO8601_REGEX,
  ALLOWED_TYPES,
  RELATIVE_TIME_REGEX,
  RATE_LIMIT_PER_MIN,
  PAYLOAD_LIMIT_BYTES,
  RATE_KEY_PREFIX,
  TREND_HITS_KEY_PREFIX,
  LIMIT_MIN,
  LIMIT_MAX,
  DEFAULT_LIMIT,
} from '../src/trend-validation';

// ============================================================
// resolveRelativeTime
// ============================================================
describe('resolveRelativeTime · 相对时间解析', () => {
  it('24h 必须返 24 小时前 ISO 8601', () => {
    const result = resolveRelativeTime('24h');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t = Date.parse(result!);
    const expected = Date.now() - 24 * 3600 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000); // 误差 < 1s
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

  it('48h 数字部分必须 48', () => {
    const result = resolveRelativeTime('48h');
    const t = Date.parse(result!);
    const expected = Date.now() - 48 * 3600 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000);
  });

  it('非法格式 (hello) 必须返 null', () => {
    expect(resolveRelativeTime('hello')).toBe(null);
  });

  it('缺单位 (24) 必须返 null', () => {
    expect(resolveRelativeTime('24')).toBe(null);
  });

  it('非法单位 (24x) 必须返 null', () => {
    expect(resolveRelativeTime('24x')).toBe(null);
  });

  it('空字符串 必须返 null', () => {
    expect(resolveRelativeTime('')).toBe(null);
  });

  it('RELATIVE_TIME_REGEX 必须匹配 24h/7d/30m', () => {
    expect(RELATIVE_TIME_REGEX.test('24h')).toBe(true);
    expect(RELATIVE_TIME_REGEX.test('7d')).toBe(true);
    expect(RELATIVE_TIME_REGEX.test('30m')).toBe(true);
  });
});

// ============================================================
// validateType
// ============================================================
describe('validateType · type 白名单', () => {
  it('缺 type 必须 fail + reason 提到合法值', () => {
    expect(validateType(null)).toMatchObject({ ok: false, error: 'missing_type' });
    expect(validateType('')).toMatchObject({ ok: false, error: 'missing_type' });
  });

  it('type=topics 必须 ok', () => {
    expect(validateType('topics')).toEqual({ ok: true, reason: 'topics' });
  });

  it('type=velocity 必须 ok', () => {
    expect(validateType('velocity')).toEqual({ ok: true, reason: 'velocity' });
  });

  it('type=acceleration 必须 ok', () => {
    expect(validateType('acceleration')).toEqual({ ok: true, reason: 'acceleration' });
  });

  it('type=TOPICS 大写 必须 ok (lowercase normalize)', () => {
    expect(validateType('TOPICS')).toEqual({ ok: true, reason: 'topics' });
  });

  it('type=foo/bar/xml 必须 fail', () => {
    for (const bad of ['foo', 'bar', 'xml', 'news', 'topics2']) {
      expect(validateType(bad)).toMatchObject({ ok: false, error: 'invalid_type' });
    }
  });

  it('ALLOWED_TYPES 必须是 topics/velocity/acceleration 三个', () => {
    expect(ALLOWED_TYPES).toEqual(['topics', 'velocity', 'acceleration']);
  });
});

// ============================================================
// validateSince
// ============================================================
describe('validateSince · 时间窗校验', () => {
  it('缺 since 必须用默认 24h', () => {
    const r = validateSince(null);
    expect(r.ok).toBe(true);
    expect(r.since).toBeTruthy();
    const t = Date.parse(r.since!);
    const expected = Date.now() - 24 * 3600 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(1000);
  });

  it('空 since 必须用默认 24h', () => {
    const r = validateSince('');
    expect(r.ok).toBe(true);
    expect(r.since).toBeTruthy();
  });

  it('相对时间 24h/7d/30m 必须 ok', () => {
    for (const rel of ['24h', '7d', '30m', '1h', '48h']) {
      expect(validateSince(rel).ok).toBe(true);
    }
  });

  it('ISO 8601 完整格式 必须 ok', () => {
    const r = validateSince('2026-06-15T10:00:00Z');
    expect(r.ok).toBe(true);
    expect(r.since).toBe('2026-06-15T10:00:00.000Z');
  });

  it('ISO 8601 仅日期 必须 ok', () => {
    const r = validateSince('2026-06-15');
    expect(r.ok).toBe(true);
    expect(r.since).toBe('2026-06-15T00:00:00.000Z');
  });

  it('ISO 8601 带时区偏移 必须 ok', () => {
    const r = validateSince('2026-06-15T10:00:00+08:00');
    expect(r.ok).toBe(true);
  });

  it('非法格式 (hello-world) 必须 fail', () => {
    expect(validateSince('hello-world')).toMatchObject({ ok: false, error: 'invalid_since' });
  });

  it('非法格式 (2026/06/15) 必须 fail', () => {
    expect(validateSince('2026/06/15')).toMatchObject({ ok: false, error: 'invalid_since' });
  });

  it('非法格式 (24hours) 必须 fail', () => {
    expect(validateSince('24hours')).toMatchObject({ ok: false, error: 'invalid_since' });
  });

  it('ISO8601_REGEX 必须匹配标准格式', () => {
    expect(ISO8601_REGEX.test('2026-06-15')).toBe(true);
    expect(ISO8601_REGEX.test('2026-06-15T10:00:00Z')).toBe(true);
    expect(ISO8601_REGEX.test('2026-06-15T10:00:00.123Z')).toBe(true);
    expect(ISO8601_REGEX.test('2026-06-15T10:00:00+08:00')).toBe(true);
    expect(ISO8601_REGEX.test('hello')).toBe(false);
  });
});

// ============================================================
// validateLimit
// ============================================================
describe('validateLimit · limit 1-200', () => {
  it('缺 limit 必须用默认 20', () => {
    expect(validateLimit(null)).toEqual({ ok: true, limit: 20 });
    expect(validateLimit('')).toEqual({ ok: true, limit: 20 });
  });

  it('limit=1 边界 必须 ok', () => {
    expect(validateLimit('1')).toEqual({ ok: true, limit: 1 });
  });

  it('limit=200 边界 必须 ok', () => {
    expect(validateLimit('200')).toEqual({ ok: true, limit: 200 });
  });

  it('limit=20 默认值 必须 ok', () => {
    expect(validateLimit('20')).toEqual({ ok: true, limit: 20 });
  });

  it('limit=0 必须 fail (下边界)', () => {
    expect(validateLimit('0')).toMatchObject({ ok: false, error: 'invalid_limit' });
  });

  it('limit=201 必须 fail (上边界)', () => {
    expect(validateLimit('201')).toMatchObject({ ok: false, error: 'invalid_limit' });
  });

  it('limit=999 必须 fail', () => {
    expect(validateLimit('999')).toMatchObject({ ok: false, error: 'invalid_limit' });
  });

  it('limit=abc 必须 fail (非数字)', () => {
    expect(validateLimit('abc')).toMatchObject({ ok: false, error: 'invalid_limit' });
  });

  it('LIMIT_MIN=1, LIMIT_MAX=200, DEFAULT_LIMIT=20 常量', () => {
    expect(LIMIT_MIN).toBe(1);
    expect(LIMIT_MAX).toBe(200);
    expect(DEFAULT_LIMIT).toBe(20);
  });
});

// ============================================================
// rateKeyForIp + dailyHitsKeyForToday
// ============================================================
describe('rateKeyForIp · 反爬限流 KV key', () => {
  it('IP=1.2.3.4 必须返 trend_rate:1.2.3.4', () => {
    expect(rateKeyForIp('1.2.3.4')).toBe('trend_rate:1.2.3.4');
  });

  it('空 IP 必须返 trend_rate:unknown', () => {
    expect(rateKeyForIp('')).toBe('trend_rate:unknown');
  });

  it('RATE_KEY_PREFIX 必须是 trend_rate:', () => {
    expect(RATE_KEY_PREFIX).toBe('trend_rate:');
  });
});

describe('dailyHitsKeyForToday · 监控计数 KV key', () => {
  it('2026-06-16 必须返 r2_trend_hits:2026-06-16', () => {
    expect(dailyHitsKeyForToday(new Date('2026-06-16T00:00:00Z'))).toBe('r2_trend_hits:2026-06-16');
  });

  it('TREND_HITS_KEY_PREFIX 必须是 r2_trend_hits:', () => {
    expect(TREND_HITS_KEY_PREFIX).toBe('r2_trend_hits:');
  });
});

// ============================================================
// 阈值常量
// ============================================================
describe('阈值常量', () => {
  it('RATE_LIMIT_PER_MIN 必须是 60', () => {
    expect(RATE_LIMIT_PER_MIN).toBe(60);
  });

  it('PAYLOAD_LIMIT_BYTES 必须是 1MB', () => {
    expect(PAYLOAD_LIMIT_BYTES).toBe(1024 * 1024);
  });
});
