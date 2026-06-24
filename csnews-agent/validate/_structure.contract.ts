/**
 * Business contract tests for pull.ts type interfaces and query builders.
 * Verifies that exported types and interfaces match the expected shape.
 */

import type {
  TypeConfig,
  ParsedFilters,
  PullResponse,
  Format,
} from '../src/pull';
import { TYPE_CONFIG } from '../src/pull';
import { createMockUrl } from '../test-helpers';
import { parseFilters } from '../src/pull';

describe('pull.ts exported types', () => {
  describe('TypeConfig shape', () => {
    it('has all required fields', () => {
      const config: TypeConfig = {
        table: 'news_hotspots',
        defaultOrderBy: 'created_at',
        allowedOrderBy: ['created_at', 'published_at'],
        defaultSelect: 'id, title',
        allowedFilters: ['level', 'category'],
        timeField: 'created_at',
      };
      expect(config.table).toBe('news_hotspots');
      expect(config.defaultOrderBy).toBe('created_at');
      expect(Array.isArray(config.allowedOrderBy)).toBe(true);
      expect(typeof config.defaultSelect).toBe('string');
      expect(Array.isArray(config.allowedFilters)).toBe(true);
      expect(config.timeField).toBe('created_at');
    });
  });

  describe('ParsedFilters shape', () => {
    it('has all required fields', () => {
      const filters: ParsedFilters = {
        type: 'news',
        limit: 20,
        order: 'desc',
        orderBy: 'created_at',
        format: 'summary',
      };
      expect(filters.type).toBe('news');
      expect(filters.limit).toBe(20);
      expect(filters.order).toMatch(/^(asc|desc)$/);
      expect(typeof filters.orderBy).toBe('string');
      expect(filters.format).toMatch(/^(ids|summary|full)$/);
    });

    it('accepts all optional fields', () => {
      const filters: ParsedFilters = {
        type: 'news',
        limit: 10,
        offset: 5,
        order: 'asc',
        orderBy: 'hot_score',
        since: '2024-01-01T00:00:00.000Z',
        until: '2024-12-31T23:59:59.999Z',
        level: 'important',
        category: '科技',
        topicId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'open',
        stage: 'emerging',
        fissionTriggered: true,
        titleLike: 'AI',
        select: 'id, title',
        format: 'full',
      };
      expect(filters.offset).toBe(5);
      expect(filters.level).toBe('important');
      expect(filters.topicId).toMatch(/^[0-9a-f-]+$/i);
      expect(filters.fissionTriggered).toBe(true);
      expect(filters.titleLike).toBe('AI');
    });
  });

  describe('PullResponse shape', () => {
    it('has all required fields', () => {
      const response: PullResponse = {
        type: 'news',
        count: 0,
        total: 0,
        truncated: false,
        filters: {},
        items: [],
      };
      expect(response.type).toBe('news');
      expect(response.count).toBe(0);
      expect(response.total).toBe(0);
      expect(response.truncated).toBe(false);
      expect(Array.isArray(response.filters)).toBe(false);
      expect(Array.isArray(response.items)).toBe(true);
    });
  });

  describe('Format type', () => {
    it('covers all valid format values', () => {
      const formats: Format[] = ['ids', 'summary', 'full'];
      expect(formats).toContain('ids');
      expect(formats).toContain('summary');
      expect(formats).toContain('full');
    });
  });
});

describe('pull.ts TYPE_CONFIG coverage', () => {
  it('news type has correct allowedOrderBy', () => {
    expect(TYPE_CONFIG.news.allowedOrderBy).toContain('created_at');
    expect(TYPE_CONFIG.news.allowedOrderBy).toContain('hot_score');
  });

  it('topics type has correct allowedOrderBy', () => {
    expect(TYPE_CONFIG.topics.allowedOrderBy).toContain('score');
    expect(TYPE_CONFIG.topics.allowedOrderBy).toContain('last_active_at');
  });

  it('warnings type has correct allowedOrderBy', () => {
    expect(TYPE_CONFIG.warnings.allowedOrderBy).toContain('severity');
  });

  it('trends type has correct allowedOrderBy', () => {
    expect(TYPE_CONFIG.trends.allowedOrderBy).toContain('velocity');
    expect(TYPE_CONFIG.trends.allowedOrderBy).toContain('acceleration');
  });

  it('entity type is R2-backed with correct defaults', () => {
    expect(TYPE_CONFIG.entity.table).toBe('__r2__');
    expect(TYPE_CONFIG.entity.allowedOrderBy).toContain('confidence');
    expect(TYPE_CONFIG.entity.allowedOrderBy).toContain('mention_count');
  });

  it('fission-pending has no allowedFilters', () => {
    expect(TYPE_CONFIG['fission-pending'].allowedFilters).toHaveLength(0);
  });

  it('stats has no allowedFilters', () => {
    expect(TYPE_CONFIG.stats.allowedFilters).toHaveLength(0);
  });
});

describe('score.ts exported functions', () => {
  it('scoreRule is a function with correct signature', async () => {
    const { scoreRule } = await import('../src/score');
    const result = scoreRule('AI models achieve breakthrough performance');
    expect(typeof result).toBe('object');
    expect(typeof result.score).toBe('number');
    expect(typeof result.reason).toBe('string');
    expect(typeof result.isHigh).toBe('boolean');
  });

  it('hashStr is a function with correct signature', async () => {
    const { hashStr } = await import('../src/score');
    expect(typeof hashStr).toBe('function');
    expect(typeof hashStr('test')).toBe('number');
  });
});

describe('classify.ts exported functions', () => {
  it('classifyRule is a function returning a string', async () => {
    const { classifyRule } = await import('../src/classify');
    expect(typeof classifyRule).toBe('function');
    expect(typeof classifyRule('OpenAI releases new model')).toBe('string');
  });
});

describe('dispatch.ts exported constants', () => {
  it('ALLOWED_ACTIONS is a non-empty readonly tuple', async () => {
    const { ALLOWED_ACTIONS } = await import('../src/dispatch');
    expect(Array.isArray(ALLOWED_ACTIONS)).toBe(true);
    expect(ALLOWED_ACTIONS.length).toBeGreaterThan(0);
    expect(ALLOWED_ACTIONS).toContain('pull');
    expect(ALLOWED_ACTIONS).toContain('ping');
    expect(ALLOWED_ACTIONS).toContain('score');
    expect(ALLOWED_ACTIONS).toContain('classify');
  });

  it('DEFAULT_ACTION is a valid action string', async () => {
    const { DEFAULT_ACTION, ALLOWED_ACTIONS } = await import('../src/dispatch');
    expect(ALLOWED_ACTIONS).toContain(DEFAULT_ACTION);
  });

  it('dispatchAction is a function', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    expect(typeof dispatchAction).toBe('function');
  });

  it('handleCorsPreflight is a function', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    expect(typeof handleCorsPreflight).toBe('function');
  });
});
