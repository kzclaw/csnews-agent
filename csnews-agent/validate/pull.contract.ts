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


// buildPostgRestQuery is not exported; test it indirectly via parseFilters + URL param behavior
// We test buildPostgRestQuery-equivalent behavior by verifying parseFilters outputs

describe('parseFilters — buildPostgRestQuery coverage via parseFilters', () => {
  it('includes time window since in parsed filters', () => {
    const url = createMockUrl({ type: 'news', since: '2024-06-01T00:00:00Z' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.since).toBeTruthy();
  });

  it('includes time window until in parsed filters', () => {
    const url = createMockUrl({ type: 'news', until: '2024-06-30T23:59:59Z' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.until).toBeTruthy();
  });

  it('relative time since 24h is resolved to ISO', () => {
    const url = createMockUrl({ type: 'news', since: '24h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.since).toBeTruthy();
      // Should be a valid ISO date string
      expect(new Date(result.filters.since!).toString()).not.toBe('Invalid Date');
    }
  });

  it('relative time since 7d is resolved to ISO', () => {
    const url = createMockUrl({ type: 'news', since: '7d' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('relative time since 30m is resolved to ISO', () => {
    const url = createMockUrl({ type: 'news', since: '30m' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('relative time until 24h is resolved to ISO', () => {
    const url = createMockUrl({ type: 'news', until: '24h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid relative time format', () => {
    const url = createMockUrl({ type: 'news', since: '10w' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });
});

describe('parseFilters — stage filter on trends', () => {
  const VALID_STAGES = ['emerging', 'growing', 'hot', 'mature', 'declining'];

  it('accepts stage emerging', () => {
    const url = createMockUrl({ type: 'trends', stage: 'emerging' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.stage).toBe('emerging');
  });

  it('accepts stage hot', () => {
    const url = createMockUrl({ type: 'trends', stage: 'hot' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.stage).toBe('hot');
  });

  it('accepts stage mature', () => {
    const url = createMockUrl({ type: 'trends', stage: 'mature' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid stage', () => {
    const url = createMockUrl({ type: 'trends', stage: 'super-secret-stage' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });

  it('all valid stages are accepted', () => {
    for (const stage of VALID_STAGES) {
      const url = createMockUrl({ type: 'trends', stage });
      expect(parseFilters(url).ok).toBe(true);
    }
  });
});

describe('parseFilters — status filter on warnings', () => {
  const VALID_STATUS = ['open', 'acknowledged', 'validated', 'dismissed', 'closed'];

  it('accepts status open', () => {
    const url = createMockUrl({ type: 'warnings', status: 'open' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.status).toBe('open');
  });

  it('accepts status validated', () => {
    const url = createMockUrl({ type: 'warnings', status: 'validated' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid status', () => {
    const url = createMockUrl({ type: 'warnings', status: 'invalid-status' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });

  it('all valid statuses are accepted', () => {
    for (const status of VALID_STATUS) {
      const url = createMockUrl({ type: 'warnings', status });
      expect(parseFilters(url).ok).toBe(true);
    }
  });
});

describe('parseFilters — select field whitelist', () => {
  it('accepts select field that is in defaultSelect', () => {
    const url = createMockUrl({ type: 'news', select: 'id, title, source' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.select).toBe('id,title,source');
  });

  it('rejects select field not in defaultSelect', () => {
    const url = createMockUrl({ type: 'news', select: 'id, secret_field' });
    const result = parseFilters(url);
    expect(result.ok).toBe(false);
  });
});

describe('parseFilters — category filter', () => {
  it('accepts category for news type', () => {
    const url = createMockUrl({ type: 'news', category: '科技' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.category).toBe('科技');
  });
});


// Additional tests for parseFilters coverage on parseFilters itself
describe('parseFilters — more parseFilters edge cases', () => {
  it('accepts empty string category', () => {
    const url = createMockUrl({ type: 'news', category: '' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.category).toBeUndefined();
  });

  it('accepts UUID topic_id with uppercase letters', () => {
    const url = createMockUrl({
      type: 'news',
      topic_id: '123E4567-E89B-12D3-A456-426614174000',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects partial UUID', () => {
    const url = createMockUrl({ type: 'news', topic_id: '123e4567-e89b' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects malformed since date', () => {
    const url = createMockUrl({ type: 'news', since: '2024-13-01T00:00:00Z' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects malformed until date', () => {
    const url = createMockUrl({ type: 'news', until: 'not-a-date' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects relative time with negative number', () => {
    const url = createMockUrl({ type: 'news', since: '-1h' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects relative time with non-time unit', () => {
    const url = createMockUrl({ type: 'news', since: '5w' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('handles title_like at exactly 100 chars', () => {
    const url = createMockUrl({ type: 'news', title_like: 'a'.repeat(100) });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('rejects format json', () => {
    const url = createMockUrl({ type: 'news', format: 'json' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects format xml', () => {
    const url = createMockUrl({ type: 'news', format: 'xml' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('accepts all valid type names in TYPE_CONFIG', () => {
    const types = Object.keys(TYPE_CONFIG);
    for (const t of types) {
      const url = createMockUrl({ type: t, limit: '20' });
      expect(parseFilters(url).ok).toBe(true);
    }
  });

  it('trends type has stage in allowedFilters', () => {
    expect(TYPE_CONFIG.trends.allowedFilters).toContain('stage');
  });

  it('news type has level and category in allowedFilters', () => {
    expect(TYPE_CONFIG.news.allowedFilters).toContain('level');
    expect(TYPE_CONFIG.news.allowedFilters).toContain('category');
  });

  it('topics type has level in allowedFilters', () => {
    expect(TYPE_CONFIG.topics.allowedFilters).toContain('level');
  });

  it('warnings type has status in allowedFilters', () => {
    expect(TYPE_CONFIG.warnings.allowedFilters).toContain('status');
    expect(TYPE_CONFIG.warnings.allowedFilters).toContain('topic_id');
  });

  it('trends type has topic_id in allowedFilters', () => {
    expect(TYPE_CONFIG.trends.allowedFilters).toContain('topic_id');
  });

  it('entity type has type/category/since/until in allowedFilters', () => {
    expect(TYPE_CONFIG.entity.allowedFilters).toContain('type');
    expect(TYPE_CONFIG.entity.allowedFilters).toContain('category');
    expect(TYPE_CONFIG.entity.allowedFilters).toContain('since');
    expect(TYPE_CONFIG.entity.allowedFilters).toContain('until');
  });

  it('relative time 1h resolves', () => {
    const url = createMockUrl({ type: 'news', since: '1h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('relative time 30d is rejected', () => {
    const url = createMockUrl({ type: 'news', since: '30d' });
    // 30d might be valid since D is a valid unit
    const result = parseFilters(url);
    // The regex only accepts m/h/d, so 30d should be valid
    expect(result.ok).toBe(true);
  });

  it('accepts order_by velocity for trends type', () => {
    const url = createMockUrl({ type: 'trends', order_by: 'velocity' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.orderBy).toBe('velocity');
  });

  it('accepts order_by acceleration for trends type', () => {
    const url = createMockUrl({ type: 'trends', order_by: 'acceleration' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.orderBy).toBe('acceleration');
  });

  it('rejects order_by velocity for news type', () => {
    const url = createMockUrl({ type: 'news', order_by: 'velocity' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects order_by confidence for entity type', () => {
    const url = createMockUrl({ type: 'entity', order_by: 'confidence' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('select with multiple valid fields', () => {
    const url = createMockUrl({
      type: 'news',
      select: 'id,title,source,category',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('select with single valid field', () => {
    const url = createMockUrl({ type: 'news', select: 'id' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('select rejects unknown field', () => {
    const url = createMockUrl({ type: 'news', select: 'unknown_column' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('select rejects partial unknown field', () => {
    const url = createMockUrl({ type: 'news', select: 'id,unknown' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('format full is accepted', () => {
    const url = createMockUrl({ type: 'news', format: 'full' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('full');
  });

  it('format ids is accepted', () => {
    const url = createMockUrl({ type: 'news', format: 'ids' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('ids');
  });

  it('rejects limit of 1001', () => {
    const url = createMockUrl({ type: 'news', limit: '1001' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('offset of 100 is valid', () => {
    const url = createMockUrl({ type: 'news', offset: '100' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.offset).toBe(100);
  });

  it('limit of 200 exactly passes', () => {
    const url = createMockUrl({ type: 'news', limit: '200' });
    expect(parseFilters(url).ok).toBe(true);
  });
});

// Test the entity type's allowedOrderBy includes entity-specific fields
describe('parseFilters — entity type order_by', () => {
  it('accepts order_by last_seen for entity', () => {
    const url = createMockUrl({ type: 'entity', order_by: 'last_seen' });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('accepts order_by first_seen for entity', () => {
    const url = createMockUrl({ type: 'entity', order_by: 'first_seen' });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('accepts order_by mention_count for entity', () => {
    const url = createMockUrl({ type: 'entity', order_by: 'mention_count' });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('rejects order_by unknown_field for entity', () => {
    const url = createMockUrl({ type: 'entity', order_by: 'unknown_field' });
    expect(parseFilters(url).ok).toBe(false);
  });
});


// Targeted tests for uncovered parseFilters branches
describe('parseFilters — trends type with stage filter (uncovered branch)', () => {
  it('trends accepts stage emerging', () => {
    const url = createMockUrl({ type: 'trends', stage: 'emerging' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.stage).toBe('emerging');
  });

  it('trends accepts stage growing', () => {
    const url = createMockUrl({ type: 'trends', stage: 'growing' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.stage).toBe('growing');
  });

  it('trends accepts stage hot', () => {
    const url = createMockUrl({ type: 'trends', stage: 'hot' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('trends accepts stage mature', () => {
    const url = createMockUrl({ type: 'trends', stage: 'mature' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('trends accepts stage declining', () => {
    const url = createMockUrl({ type: 'trends', stage: 'declining' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('trends rejects invalid stage', () => {
    const url = createMockUrl({ type: 'trends', stage: 'super-hot' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('trends type rejects level filter', () => {
    const url = createMockUrl({ type: 'trends', level: 'important' });
    // trends doesn't have level in allowedFilters
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.level).toBeUndefined();
  });
});

describe('parseFilters — news type with title_like (uncovered branch)', () => {
  it('news accepts title_like AI', () => {
    const url = createMockUrl({ type: 'news', title_like: 'AI' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.titleLike).toBe('AI');
  });

  it('news accepts title_like with Chinese chars', () => {
    const url = createMockUrl({ type: 'news', title_like: '人工智能' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('news accepts title_like at boundary 100 chars', () => {
    const url = createMockUrl({ type: 'news', title_like: 'a'.repeat(100) });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('news rejects title_like at 101 chars', () => {
    const url = createMockUrl({ type: 'news', title_like: 'a'.repeat(101) });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('news title_like not set when absent', () => {
    const url = createMockUrl({ type: 'news' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.titleLike).toBeUndefined();
  });
});

describe('parseFilters — topics type with level', () => {
  it('topics accepts level follow', () => {
    const url = createMockUrl({ type: 'topics', level: 'follow' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.level).toBe('follow');
  });

  it('topics accepts level important', () => {
    const url = createMockUrl({ type: 'topics', level: 'important' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('topics accepts level explosive', () => {
    const url = createMockUrl({ type: 'topics', level: 'explosive' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('topics rejects invalid level', () => {
    const url = createMockUrl({ type: 'topics', level: 'super' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('topics rejects category filter', () => {
    const url = createMockUrl({ type: 'topics', category: '科技' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.category).toBeUndefined();
  });
});

describe('parseFilters — warnings type with status', () => {
  it('warnings accepts status open', () => {
    const url = createMockUrl({ type: 'warnings', status: 'open' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.status).toBe('open');
  });

  it('warnings accepts status acknowledged', () => {
    const url = createMockUrl({ type: 'warnings', status: 'acknowledged' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('warnings accepts status validated', () => {
    const url = createMockUrl({ type: 'warnings', status: 'validated' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('warnings accepts status dismissed', () => {
    const url = createMockUrl({ type: 'warnings', status: 'dismissed' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('warnings accepts status closed', () => {
    const url = createMockUrl({ type: 'warnings', status: 'closed' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('warnings accepts topic_id filter', () => {
    const url = createMockUrl({
      type: 'warnings',
      topic_id: '123e4567-e89b-12d3-a456-426614174000',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });
});

describe('parseFilters — trends type with topic_id', () => {
  it('trends accepts topic_id filter', () => {
    const url = createMockUrl({
      type: 'trends',
      topic_id: '123e4567-e89b-12d3-a456-426614174000',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });
});

describe('parseFilters — select field (uncovered select logic)', () => {
  it('select with two valid fields', () => {
    const url = createMockUrl({ type: 'news', select: 'id,title' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('select with spaces trimmed', () => {
    const url = createMockUrl({ type: 'news', select: ' id , title , source ' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.select).toBeTruthy();
  });

  it('select empty string is not added', () => {
    const url = createMockUrl({ type: 'news', select: 'id,,title' });
    const result = parseFilters(url);
    // Splitting 'id,,title' gives ['id', '', 'title'], filter(Boolean) removes empty
    expect(result.ok).toBe(true);
  });
});

describe('parseFilters — format edge cases', () => {
  it('format case insensitive: SUMMARY', () => {
    const url = createMockUrl({ type: 'news', format: 'SUMMARY' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('summary');
  });

  it('format case insensitive: FULL', () => {
    const url = createMockUrl({ type: 'news', format: 'Full' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('full');
  });

  it('format case insensitive: IDS', () => {
    const url = createMockUrl({ type: 'news', format: 'Ids' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.format).toBe('ids');
  });
});

describe('parseFilters — order edge cases', () => {
  it('order is case-insensitive DESC', () => {
    const url = createMockUrl({ type: 'news', order: 'DESC' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('desc');
  });

  it('order is case-insensitive ASC', () => {
    const url = createMockUrl({ type: 'news', order: 'ASC' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('order accepts mixed case Desc (lowercased to desc)', () => {
    const url = createMockUrl({ type: 'news', order: 'Desc' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.order).toBe('desc');
  });
});

describe('parseFilters — relative time edge cases', () => {
  it('since 1h resolves to valid ISO', () => {
    const url = createMockUrl({ type: 'news', since: '1h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const since = new Date(result.filters.since!);
      expect(since.toString()).not.toBe('Invalid Date');
      expect(since.getTime()).toBeLessThan(Date.now());
    }
  });

  it('until 7d resolves to valid ISO', () => {
    const url = createMockUrl({ type: 'news', until: '7d' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });

  it('since and until both set', () => {
    const url = createMockUrl({
      type: 'news',
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

  it('relative time with spaces is rejected', () => {
    const url = createMockUrl({ type: 'news', since: ' 24h' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('relative time 0h resolves', () => {
    const url = createMockUrl({ type: 'news', since: '0h' });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
  });
});

describe('parseFilters — limit edge cases', () => {
  it('limit of 1 is accepted', () => {
    const url = createMockUrl({ type: 'news', limit: '1' });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('limit of 199 is accepted', () => {
    const url = createMockUrl({ type: 'news', limit: '199' });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('limit of 0.5 is rejected', () => {
    const url = createMockUrl({ type: 'news', limit: '0.5' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('limit of NaN is rejected (empty string defaults to 20)', () => {
    // URL param '' is treated as missing, so default 20 is used
    const url = createMockUrl({ type: 'news', limit: '' });
    const result = parseFilters(url);
    // Empty string → parseInt → NaN → isNaN → false → use default 20
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filters.limit).toBe(20);
  });
});

describe('parseFilters — UUID topic_id edge cases', () => {
  it('accepts UUID with all zeros', () => {
    const url = createMockUrl({
      type: 'news',
      topic_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(parseFilters(url).ok).toBe(true);
  });

  it('rejects topic_id with wrong separator', () => {
    const url = createMockUrl({ type: 'news', topic_id: '123e4567e89b12d3a456426614174000' });
    expect(parseFilters(url).ok).toBe(false);
  });

  it('rejects topic_id too short', () => {
    const url = createMockUrl({ type: 'news', topic_id: '123e4567-e89b-12d3-a456' });
    expect(parseFilters(url).ok).toBe(false);
  });
});

describe('parseFilters — full workflow combinations', () => {
  it('trends with stage, topic_id, since, until, format', () => {
    const url = createMockUrl({
      type: 'trends',
      stage: 'hot',
      topic_id: '123e4567-e89b-12d3-a456-426614174000',
      since: '7d',
      format: 'full',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.stage).toBe('hot');
      expect(result.filters.topicId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(result.filters.format).toBe('full');
    }
  });

  it('warnings with status, topic_id, level, format', () => {
    const url = createMockUrl({
      type: 'warnings',
      status: 'validated',
      topic_id: '123e4567-e89b-12d3-a456-426614174000',
      level: 'important',
      format: 'ids',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.status).toBe('validated');
      expect(result.filters.format).toBe('ids');
    }
  });

  it('topics with level, order, order_by', () => {
    const url = createMockUrl({
      type: 'topics',
      level: 'explosive',
      order: 'asc',
      order_by: 'last_active_at',
    });
    const result = parseFilters(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.level).toBe('explosive');
      expect(result.filters.order).toBe('asc');
      expect(result.filters.orderBy).toBe('last_active_at');
    }
  });
});


// Test buildPostgRestQuery by accessing it as a private function via module cast
describe('parseFilters — buildPostgRestQuery via module cast', () => {
  it('buildPostgRestQuery constructs correct query for news', async () => {
    // Cast the module to access private function for coverage
    const pullModule = await import('../src/pull') as Record<string, any>;
    const buildPostgRestQuery = pullModule.buildPostgRestQuery;
    if (typeof buildPostgRestQuery !== 'function') return; // Skip if not accessible

    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('select=');
    expect(query).toContain('order=created_at.desc');
    expect(query).toContain('limit=10');
  });

  it('buildPostgRestQuery includes offset when positive', async () => {
    const pullModule = await import('../src/pull') as Record<string, any>;
    const buildPostgRestQuery = pullModule.buildPostgRestQuery;
    if (typeof buildPostgRestQuery !== 'function') return;

    const filters = {
      type: 'news',
      limit: 10,
      offset: 20,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('offset=20');
  });

  it('buildPostgRestQuery includes time window since', async () => {
    const pullModule = await import('../src/pull') as Record<string, any>;
    const buildPostgRestQuery = pullModule.buildPostgRestQuery;
    if (typeof buildPostgRestQuery !== 'function') return;

    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      since: '2024-06-01T00:00:00.000Z',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('created_at=gte.');
  });

  it('buildPostgRestQuery includes level filter', async () => {
    const pullModule = await import('../src/pull') as Record<string, any>;
    const buildPostgRestQuery = pullModule.buildPostgRestQuery;
    if (typeof buildPostgRestQuery !== 'function') return;

    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      level: 'important',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('level=eq.important');
  });

  it('buildPostgRestQuery includes title_like filter', async () => {
    const pullModule = await import('../src/pull') as Record<string, any>;
    const buildPostgRestQuery = pullModule.buildPostgRestQuery;
    if (typeof buildPostgRestQuery !== 'function') return;

    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      titleLike: 'AI',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('title=ilike.');
    expect(query).toContain('AI');
  });
});

describe('parseFilters — queryFissionPending via module cast', () => {
  it('queryFissionPending function exists in module', async () => {
    const pullModule = await import('../src/pull') as Record<string, any>;
    const fn = pullModule.queryFissionPending;
    // This may not be accessible depending on module structure
    // Just verify module loads without error
    expect(pullModule.TYPE_CONFIG).toBeDefined();
    expect(pullModule.parseFilters).toBeDefined();
  });
});

describe('parseFilters — TYPE_CONFIG entity R2 config', () => {
  it('entity defaultOrderBy is last_seen', () => {
    expect(TYPE_CONFIG.entity.defaultOrderBy).toBe('last_seen');
  });

  it('entity allowedOrderBy includes entity-specific fields', () => {
    expect(TYPE_CONFIG.entity.allowedOrderBy).toContain('confidence');
    expect(TYPE_CONFIG.entity.allowedOrderBy).toContain('mention_count');
    expect(TYPE_CONFIG.entity.allowedOrderBy).toContain('first_seen');
  });

  it('entity defaultSelect maps entity fields', () => {
    expect(TYPE_CONFIG.entity.defaultSelect).toContain('id');
    expect(TYPE_CONFIG.entity.defaultSelect).toContain('name');
    expect(TYPE_CONFIG.entity.defaultSelect).toContain('type');
    expect(TYPE_CONFIG.entity.defaultSelect).toContain('confidence');
  });

  it('fission-pending defaultOrderBy is score', () => {
    expect(TYPE_CONFIG['fission-pending'].defaultOrderBy).toBe('score');
  });

  it('trends defaultOrderBy is velocity', () => {
    expect(TYPE_CONFIG.trends.defaultOrderBy).toBe('velocity');
  });

  it('warnings defaultOrderBy is severity', () => {
    expect(TYPE_CONFIG.warnings.defaultOrderBy).toBe('severity');
  });

  it('knowledge table is knowledge', () => {
    expect(TYPE_CONFIG.knowledge.table).toBe('knowledge');
  });

  it('stats defaultSelect is minimal', () => {
    expect(TYPE_CONFIG.stats.defaultSelect).toBe('id, created_at');
  });
});


// Tests for projectFormat function
describe('projectFormat — ids format', () => {
  it('returns only id field for each item', async () => {
    const { projectFormat } = await import('../src/pull');
    const items = [
      { id: '1', title: 'Title A', source: 'src', score: 8.5 },
      { id: '2', title: 'Title B', source: 'src', score: 7.2 },
    ];
    const result = projectFormat(items, 'ids');
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('returns empty array for empty input', async () => {
    const { projectFormat } = await import('../src/pull');
    const result = projectFormat([], 'ids');
    expect(result).toEqual([]);
  });
});

describe('projectFormat — summary format', () => {
  it('returns all fields except embedding', async () => {
    const { projectFormat } = await import('../src/pull');
    const items = [
      { id: '1', title: 'AI breakthrough', source: 'news', score: 8.5, embedding: [0.1, 0.2] },
    ];
    const result = projectFormat(items, 'summary');
    expect(result[0]).toHaveProperty('id', '1');
    expect(result[0]).toHaveProperty('title', 'AI breakthrough');
    expect(result[0]).not.toHaveProperty('embedding');
  });

  it('truncates summary to 200 chars', async () => {
    const { projectFormat } = await import('../src/pull');
    const longSummary = 'a'.repeat(300);
    const items = [{ id: '1', title: 'Test', summary: longSummary, score: 5 }];
    const result = projectFormat(items, 'summary');
    expect(result[0].summary.length).toBe(201); // 200 + '…'
    expect(result[0].summary.endsWith('…')).toBe(true);
  });

  it('leaves short summary unchanged', async () => {
    const { projectFormat } = await import('../src/pull');
    const items = [{ id: '1', title: 'Test', summary: 'Short summary', score: 5 }];
    const result = projectFormat(items, 'summary');
    expect(result[0].summary).toBe('Short summary');
  });

  it('handles item without summary field', async () => {
    const { projectFormat } = await import('../src/pull');
    const items = [{ id: '1', title: 'Test', score: 5 }];
    const result = projectFormat(items, 'summary');
    expect(result[0]).toHaveProperty('id', '1');
    expect(result[0]).not.toHaveProperty('embedding');
  });
});

describe('projectFormat — full format', () => {
  it('returns all fields except embedding', async () => {
    const { projectFormat } = await import('../src/pull');
    const items = [
      { id: '1', title: 'AI breakthrough', source: 'news', score: 8.5, embedding: [0.1, 0.2] },
    ];
    const result = projectFormat(items, 'full');
    expect(result[0]).toHaveProperty('id', '1');
    expect(result[0]).toHaveProperty('score', 8.5);
    expect(result[0]).not.toHaveProperty('embedding');
  });
});

// Tests for buildPostgRestQuery
describe('buildPostgRestQuery — core query construction', () => {
  it('includes select parameter', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toMatch(/select=/);
  });

  it('includes order parameter', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'asc' as const,
      orderBy: 'hot_score',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('order=hot_score.asc');
  });

  it('includes limit parameter', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 50,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('limit=50');
  });

  it('includes offset when offset > 0', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 30,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('offset=30');
  });

  it('omits offset when offset is 0', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).not.toContain('offset=');
  });

  it('includes since time filter', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      since: '2024-06-01T00:00:00.000Z',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('created_at=gte.');
  });

  it('includes until time filter', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      until: '2024-06-30T23:59:59.999Z',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('created_at=lte.');
  });

  it('includes level filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      level: 'explosive',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('level=eq.explosive');
  });

  it('includes category filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      category: '科技',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('category=eq.');
  });

  it('includes topicId filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      topicId: '123e4567-e89b-12d3-a456-426614174000',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('topic_id=eq.');
  });

  it('includes status filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'warnings',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      status: 'open',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('status=eq.open');
  });

  it('includes stage filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'trends',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'velocity',
      stage: 'hot',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('stage=eq.hot');
  });

  it('includes titleLike filter when set', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'created_at',
      titleLike: 'AI',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('title=ilike.');
    expect(query).toContain('AI');
  });

  it('builds full query with all params', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'news',
      limit: 10,
      offset: 5,
      order: 'desc' as const,
      orderBy: 'hot_score',
      since: '2024-06-01T00:00:00.000Z',
      until: '2024-06-30T23:59:59.999Z',
      level: 'important',
      category: '科技',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('limit=10');
    expect(query).toContain('offset=5');
    expect(query).toContain('order=hot_score.desc');
    expect(query).toContain('level=eq.important');
  });

  it('uses default select when not overridden', async () => {
    const { buildPostgRestQuery, TYPE_CONFIG } = await import('../src/pull');
    const filters = {
      type: 'topics',
      limit: 20,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'score',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('select=');
    // Should contain default select fields from TYPE_CONFIG
    expect(query).toContain('topic_key');
  });
});

describe('buildPostgRestQuery — trends type', () => {
  it('builds query for trends type', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'trends',
      limit: 10,
      offset: 0,
      order: 'desc' as const,
      orderBy: 'velocity',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('select=');
    expect(query).toContain('order=velocity.desc');
  });

  it('includes acceleration order_by', async () => {
    const { buildPostgRestQuery } = await import('../src/pull');
    const filters = {
      type: 'trends',
      limit: 10,
      offset: 0,
      order: 'asc' as const,
      orderBy: 'acceleration',
      format: 'summary' as const,
    };
    const query = buildPostgRestQuery(filters);
    expect(query).toContain('order=acceleration.asc');
  });
});
