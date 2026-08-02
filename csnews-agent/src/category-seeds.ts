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
 * v0.37.88: 每类样板词上限 (满了顶最旧)
 */
export const CATEGORY_SEED_MAX = 20;

/**
 * v0.37.88: 摘要提炼去废话词 (0 成本规则 · 不用 LLM)
 * 按标点切段 → 去停用词 → 留最长核心段 → 截断
 */
const STOPWORD_RE = /(的|了|是|在|与|和|及|或|等|表示|报道|称|记者|消息|今日|昨天|近日|今天|昨日|已经|正在|将|会|能|要|被|把|给|对|从|于|中|上|下|为|向|以|这|那|该|此|也|还|都|就|又|而|但|并|其|随着|通过|由于|因为|所以|目前|日前|此前|今日)/g;

/**
 * v0.37.88: 学正例 — 从标题 + 摘要提炼样板词
 * 规则: 标题原文 (最多 1 条) + 摘要按标点切段 → 去停用词 → 去重/去标题重复 → 截断 (最多 3 条)
 * 兜底: 摘要提炼失败只返回标题
 */
export function extractSeedKeywords(title: string, summary?: string | null): string[] {
  const out: string[] = [];
  const t = (title || '').trim();
  if (t) out.push(t.slice(0, 60));
  const s = (summary || '').trim();
  if (!s) return out;
  const segments = s
    .split(/[。！？；，,、\s\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
  const seen = new Set(out);
  for (const seg of segments) {
    const cleaned = seg.replace(STOPWORD_RE, '').trim();
    if (cleaned.length < 4) continue;
    const final = cleaned.slice(0, 30);
    if (seen.has(final)) continue;
    // 跟标题重叠太多视为废话 (标题已作 seed)
    if (t.includes(final) || final.includes(t.slice(0, 12))) continue;
    out.push(final);
    seen.add(final);
    if (out.length >= 3) break;
  }
  return out;
}

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
 * review: 分类错 → 加 seed 到正确类别
 * (18:43 确定 #3 自进化闭环)
 * v0.37.88: 每类上限 CATEGORY_SEED_MAX (满了顶最旧) + 去重已有
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
    // v0.37.88: 满顶最旧 (FIFO)
    if (data.categories[category].length >= CATEGORY_SEED_MAX) {
      data.categories[category].shift();
    }
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
