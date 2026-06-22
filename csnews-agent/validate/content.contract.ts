/**
 * CSNEWS Agent · content 端点业务红线契约（v0.36.6 · KR0 · v0.33+sweep·FT-KR0 续）
 *
 * 唯一目标：守住"content 端点 API 契约就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - validateId: UUID v4 格式 (RFC 4122 简化版, 接受 v1-5)
 *   - validateFormat: text/html/json 三选一白名单
 *   - rateKeyForIp: KV key 格式 content_rate:<ip>
 *   - dailyHitsKeyForToday: KV key 格式 r2_content_hits:YYYY-MM-DD
 *   - RATE_LIMIT_PER_MIN: 60
 *   - PAYLOAD_LIMIT_BYTES: 1MB
 *   - escapeHtml: XSS 防御
 *
 * 加新 format 时: ALLOWED_FORMATS 加 + 此文件 describe 块补 1 个 it
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */
import { describe, it, expect } from 'vitest';
import {
  validateId,
  validateFormat,
  rateKeyForIp,
  dailyHitsKeyForToday,
  escapeHtml,
  UUID_REGEX,
  ALLOWED_FORMATS,
  RATE_LIMIT_PER_MIN,
  PAYLOAD_LIMIT_BYTES,
  RATE_KEY_PREFIX,
  CONTENT_HITS_KEY_PREFIX,
} from '../src/content-validation';

// ============================================================
// validateId (id 必须 UUID 格式)
// ============================================================
describe('validateId · UUID 校验', () => {
  it('缺 id 必须 fail + reason 提到 id 不能为空', () => {
    expect(validateId('')).toEqual({
      ok: false,
      error: 'invalid_id',
      reason: expect.stringContaining('不能为空'),
    });
  });

  it('非 string 类型 必须 fail', () => {
    expect(validateId(null as any)).toEqual({
      ok: false,
      error: 'invalid_id',
      reason: expect.any(String),
    });
    expect(validateId(undefined as any)).toEqual({
      ok: false,
      error: 'invalid_id',
      reason: expect.any(String),
    });
  });

  it('普通字符串 必须 fail', () => {
    expect(validateId('hello-world')).toMatchObject({ ok: false, error: 'invalid_id' });
  });

  it('短 UUID 必须 fail (8-4-4-4-12 格式不对)', () => {
    expect(validateId('550e8400-e29b-41d4')).toMatchObject({ ok: false, error: 'invalid_id' });
  });

  it('超长 UUID 必须 fail', () => {
    expect(validateId('550e8400-e29b-41d4-a716-446655440000-extra')).toMatchObject({
      ok: false,
      error: 'invalid_id',
    });
  });

  it('含非法字符 必须 fail', () => {
    expect(validateId('550e8400-e29b-41d4-a716-44665544000Z')).toMatchObject({
      ok: false,
      error: 'invalid_id',
    });
  });

  it('标准 UUID v4 格式 必须 ok', () => {
    expect(validateId('550e8400-e29b-41d4-a716-446655440000')).toEqual({ ok: true });
  });

  it('UUID v1-v5 都能接受 (Supabase 可能用任意版本)', () => {
    // v1 example
    expect(validateId('a8098c1a-f86e-5158-b6ef-bd9d3b9c1111')).toEqual({ ok: true });
    // 全 0 (无效但格式对)
    expect(validateId('00000000-0000-0000-0000-000000000000')).toEqual({ ok: true });
  });

  it('大写 UUID 必须 ok (Supabase 默认小写但兼容大写)', () => {
    expect(validateId('550E8400-E29B-41D4-A716-446655440000')).toEqual({ ok: true });
  });
});

// ============================================================
// validateFormat (format 白名单 text/html/json)
// ============================================================
describe('validateFormat · format 白名单', () => {
  it('缺 format 必须 fail (虽然 handler 默认 json, 但单独测函数行为)', () => {
    expect(validateFormat('')).toMatchObject({ ok: false, error: 'invalid_format' });
  });

  it('format=json 必须 ok', () => {
    expect(validateFormat('json')).toEqual({ ok: true });
  });

  it('format=text 必须 ok', () => {
    expect(validateFormat('text')).toEqual({ ok: true });
  });

  it('format=html 必须 ok', () => {
    expect(validateFormat('html')).toEqual({ ok: true });
  });

  it('format=JSON 大写 必须 ok (lowercase normalize)', () => {
    expect(validateFormat('JSON')).toEqual({ ok: true });
  });

  it('format=xml/pdf/markdown 必须 fail', () => {
    for (const bad of ['xml', 'pdf', 'markdown', 'csv', 'yaml']) {
      expect(validateFormat(bad)).toMatchObject({ ok: false, error: 'invalid_format' });
    }
  });

  it('format= 必须 fail', () => {
    expect(validateFormat('text; charset=utf-8')).toMatchObject({
      ok: false,
      error: 'invalid_format',
    });
  });

  it('ALLOWED_FORMATS 必须是 text/html/json 三个', () => {
    expect(ALLOWED_FORMATS).toEqual(['text', 'html', 'json']);
  });
});

// ============================================================
// rateKeyForIp (KV key 格式)
// ============================================================
describe('rateKeyForIp · 反爬限流 KV key', () => {
  it('IP=1.2.3.4 必须返 content_rate:1.2.3.4', () => {
    expect(rateKeyForIp('1.2.3.4')).toBe('content_rate:1.2.3.4');
  });

  it('空 IP 必须返 content_rate:unknown', () => {
    expect(rateKeyForIp('')).toBe('content_rate:unknown');
  });

  it('IPv6 地址 必须保留原样', () => {
    expect(rateKeyForIp('2001:db8::1')).toBe('content_rate:2001:db8::1');
  });

  it('RATE_KEY_PREFIX 必须是 content_rate:', () => {
    expect(RATE_KEY_PREFIX).toBe('content_rate:');
  });
});

// ============================================================
// dailyHitsKeyForToday (监控计数 KV key)
// ============================================================
describe('dailyHitsKeyForToday · 监控计数 KV key', () => {
  it('2026-06-16 必须返 r2_content_hits:2026-06-16', () => {
    expect(dailyHitsKeyForToday(new Date('2026-06-16T00:00:00Z'))).toBe(
      'r2_content_hits:2026-06-16'
    );
  });

  it('2026-01-01 必须返 r2_content_hits:2026-01-01', () => {
    expect(dailyHitsKeyForToday(new Date('2026-01-01T23:59:59Z'))).toBe(
      'r2_content_hits:2026-01-01'
    );
  });

  it('CONTENT_HITS_KEY_PREFIX 必须是 r2_content_hits:', () => {
    expect(CONTENT_HITS_KEY_PREFIX).toBe('r2_content_hits:');
  });
});

// ============================================================
// 限流 + payload 阈值常量
// ============================================================
describe('限流 + payload 阈值', () => {
  it('RATE_LIMIT_PER_MIN 必须是 60', () => {
    expect(RATE_LIMIT_PER_MIN).toBe(60);
  });

  it('PAYLOAD_LIMIT_BYTES 必须是 1MB', () => {
    expect(PAYLOAD_LIMIT_BYTES).toBe(1024 * 1024);
  });
});

// ============================================================
// UUID_REGEX (单测 regex 本身, 防止将来误改)
// ============================================================
describe('UUID_REGEX (防误改)', () => {
  it('必须匹配标准 UUID v4', () => {
    expect(UUID_REGEX.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('必须不匹配普通字符串', () => {
    expect(UUID_REGEX.test('hello-world')).toBe(false);
  });

  it('必须不匹配空字符串', () => {
    expect(UUID_REGEX.test('')).toBe(false);
  });

  it('必须不匹配数字', () => {
    expect(UUID_REGEX.test('1234567890')).toBe(false);
  });
});

// ============================================================
// escapeHtml (XSS 防御)
// ============================================================
describe('escapeHtml · XSS 防御', () => {
  it('<script> 必须转义为 &lt;script&gt;', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('& 必须转义为 &amp;', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('" 必须转义为 &quot;', () => {
    expect(escapeHtml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it("' 必须转义为 &#39;", () => {
    expect(escapeHtml("a 'b' c")).toBe('a &#39;b&#39; c');
  });

  it('空字符串必须返空', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('纯中文 必须不变', () => {
    expect(escapeHtml('美加墨世界杯韩国队')).toBe('美加墨世界杯韩国队');
  });
});
