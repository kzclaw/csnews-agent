/**
 * CSNEWS Agent · Category Seeds 自学习 (v0.36.13 · 候选 A)
 *
 * 18:43 确定候选 A: 用 bge-m3 embedding 自分类
 * 18:43 确定 #1 + #4: 0 硬编码类别 (类别名和 seeds 都从 R2 读)
 *
 * 复用 entity-noise-filter.ts 80% 模式 (R2 持久化 + bge-m3 batch)
 *
 * 自进化闭环 (18:43 确定 #3):
 *   - 分类错 review → seeds 自动更新 (addSeedToCategory)
 *   - 0 Neurons 消耗 (bge-m3 走 CF Workers AI 独立池)
 */
import { Env } from './shared';

export const CATEGORY_SEEDS_R2_KEY = 'category-seeds.json';

/**
 * 默认 10 类 × 5 代表词 = 50 seeds fallback
 * (18:43 确定 0 硬编码 = R2 持久化是主路径, 这是 R2 不存在时的 fallback)
 * (5h 配额期外 review R2 增删 seeds 即可生效, 0 维护成本)
 */
const DEFAULT_CATEGORY_SEEDS: Record<string, string[]> = {
  科技: ['人工智能发布', '开源代码', '芯片量产', '算法升级', '技术突破'],
  财经: ['股市涨跌', '汇率波动', '央行利率', '财报数据', 'GDP 增长'],
  国际: ['外交峰会', '联合国决议', '制裁措施', '军事演习', '贸易协定'],
  社会: ['交通事故', '疫情防控', '自然灾害', '食品安全', '教育改革'],
  娱乐: ['电影首映', '演唱会', '颁奖典礼', '综艺官宣', '明星绯闻'],
  体育: ['世界杯决赛', '奥运会', 'NBA 总决赛', '欧冠比赛', '中超联赛'],
  房产: ['房价涨跌', '限购政策', '房贷利率', '土拍成交', '楼盘交付'],
  汽车: ['新能源车', '自动驾驶', '汽车召回', '新车发布', '碰撞测试'],
  消费: ['电商促销', '涨价', '食品安全', '购物节', '海淘代购'],
  法律: ['法院判决', '警方通报', '检方公诉', '立法修改', '司法解释'],
};

interface CategorySeedsData {
  categories: Record<string, string[]>;
  updated_at: string;
  updated_count: number;
}

/**
 * 读 R2 category-seeds.json (5h 配额期外 review 增删)
 */
export async function loadCategorySeeds(env: Env): Promise<CategorySeedsData> {
  const obj = await env.csnews_raw.get(CATEGORY_SEEDS_R2_KEY);
  if (!obj) {
    // deep clone DEFAULT_CATEGORY_SEEDS 防止模块级 const 被 mutate
    const cloned: Record<string, string[]> = {};
    for (const [cat, seeds] of Object.entries(DEFAULT_CATEGORY_SEEDS)) {
      cloned[cat] = [...seeds];
    }
    return {
      categories: cloned,
      updated_at: new Date().toISOString(),
      updated_count: 0,
    };
  }
  return await obj.json<CategorySeedsData>();
}

/**
 * 持久化到 R2
 */
export async function saveCategorySeeds(env: Env, data: CategorySeedsData): Promise<void> {
  await env.csnews_raw.put(CATEGORY_SEEDS_R2_KEY, JSON.stringify(data, null, 2));
}

/**
 * bge-m3 batch embedding (复用 entity-noise-filter 同款)
 */
export async function bgeM3BatchEmbedding(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = (await env.AI.run('@cf/baai/bge-m3', { text: texts })) as { data: number[][] };
  return result.data || [];
}

/**
 * review: 分类错 → 加 seed 到正确类别
 * (18:43 确定 #3 自进化闭环)
 */
export async function addSeedToCategory(
  env: Env,
  category: string,
  seed: string
): Promise<CategorySeedsData> {
  const data = await loadCategorySeeds(env);
  if (!data.categories[category]) {
    data.categories[category] = [];
  }
  if (!data.categories[category].includes(seed)) {
    data.categories[category].push(seed);
    data.updated_count++;
  }
  data.updated_at = new Date().toISOString();
  await saveCategorySeeds(env, data);
  return data;
}

/**
 * review: 删 seed (噪音 seed 错误)
 */
export async function removeSeedFromCategory(
  env: Env,
  category: string,
  seed: string
): Promise<CategorySeedsData> {
  const data = await loadCategorySeeds(env);
  if (data.categories[category]) {
    const idx = data.categories[category].indexOf(seed);
    if (idx >= 0) {
      data.categories[category].splice(idx, 1);
      data.updated_count++;
    }
  }
  data.updated_at = new Date().toISOString();
  await saveCategorySeeds(env, data);
  return data;
}
