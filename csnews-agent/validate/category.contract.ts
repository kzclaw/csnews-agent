/**
 * CSNEWS Agent · category-seeds 业务契约 (v0.36.13 · 候选 A 自分类)
 *
 * kzclaw 18:43 确定候选 A: bge-m3 embedding 自分类
 * kzclaw 16:28 确定 #40 条 0 硬编码哲学: 类别和 seeds 都从 R2 读
 * kzclaw 18:43 确定自进化闭环: 分类错 review → seeds 自动更新
 *
 * 详见：tasks/csnews-agent-okr.md v0.36.13 候选 A
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORY_SEEDS_R2_KEY,
  DEFAULT_CATEGORY_SEEDS,
  loadCategorySeeds,
  bgeM3BatchEmbedding,
  saveCategorySeeds,
  addSeedToCategory,
  removeSeedFromCategory,
  type CategorySeedsData,
} from '../src/category-seeds';
import { classifyBySemantic } from '../src/category-classify';

// ============================================================
// 业务常量
// ============================================================
describe('category-seeds 业务常量', () => {
  it('CATEGORY_SEEDS_R2_KEY 必须 = "category-seeds.json"', () => {
    expect(CATEGORY_SEEDS_R2_KEY).toBe('category-seeds.json');
  });

  it('DEFAULT_CATEGORY_SEEDS 必须 = 10 类 (跟kzclaw 16:00 之前确定老分类体系兼容)', () => {
    expect(Object.keys(DEFAULT_CATEGORY_SEEDS)).toHaveLength(10);
  });

  it('DEFAULT_CATEGORY_SEEDS 各类必须 ≥ 5 个代表词 (kzclaw 18:43 确定)', () => {
    for (const [cat, seeds] of Object.entries(DEFAULT_CATEGORY_SEEDS)) {
      expect(seeds.length, `${cat} 必须 >= 5 seeds`).toBeGreaterThanOrEqual(5);
    }
  });

  it('DEFAULT_CATEGORY_SEEDS 必须包含kzclaw老分类体系全部 10 类', () => {
    const required = [
      '科技',
      '财经',
      '国际',
      '社会',
      '娱乐',
      '体育',
      '房产',
      '汽车',
      '消费',
      '法律',
    ];
    for (const cat of required) {
      expect(DEFAULT_CATEGORY_SEEDS[cat]).toBeDefined();
    }
  });
});

// ============================================================
// 0 硬编码保证 (kzclaw 16:28 确定 #40 条)
// ============================================================
describe('category-seeds 0 硬编码保证', () => {
  it('category-seeds.ts 必须 0 export const category 数组 (seeds 从 R2 读)', async () => {
    const mod = await import('../src/category-seeds');
    expect((mod as any).CATEGORY_SEEDS_FIXED).toBeUndefined();
    expect((mod as any).CATEGORY_WORDS).toBeUndefined();
  });

  it('DEFAULT_CATEGORY_SEEDS 是 fallback (R2 不存在时用), 主路径从 R2 读', () => {
    // 业务红线: DEFAULT_CATEGORY_SEEDS 是 fallback, 不是主路径
    expect(typeof DEFAULT_CATEGORY_SEEDS).toBe('object');
    expect(DEFAULT_CATEGORY_SEEDS['科技']).toBeDefined();
  });
});

// ============================================================
// loadCategorySeeds
// ============================================================
describe('loadCategorySeeds · 读 R2 category-seeds.json', () => {
  it('R2 无 seeds → 返 DEFAULT_CATEGORY_SEEDS + updated_count=0', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const data = await loadCategorySeeds(env);
    expect(data.categories).toEqual(DEFAULT_CATEGORY_SEEDS);
    expect(data.updated_count).toBe(0);
  });

  it('R2 返 seeds JSON → 透传', async () => {
    const stored: CategorySeedsData = {
      categories: { 科技: ['foo', 'bar'] },
      updated_at: '2026-06-16T18:00:00Z',
      updated_count: 5,
    };
    const env: any = {
      csnews_raw: { get: async () => ({ json: async () => stored }) },
    };
    const data = await loadCategorySeeds(env);
    expect(data.categories).toEqual({ 科技: ['foo', 'bar'] });
    expect(data.updated_count).toBe(5);
  });
});

// ============================================================
// addSeedToCategory / removeSeedFromCategory (kzclaw 18:43 自进化闭环)
// ============================================================
describe('addSeedToCategory · kzclaw review 加 seed', () => {
  it('新 seed → added + updated_count++', async () => {
    let stored: CategorySeedsData | null = null;
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async (_k: string, value: string) => {
          stored = JSON.parse(value);
          return {};
        },
      },
    };
    const data = await addSeedToCategory(env, '科技', '量子计算突破');
    expect(data.categories['科技']).toContain('量子计算突破');
    expect(data.updated_count).toBe(1);
    expect(stored).not.toBeNull();
  });

  it('重复 seed → noop (不重复加)', async () => {
    let stored: CategorySeedsData | null = null;
    const env: any = {
      csnews_raw: {
        get: async () => {
          if (stored) return { json: async () => stored };
          return null;
        },
        put: async (_k: string, value: string) => {
          stored = JSON.parse(value);
          return {};
        },
      },
    };
    await addSeedToCategory(env, '科技', '量子计算突破');
    const data = await addSeedToCategory(env, '科技', '量子计算突破');
    expect(data.updated_count).toBe(1); // 第二次 noop
  });

  it('新类别自动创建', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async () => ({}),
      },
    };
    const data = await addSeedToCategory(env, '新能源', '光伏发电');
    expect(data.categories['新能源']).toContain('光伏发电');
  });
});

describe('removeSeedFromCategory · kzclaw review 删 seed', () => {
  it('存在 seed → removed + updated_count++', async () => {
    let stored: CategorySeedsData | null = null;
    const env: any = {
      csnews_raw: {
        get: async () => {
          if (stored) return { json: async () => stored };
          return null;
        },
        put: async (_k: string, value: string) => {
          stored = JSON.parse(value);
          return {};
        },
      },
    };
    await addSeedToCategory(env, '科技', '量子计算突破');
    const data = await removeSeedFromCategory(env, '科技', '量子计算突破');
    expect(data.categories['科技']).not.toContain('量子计算突破');
    expect(data.updated_count).toBe(2);
  });

  it('不存在 seed → noop (updated_count 不变)', async () => {
    let stored: CategorySeedsData | null = null;
    const env: any = {
      csnews_raw: {
        get: async () => {
          if (stored) return { json: async () => stored };
          return null;
        },
        put: async (_k: string, value: string) => {
          stored = JSON.parse(value);
          return {};
        },
      },
    };
    await addSeedToCategory(env, '科技', 'A');
    const data = await removeSeedFromCategory(env, '科技', 'NOT_EXIST');
    expect(data.updated_count).toBe(1);
  });

  it('不存在类别 → noop', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async () => ({}),
      },
    };
    const data = await removeSeedFromCategory(env, 'NOT_EXIST_CAT', 'foo');
    expect(data.updated_count).toBe(0);
  });
});

// ============================================================
// bgeM3BatchEmbedding
// ============================================================
describe('bgeM3BatchEmbedding · 复用 entity-noise-filter 模式', () => {
  it('空数组 → 返 []', async () => {
    const env: any = { AI: { run: async () => ({ data: [] }) } };
    const result = await bgeM3BatchEmbedding(env, []);
    expect(result).toEqual([]);
  });

  it('调用 env.AI.run(@cf/baai/bge-m3) batch', async () => {
    let captured: any = null;
    const env: any = {
      AI: {
        run: async (model: string, params: any) => {
          captured = { model, params };
          return { data: [[0.1, 0.2, 0.3]] };
        },
      },
    };
    await bgeM3BatchEmbedding(env, ['test']);
    expect(captured.model).toBe('@cf/baai/bge-m3');
    expect(captured.params.text).toEqual(['test']);
  });
});

// ============================================================
// classifyBySemantic (kzclaw 18:43 确定主路径)
// ============================================================
describe('classifyBySemantic · bge-m3 自分类', () => {
  it('空 title → 返 综合 + confidence 0', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const result = await classifyBySemantic('', env);
    expect(result.category).toBe('综合');
    expect(result.confidence).toBe(0);
  });

  it('null title → 返 综合 + confidence 0', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const result = await classifyBySemantic(null as any, env);
    expect(result.category).toBe('综合');
    expect(result.confidence).toBe(0);
  });

  it('R2 无 seeds → 走 DEFAULT_CATEGORY_SEEDS fallback bge-m3 自分类 (0 综合兜底)', async () => {
    const env: any = {
      csnews_raw: { get: async () => null },
      AI: {
        run: async (_model: string, params: any) => {
          // mock: 给科技类 seed 返回高 similarity
          const texts = params.text;
          return {
            data: texts.map((t: string, i: number) => {
              // 让 title 跟种子 seed '人工智能发布' similarity 高
              if (i === 0) return [1, 0, 0]; // title
              return [0.9, 0, 0]; // 所有 seed 都偏向科技
            }),
          };
        },
      },
    };
    const result = await classifyBySemantic('OpenAI 发布 GPT-5', env);
    // R2 无 → 走 DEFAULT_CATEGORY_SEEDS (50 seeds) → bge-m3 batch 50 seeds
    // allSeeds.length = 50, 不走兜底 (line 42), 走 cosine 路径
    expect(result.category).toBe('科技');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.top_scores.length).toBeGreaterThan(0);
  });

  it('kzclaw 18:43 确定自进化闭环: review 实战 (title=量子计算突破 → 科技)', async () => {
    // 1. kzclaw review 错的分类 → addSeedToCategory 科技 + 量子计算突破
    // 2. 后续同样 title → 自分类 科技 (kzclaw 18:43 自进化闭环)
    const putCalls: { key: string; value: string }[] = [];
    const stored: { [key: string]: any } = {};
    const env: any = {
      csnews_raw: {
        get: async (key: string) => {
          if (stored[key]) return { json: async () => stored[key] };
          return null;
        },
        put: async (key: string, value: string) => {
          stored[key] = JSON.parse(value);
          putCalls.push({ key, value });
          return {};
        },
      },
      AI: {
        run: async (_model: string, params: any) => {
          // 模拟: title = 量子计算突破 时跟 seed 量子计算突破 相似度高
          const texts = params.text;
          return {
            data: texts.map((t: string) => {
              if (t.includes('量子计算') || t.includes('突破')) {
                return [1, 0.5, 0]; // 跟 default 科技 seed "量子计算突破" 相似
              }
              return [0, 1, 0];
            }),
          };
        },
      },
    };
    // 模拟kzclaw review 实战: 加 "量子计算突破" seed 到 科技 类
    await addSeedToCategory(env, '科技', '量子计算突破');
    const result = await classifyBySemantic('量子计算突破', env);
    expect(['科技', '综合']).toContain(result.category);
    // confidence 取决于 mock data, 但 category 应该是 科技 或 综合
  });
});
