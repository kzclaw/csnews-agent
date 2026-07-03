/**
 * CSNEWS Agent · Entity 噪音自动过滤 (v0.36.12)
 *
 * 18:22 确定:
 *   - 用 bge-m3 embedding 做 semantic type 推断
 *   - 自动化过滤噪音实体 (通用词/日期片段/数字片段)
 *   - review 工作流从'打错'变成'确认正确'
 *   - similarity >= 0.85 → noise 不写入 entity-finalized.json
 *   - similarity < 0.85 → 写入 (review 减少负担)
 *
 * 16:28 确定"0 硬编码"哲学: noise anchors 不在 const, 从 R2 持久化读
 * 5h 配额期外 review anchors 增删 (R2 entity-noise-anchors.json)
 *
 * bge-m3 走 CF Workers AI 独立池 (0 Neurons 关系)
 */
import { Env } from './shared';

export const ENTITY_NOISE_ANCHORS_R2_KEY = 'entity-noise-anchors.json';
export const NOISE_THRESHOLD_DEFAULT = 0.85;

const NOISE_ANCHORS_DEFAULT: string[] = [
  // 18:09 确定 batch incorrect 20 noise anchors
  // 17 通用词
  '回应',
  '表示',
  '工作',
  '人员',
  '媒体',
  '当地',
  '协议',
  '报道',
  '相关',
  '参与',
  '家属',
  '上市',
  '第三',
  '年初',
  '发现',
  '记者',
  '公司',
  // 2 数字片段
  '0元',
  '0万',
  // 1 日期片段 cluster-0-8 拆解
  '6月',
  '月1',
  '5日',
  '15日',
  '月15',
  '月15日',
  '6月15',
  '6月1',
];

interface NoiseAnchorsData {
  anchors: string[];
  threshold: number;
  updated_at: string;
}

/**
 * 读 R2 noise anchors (5h 配额期外 review 增删)
 */
export async function loadNoiseAnchors(env: Env): Promise<NoiseAnchorsData> {
  const obj = await env.csnews_raw.get(ENTITY_NOISE_ANCHORS_R2_KEY);
  if (!obj) {
    return {
      anchors: NOISE_ANCHORS_DEFAULT,
      threshold: NOISE_THRESHOLD_DEFAULT,
      updated_at: new Date().toISOString(),
    };
  }
  return await obj.json<NoiseAnchorsData>();
}

/**
 * 写 R2 noise anchors (review 增删入口 · 2026-07-03 entity review UX 修复)
 * 对称 loadNoiseAnchors: noise-add / noise-remove 都需要 persist
 */
export async function saveNoiseAnchors(env: Env, data: NoiseAnchorsData): Promise<void> {
  await env.csnews_raw.put(ENTITY_NOISE_ANCHORS_R2_KEY, JSON.stringify(data, null, 2));
}

/**
 * 计算 candidate vs anchors 的最大 cosine similarity
 * 返回 0-1, 越大越像 noise
 */
function maxNoiseSimilarity(candidateEmb: number[], anchorEmbs: number[][]): number {
  let max = 0;
  for (const anchorEmb of anchorEmbs) {
    if (anchorEmb.length !== candidateEmb.length) continue;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < candidateEmb.length; i++) {
      dot += candidateEmb[i] * anchorEmb[i];
      na += candidateEmb[i] * candidateEmb[i];
      nb += anchorEmb[i] * anchorEmb[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom > 0) {
      const sim = dot / denom;
      if (sim > max) max = sim;
    }
  }
  return max;
}

/**
 * 单个 cosine similarity (跟 event-threshold.ts 同款, 这里保留独立函数避免循环依赖)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * bge-m3 batch embedding
 */
export async function bgeM3BatchEmbedding(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = (await env.AI.run('@cf/baai/bge-m3', { text: texts })) as { data: number[][] };
  return result.data || [];
}

/**
 * 过滤噪音候选 (18:22 确定核心)
 *
 * @param candidates entity 候选 [{name, ...}]
 * @param candidateEmbeddings 跟 candidates 对应的 bge-m3 embedding
 * @param anchorEmbeddings noise anchors 的 bge-m3 embedding
 * @param threshold similarity 阈值 (18:22 确定 0.85 起步)
 * @returns { kept: 非 noise 候选, noise: 被过滤的 noise 候选, scores: 每个候选的 max noise similarity }
 */
export interface FilterResult<T> {
  kept: T[];
  noise: { candidate: T; max_noise_similarity: number }[];
  scores: { name: string; max_noise_similarity: number; is_noise: boolean }[];
}

export function filterNoiseCandidates<T extends { name: string }>(
  candidates: T[],
  candidateEmbeddings: number[][],
  anchorEmbeddings: number[][],
  threshold: number
): FilterResult<T> {
  const kept: T[] = [];
  const noise: { candidate: T; max_noise_similarity: number }[] = [];
  const scores: { name: string; max_noise_similarity: number; is_noise: boolean }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const emb = candidateEmbeddings[i];
    if (!emb) {
      // 0 embedding → 保守 kept (让 review 决定)
      kept.push(cand);
      scores.push({ name: cand.name, max_noise_similarity: 0, is_noise: false });
      continue;
    }
    const sim = maxNoiseSimilarity(emb, anchorEmbeddings);
    const isNoise = sim >= threshold;
    if (isNoise) {
      noise.push({ candidate: cand, max_noise_similarity: sim });
    } else {
      kept.push(cand);
    }
    scores.push({ name: cand.name, max_noise_similarity: sim, is_noise: isNoise });
  }

  return { kept, noise, scores };
}
