/**
 * Business contract tests for pull.ts filter parsing.
 * Covers 8 types and all filter parameters.
 */

import { parseFilters, TYPE_CONFIG, VALID_LEVELS, VALID_FORMATS } from '../src/pull';
import { createMockUrl } from '../test-helpers';

describe('parseFilters — type validation', () => {
  it('rejects missing type param', () => {
    const url = createMockUrl({ limit: '20' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('type');
    }
  });

  it('rejects unknown type', () => {
    const url = createMockUrl({ type: 'unknown-type', limit: '20' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('unknown');
    }
  });

  it('accepts all valid type names', () => {
    const validTypes = Object.keys(TYPE_CONFIG);
    expect(validTypes.length).toBeGreaterThanOrEqual(7);
    for (const t of validTypes) {
      const url = createMockUrl({ type: t, limit: '20' });
      const result = parseFilters(url);
      expect(result.ok).toBe(true);
    }
  });
});

describe('parseFilters — limit', () => {
  it('uses default limit of 20', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.limit).toBe(20);
    }
  });

  it('accepts valid limit within range', () => {
    const url = createMockUrl({ type: 'news', limit: '50' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.limit).toBe(50);
  });

  it('accepts limit of 1', () => {
    const url = createMockUrl({ type: 'news', limit: '1' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.limit).toBe(1);
  });

  it('accepts limit of 200 (max)', () => {
    const url = createMockUrl({ type: 'news', limit: '200' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.limit).toBe(200);
  });

  it('rejects limit of 0', () => {
    const url = createMockUrl({ type: 'news', limit: '0' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects negative limit', () => {
    const url = createMockUrl({ type: 'news', limit: '-1' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects limit exceeding 200', () => {
    const url = createMockUrl({ type: 'news', limit: '201' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects non-numeric limit', () => {
    const url = createMockUrl({ type: 'news', limit: 'abc' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — order', () => {
  it('defaults to desc', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('desc');
  });

  it('accepts asc', () => {
    const url = createMockUrl({ type: 'news', order: 'asc' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('asc');
  });

  it('accepts desc', () => {
    const url = createMockUrl({ type: 'news', order: 'DESC' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('desc');
  });

  it('rejects invalid order value', () => {
    const url = createMockUrl({ type: 'news', order: 'random' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — order_by', () => {
  it('uses type-specific default when not provided', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(TYPE_CONFIG.news.defaultOrderBy).toBe('created_at');
      expect(result.filters.orderBy).toBe('created_at');
    }
  });

  it('accepts allowed order_by for news type', () => {
    const url = createMockUrl({ type: 'news', order_by: 'hot_score' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.orderBy).toBe('hot_score');
  });

  it('rejects disallowed order_by for news type', () => {
    const url = createMockUrl({ type: 'news', order_by: 'velocity' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — time window (since / until)', () => {
  it('accepts ISO 8601 date for since', () => {
    const url = createMockUrl({
      type: 'news',
      since: '2024-06-01T00:00:00Z',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.since).toBeTruthy();
  });

  it('accepts ISO 8601 date for until', () => {
    const url = createMockUrl({
      type: 'news',
      until: '2024-06-30T23:59:59Z',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.until).toBeTruthy();
  });

  it('accepts relative time 24h', () => {
    const url = createMockUrl({ type: 'news', since: '24h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('accepts relative time 7d', () => {
    const url = createMockUrl({ type: 'news', since: '7d' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('accepts relative time 30m', () => {
    const url = createMockUrl({ type: 'news', since: '30m' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid date for since', () => {
    const url = createMockUrl({ type: 'news', since: 'not-a-date' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — level filter', () => {
  it('accepts all valid levels', () => {
    for (const level of VALID_LEVELS) {
      const url = createMockUrl({ type: 'news', level });
      const result = parseFilters(url);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.filters.level).toBe(level);
    }
  });

  it('rejects invalid level', () => {
    const url = createMockUrl({ type: 'news', level: 'super-secret' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — topic_id (UUID format)', () => {
  it('accepts valid UUID', () => {
    const url = createMockUrl({
      type: 'news',
      topic_id: '123e4567-e89b-12d3-a456-426614174000',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.topicId).toBe('123e4567-e89b-12d3-a456-426614174000');
    }
  });

  it('rejects invalid UUID', () => {
    const url = createMockUrl({ type: 'news', topic_id: 'not-a-uuid' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — title_like', () => {
  it('accepts short title_like', () => {
    const url = createMockUrl({ type: 'news', title_like: 'AI' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.titleLike).toBe('AI');
  });

  it('rejects title_like exceeding 100 chars', () => {
    const long = 'a'.repeat(101);
    const url = createMockUrl({ type: 'news', title_like: long });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — format', () => {
  it('defaults to summary', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('summary');
  });

  it('accepts all valid formats', () => {
    for (const fmt of VALID_FORMATS) {
      const url = createMockUrl({ type: 'news', format: fmt });
      const result = parseFilters(url);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.filters.format).toBe(fmt);
    }
  });

  it('rejects invalid format', () => {
    const url = createMockUrl({ type: 'news', format: 'invalid' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — entity type (R2)', () => {
  it('accepts entity type with since/until', () => {
    const url = createMockUrl({
      type: 'entity',
      since: '2024-01-01T00:00:00Z',
      until: '2024-12-31T23:59:59Z',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.since).toBeTruthy();
      expect(result.filters.until).toBeTruthy();
    }
  });
});

describe('parseFilters — trends type', () => {
  it('accepts trends type with stage filter', () => {
    const url = createMockUrl({ type: 'trends', stage: 'emerging' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.stage).toBe('emerging');
  });

  it('accepts stage growing', () => {
    const url = createMockUrl({ type: 'trends', stage: 'growing' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });
});

describe('parseFilters — offset', () => {
  it('defaults to 0', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.offset).toBe(0);
  });

  it('accepts positive offset', () => {
    const url = createMockUrl({ type: 'news', offset: '20' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.offset).toBe(20);
  });

  it('rejects negative offset', () => {
    const url = createMockUrl({ type: 'news', offset: '-1' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — full integration', () => {
  it('accepts all params together', () => {
    const url = createMockUrl({
      type: 'news',
      limit: '10',
      order: 'asc',
      order_by: 'hot_score',
      level: 'important',
      category: '科技',
      since: '7d',
      format: 'ids',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.limit).toBe(10);
      expect(result.filters.order).toBe('asc');
      expect(result.filters.orderBy).toBe('hot_score');
      expect(result.filters.level).toBe('important');
      expect(result.filters.format).toBe('ids');
    }
  });
});
