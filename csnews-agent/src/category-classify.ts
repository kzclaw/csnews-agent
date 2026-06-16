/**
 * CSNEWS Agent · 分类自分类 (v0.36.13 · 候选 A)
 *
 * kzclaw 18:43 确定候选 A: bge-m3 embedding 自分类
 * kzclaw 18:43 确定 #2: news title bge-m3 embed + cosine similarity 选最近类别
 *
 * 复用 entity-noise-filter.ts 80% 代码
 */
import { Env } from './shared';
import {
  loadCategorySeeds, bgeM3BatchEmbedding,
} from './category-seeds';
import { cosineSimilarity } from './entity-noise-filter';

/**
 * 自分类主函数 (kzclaw 18:43 确定候选 A 核心)
 *
 * @param title 新闻标题
 * @param env CF Workers Env
 * @returns { category, confidence, top_scores }
 */
export async function classifyBySemantic(
  title: string,
  env: Env,
): Promise<{
  category: string;
  confidence: number;
  top_scores: { category: string; score: number }[];
}> {
  if (!title || typeof title !== 'string') {
    return { category: '综合', confidence: 0, top_scores: [] };
  }

  // 1. 读 R2 seeds
  const seedsData = await loadCategorySeeds(env);
  const allSeeds: { category: string; seed: string }[] = [];
  for (const [cat, seeds] of Object.entries(seedsData.categories)) {
    for (const seed of seeds) {
      allSeeds.push({ category: cat, seed });
    }
  }
  if (allSeeds.length === 0) {
    return { category: '综合', confidence: 0, top_scores: [] };
  }

  // 2. bge-m3 batch embedding (1 次 subrequest · 复用 KR0+1 模式)
  const seedTexts = allSeeds.map((s) => s.seed);
  const seedEmbeddings = await bgeM3BatchEmbedding(env, seedTexts);

  // 3. news title embedding
  const [titleEmbedding] = await bgeM3BatchEmbedding(env, [title]);

  if (!titleEmbedding || titleEmbedding.length === 0) {
    return { category: '综合', confidence: 0, top_scores: [] };
  }

  // 4. 计算 cosine similarity · 选最大 (复用 noiseCosineSimilarity)
  const categoryScores = new Map<string, number>();
  for (let i = 0; i < allSeeds.length; i++) {
    const seedEmb = seedEmbeddings[i];
    if (!seedEmb || seedEmb.length !== titleEmbedding.length) continue;
    const sim = cosineSimilarity(titleEmbedding, seedEmb);
    const cat = allSeeds[i].category;
    // 每类取最大 similarity (任一 seed 命中即可)
    const current = categoryScores.get(cat) || 0;
    if (sim > current) categoryScores.set(cat, sim);
  }

  // 5. 排序选 top
  const topScores = Array.from(categoryScores.entries())
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);

  if (topScores.length === 0) {
    return { category: '综合', confidence: 0, top_scores: [] };
  }

  // kzclaw 18:43 确定: 分类错 → review → seeds 自更新
  // confidence < 0.3 → 综合兜底 (跟 entity-noise-filter 0 embedding 兜底一致)
  const top = topScores[0];
  const confidence = top.score;
  const category = confidence >= 0.3 ? top.category : '综合';

  return {
    category,
    confidence,
    top_scores: topScores.slice(0, 3),
  };
}