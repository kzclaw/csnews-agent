/**
 * CSNEWS Agent · pull 业务红线契约（v0.33+sweep·FT-KR0 · Phase0 · T000）
 *
 * 唯一目标：守住"pull 端点 API 契约就是这样"（当前实现的 snapshot）
 *
 * 业务红线：
 *   - parseFilters: 4 个 type 入参校验 + limit/order/order_by/since/until/level/category/
 *     topic_id/status/fission_triggered/title_like/select/format 12 个参数边界
 *   - 4 个 type（news/topics/warnings/fission-pending）都要测
 *
 * 加新 type 时（_placeholders.contract.ts "type=trends"），此文件补对应 type 的 describe 块。
 * 不影响 _structure.contract.ts（TYPE_CONFIG 字段完整性自动覆盖）。
 *
 * 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0
 */
import { describe, it, expect } from 'vitest';
import { parseFilters } from '../src/pull';

// ============================================================
// type 入参校验（必填 + 白名单）
// ============================================================
describe('parseFilters · type 入参', () => {
  it('缺 type 必须 400 + "missing type param"', () => {
    const url = new URL('https://example.com/');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('missing type');
  });

  it('type=foo 必须 400 + "unknown type"', () => {
    const url = new URL('https://example.com/?type=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown type');
  });

  it('4 个合法 type（news/topics/warnings/fission-pending）必须都通过', () => {
    const types = ['news', 'topics', 'warnings', 'fission-pending'];
    for (const type of types) {
      const url = new URL(`https://example.com/?type=${type}`);
      const result = parseFilters(url);
      expect(result.ok, `type=${type} 应该 ok`).toBe(true);
    }
  });

  it('type 区分大小写（NEWS ≠ news）', () => {
    const url = new URL('https://example.com/?type=NEWS');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown type');
  });
});

// ============================================================
// limit 边界
// ============================================================
describe('parseFilters · limit 边界', () => {
  it('limit=0 必须 400', () => {
    const url = new URL('https://example.com/?type=news&limit=0');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });

  it('limit=-1 必须 400', () => {
    const url = new URL('https://example.com/?type=news&limit=-1');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });

  it('limit=abc（非数字）必须 400', () => {
    const url = new URL('https://example.com/?type=news&limit=abc');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });

  it('limit=201 必须 400（>200）', () => {
    const url = new URL('https://example.com/?type=news&limit=201');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('200');
  });

  it('limit=200 必须 ok（边界）', () => {
    const url = new URL('https://example.com/?type=news&limit=200');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('limit=1 必须 ok（下界）', () => {
    const url = new URL('https://example.com/?type=news&limit=1');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('limit 缺省必须 = 20', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.limit).toBe(20);
  });
});

// ============================================================
// order 边界
// ============================================================
describe('parseFilters · order 边界', () => {
  it('order=asc 必须 ok', () => {
    const url = new URL('https://example.com/?type=news&order=asc');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('order=desc 必须 ok', () => {
    const url = new URL('https://example.com/?type=news&order=desc');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('order 缺省必须 = desc', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    if (result.ok) expect(result.filters.order).toBe('desc');
  });

  it('order=foo 必须 400', () => {
    const url = new URL('https://example.com/?type=news&order=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('order');
  });

  it('order 大小写不敏感（parseFilters 内部 .toLowerCase()）', () => {
    // 业务契约：ASC/Asc/asc 都接受
    const url = new URL('https://example.com/?type=news&order=ASC');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('asc');
  });
});

// ============================================================
// order_by 白名单（按 type 不同）
// ============================================================
describe('parseFilters · order_by 白名单', () => {
  it('news 用合法 order_by (created_at) 必须 ok', () => {
    const url = new URL('https://example.com/?type=news&order_by=created_at');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('news 用非法 order_by (stage) 必须 400', () => {
    // stage 不在 news 的 allowedOrderBy 里
    const url = new URL('https://example.com/?type=news&order_by=stage');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('order_by');
  });

  it('topics 用合法 order_by (score) 必须 ok', () => {
    const url = new URL('https://example.com/?type=topics&order_by=score');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('warnings 用合法 order_by (severity) 必须 ok', () => {
    const url = new URL('https://example.com/?type=warnings&order_by=severity');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('fission-pending 用非法 order_by (created_at) 必须 400', () => {
    // fission-pending 的 allowedOrderBy 是 ['score', 'last_active_at']
    const url = new URL('https://example.com/?type=fission-pending&order_by=created_at');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// since/until 时间窗
// ============================================================
describe('parseFilters · since/until 时间窗', () => {
  it('since=24h 必须解析为 24h 前的 ISO', () => {
    const url = new URL('https://example.com/?type=news&since=24h');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sinceMs = new Date(result.filters.since!).getTime();
      const now = Date.now();
      const diff = now - sinceMs;
      // 24h 应该是 24 * 3600 * 1000 ms ≈ 86400000，允许 ±5s 误差
      expect(diff).toBeGreaterThan(86400000 - 5000);
      expect(diff).toBeLessThan(86400000 + 5000);
    }
  });

  it('since=30m 必须解析为 30min 前', () => {
    const url = new URL('https://example.com/?type=news&since=30m');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sinceMs = new Date(result.filters.since!).getTime();
      const diff = Date.now() - sinceMs;
      expect(diff).toBeGreaterThan(30 * 60_000 - 5000);
      expect(diff).toBeLessThan(30 * 60_000 + 5000);
    }
  });

  it('since=7d 必须解析为 7d 前', () => {
    const url = new URL('https://example.com/?type=news&since=7d');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sinceMs = new Date(result.filters.since!).getTime();
      const diff = Date.now() - sinceMs;
      expect(diff).toBeGreaterThan(7 * 86_400_000 - 5000);
      expect(diff).toBeLessThan(7 * 86_400_000 + 5000);
    }
  });

  it('since=foo 必须 400', () => {
    const url = new URL('https://example.com/?type=news&since=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('since');
  });

  it('since=2026-01-01T00:00:00Z 必须解析为 ISO（直接用）', () => {
    const url = new URL('https://example.com/?type=news&since=2026-01-01T00:00:00Z');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.since).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('until 与 since 对称（也支持 24h/ISO）', () => {
    const url = new URL('https://example.com/?type=news&until=24h');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.until).toBeTruthy();
    }
  });
});

// ============================================================
// level 校验（VALID_LEVELS）
// ============================================================
describe('parseFilters · level 校验', () => {
  it('level=follow/important/explosive 3 个必须都 ok', () => {
    for (const level of ['follow', 'important', 'explosive']) {
      const url = new URL(`https://example.com/?type=news&level=${level}`);
      const result = parseFilters(url);
      expect(result.ok, `level=${level}`).toBe(true);
    }
  });

  it('level=foo 必须 400', () => {
    const url = new URL('https://example.com/?type=news&level=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('level');
  });

  it('level 缺省不加 filter', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    if (result.ok) {
      expect(result.filters.level).toBeUndefined();
    }
  });
});

// ============================================================
// category 校验（news 支持，任意字符串 ok）
// ============================================================
describe('parseFilters · category 校验', () => {
  it('category=科技 必须 ok（news 支持）', () => {
    const url = new URL('https://example.com/?type=news&category=%E7%A7%91%E6%8A%80');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('category=任意字符串 都 ok（不卡值）', () => {
    const url = new URL('https://example.com/?type=news&category=anything');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('topics 不支持 category（allowedFilters 不含 category）', () => {
    // topics 的 allowedFilters 只有 ['level']
    const url = new URL('https://example.com/?type=topics&category=foo');
    const result = parseFilters(url);
    // category 被忽略，不报错也不加入 filters
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.category).toBeUndefined();
  });
});

// ============================================================
// topic_id UUID 校验
// ============================================================
describe('parseFilters · topic_id UUID 校验', () => {
  it('合法 UUID 必须 ok', () => {
    const url = new URL('https://example.com/?type=news&topic_id=550e8400-e29b-41d4-a716-446655440000');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('非法 UUID 必须 400', () => {
    const url = new URL('https://example.com/?type=news&topic_id=not-a-uuid');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('UUID');
  });

  it('缺 topic_id 必须 ok（filter 不加）', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });
});

// ============================================================
// status 校验（VALID_STATUS）
// ============================================================
describe('parseFilters · status 校验', () => {
  it('5 个合法 status 必须都 ok', () => {
    for (const status of ['open', 'acknowledged', 'validated', 'dismissed', 'closed']) {
      const url = new URL(`https://example.com/?type=warnings&status=${status}`);
      const result = parseFilters(url);
      expect(result.ok, `status=${status}`).toBe(true);
    }
  });

  it('status=foo 必须 400', () => {
    const url = new URL('https://example.com/?type=warnings&status=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('status');
  });
});

// ============================================================
// fission_triggered 解析（v0.32 占位 · 当前 dead code）
// ============================================================
describe('parseFilters · fission_triggered（v0.32 占位）', () => {
  it('fission_triggered 参数当前被忽略（所有 TYPE_CONFIG.allowedFilters 都不含）', () => {
    // 业务契约：fission_triggered filter 在 v0.32 才启用
    // 当前实现：parseFilters 有分支但 TYPE_CONFIG 不含 fission_triggered，所以永远不解析
    // 这条契约守住"v0.32 启用前不能挂"——任何 type 加 fission_triggered 到 allowedFilters 时，这里要改
    const types = ['news', 'topics', 'warnings', 'fission-pending'];
    for (const type of types) {
      const url = new URL(`https://example.com/?type=${type}&fission_triggered=true`);
      const result = parseFilters(url);
      expect(result.ok, `type=${type}`).toBe(true);
      if (result.ok) {
        expect(result.filters.fissionTriggered, `type=${type} 不应设置 fissionTriggered`).toBeUndefined();
      }
    }
  });
});

// ============================================================
// title_like 长度限制
// ============================================================
describe('parseFilters · title_like 长度', () => {
  it('title_like=100 字符 必须 ok', () => {
    const url = new URL(`https://example.com/?type=news&title_like=${'a'.repeat(100)}`);
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('title_like=101 字符 必须 400', () => {
    const url = new URL(`https://example.com/?type=news&title_like=${'a'.repeat(101)}`);
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('100');
  });
});

// ============================================================
// format 校验（VALID_FORMATS）
// ============================================================
describe('parseFilters · format 校验', () => {
  it('format=ids/summary/full 必须都 ok', () => {
    for (const format of ['ids', 'summary', 'full']) {
      const url = new URL(`https://example.com/?type=news&format=${format}`);
      const result = parseFilters(url);
      expect(result.ok, `format=${format}`).toBe(true);
    }
  });

  it('format 缺省 = summary', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    if (result.ok) expect(result.filters.format).toBe('summary');
  });

  it('format=foo 必须 400', () => {
    const url = new URL('https://example.com/?type=news&format=foo');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('format');
  });
});

// ============================================================
// select 字段白名单
// ============================================================
describe('parseFilters · select 白名单', () => {
  it('合法字段（title,url）必须 ok', () => {
    const url = new URL('https://example.com/?type=news&select=title,url');
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('select=embedding（不在白名单）必须 400', () => {
    const url = new URL('https://example.com/?type=news&select=embedding');
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('select');
  });

  it('select 缺省 = config.defaultSelect', () => {
    const url = new URL('https://example.com/?type=news');
    const result = parseFilters(url);
    if (result.ok) {
      expect(result.filters.select).toBeUndefined(); // 不设 select，handlePull 走 defaultSelect
    }
  });
});