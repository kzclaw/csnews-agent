/**
 * CSNEWS Agent · 实体自学习 (v0.36.11)
 *
 * 16:28 确定: 0 硬编码, 纯自适应/自学习/自进化
 * 16:33 确定推 · bge-m3 走 CF Workers AI 独立池
 *
 * 业务流程:
 *   1. 拉 news_topic_members + news_hotspots (last 24h)
 *   2. 抽 title + summary 文本
 *   3. 提取 n-gram (2-4 字) 频率统计 (0 硬编码 = 启发式 type 推断)
 *   4. 用 bge-m3 embedding 计算与已有 entity 的相似度
 *   5. 过滤: 频率 ≥ 阈值 + 相似度 < 阈值 (跟现有 entity 不重复)
 *   6. 写 R2 entity-candidates.json (review 入口)
 *
 * 0 维护 = 系统自动跑, 只 review 错词
 * 5h 配额期哲学 = 0 Neurons (bge-m3 embedding 走 CF Workers AI 独立池)
 */
import { Env } from './shared';
import { supabaseFetch, safeJson } from './shared';
import {
  loadNoiseAnchors,
  bgeM3BatchEmbedding,
  filterNoiseCandidates,
  type FilterResult,
} from './entity-noise-filter';
import type { NewsHotspotRow, BgeEmbeddingResponse } from './types';
import { logEvent } from './log';

export interface EntityCandidate {
  uuid: string;
  name: string;
  type: 'person' | 'org' | 'place';
  frequency: number;
  sample_context: string;
  confidence: number;
  source: 'selflearn';
  first_seen: string;
}

export const ENTITY_CANDIDATES_R2_KEY = 'entity-candidates.json';
const SELFLEARN_MIN_FREQUENCY = 3;
const SELFLEARN_NGRAM_SIZES = [2, 3, 4];
export const SELFLEARN_CONFIDENCE = 0.5;
export const SELFLEARN_MAX_CANDIDATES = 50;

/**
 * 从文本中提取 n-gram 频率
 */
export function extractNgramFrequency(
  text: string,
  sizes: number[] = SELFLEARN_NGRAM_SIZES
): Map<string, number> {
  const freq = new Map<string, number>();
  if (!text) return freq;

  // split 标点 + 空白, 只保留中文 / 英文 / 数字 token
  // tokens 之间用 ' ' 隔开, 避免 "特朗普"3 字拼成 1 个 n-gram
  const tokens = text.split(/[\s\p{P}]+/u).filter((t) => /[一-鿿A-Za-z0-9]/.test(t));
  for (const tok of tokens) {
    // 单 token 内 (中文连续字符串) 算 n-gram
    for (const size of sizes) {
      for (let i = 0; i <= tok.length - size; i++) {
        const gram = tok.slice(i, i + size);
        if (/[一-鿿]/.test(gram) && gram.length >= 2) {
          freq.set(gram, (freq.get(gram) || 0) + 1);
        }
      }
    }
  }
  return freq;
}

/**
 * 合并多个文本的 n-gram 频率
 */
export function mergeNgramFrequency(freqs: Map<string, number>[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const f of freqs) {
    for (const [gram, count] of f) {
      merged.set(gram, (merged.get(gram) || 0) + count);
    }
  }
  return merged;
}

/**
 * 启发式 type 推断 (16:28 确定 0 硬编码 · 启发式 OK)
 * 含常见组织关键词 → org
 * 含常见地名关键词 → place
 * 其他 → person
 */
export function inferEntityType(gram: string): 'person' | 'org' | 'place' {
  if (/公司|集团|科技|AI|银行|学院|大学|社|局|部|委|所|院|校|厂|店|行|司|署/.test(gram))
    return 'org';
  if (/省|市|国|区|县|州|镇|村|路|街|岛|海|河|山|湖|港|城|都|府/.test(gram)) return 'place';
  return 'person';
}

/**
 * 过滤低质量 n-gram (纯标点 / 纯空白 / 长度异常)
 */
export function isValidGram(gram: string): boolean {
  if (gram.length < 2 || gram.length > 8) return false;
  if (!/[\u4e00-\u9fa5]/.test(gram)) return false;
  if (/^[\s\p{P}]+$/u.test(gram)) return false;
  return true;
}

/**
 * 生成 UUID v4 (纯数学, 0 依赖)
 */
export function generateUuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 从 news_topic_members 拉 last N hours news
 */
async function fetchRecentNewsTitles(
  env: Env,
  sinceHours: number = 24
): Promise<{ id: string; text: string }[]> {
  const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const res = await supabaseFetch(
    env,
    `/rest/v1/news_hotspots?select=id,title,summary&created_at=gte.${sinceIso}&order=created_at.desc&limit=200`
  );
  const news = ((await safeJson(res)) as NewsHotspotRow[]) || [];
  return news
    .map((n) => ({
      id: n.id,
      text: `${n.title || ''} ${n.summary || ''}`.trim(),
    }))
    .filter((n) => n.text.length > 0);
}

/**
 * bge-m3 embedding (CF Workers AI 独立池, 0 Neurons 关系)
 */
async function bgeM3Embedding(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
  const result = (await env.AI.run('@cf/baai/bge-m3', { text: texts })) as BgeEmbeddingResponse;
  return result.data ? result.data.map((item) => item.embedding ?? []) : [];
}

/**
 * 余弦相似度
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
 * 读 R2 已有 entity-candidates.json (review 后的实体)
 */
async function loadExistingCandidates(env: Env): Promise<EntityCandidate[]> {
  try {
    const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
    if (!obj) return [];
    const json = await obj.json<{ candidates: EntityCandidate[] }>();
    return json.candidates || [];
  } catch {
    return [];
  }
}

/**
 * 主函数: 自学习 (5h 配额期可推, 1-2 min 跑完)
 */
export async function runEntitySelfLearn(env: Env): Promise<{
  candidates: EntityCandidate[];
  total: number;
  embedded: number;
  noise_filtered: number;
  noise_anchors_count: number;
}> {
  try {
    const news = await fetchRecentNewsTitles(env, 24);
    if (news.length === 0) {
      return { candidates: [], total: 0, embedded: 0, noise_filtered: 0, noise_anchors_count: 0 };
    }

    // n-gram 频率统计
    const freqs = news.map((n) => extractNgramFrequency(n.text));
    const merged = mergeNgramFrequency(freqs);

    // 过滤: 频率 ≥ 阈值 + 合法 gram
    const filtered: { gram: string; count: number }[] = [];
    for (const [gram, count] of merged) {
      if (count < SELFLEARN_MIN_FREQUENCY) continue;
      if (!isValidGram(gram)) continue;
      filtered.push({ gram, count });
    }
    filtered.sort((a, b) => b.count - a.count);

    const candidateGrams = filtered.slice(0, SELFLEARN_MAX_CANDIDATES).map((f) => f.gram);
    if (candidateGrams.length === 0) {
      return {
        candidates: [],
        total: news.length,
        embedded: 0,
        noise_filtered: 0,
        noise_anchors_count: 0,
      };
    }

    // bge-m3 embedding 候选词 (batch, 0 Neurons)
    const embeddings = await bgeM3Embedding(env, candidateGrams);

    // 跟已有 candidates 比相似度 (去重)
    const existing = await loadExistingCandidates(env);
    const existingEmbeddings =
      existing.length > 0
        ? await bgeM3Embedding(
            env,
            existing.slice(0, 50).map((c) => c.name)
          )
        : [];

    // semantic noise anchor filtering (18:22 确定: similarity >= 0.85 → noise)
    const noiseAnchorsData = await loadNoiseAnchors(env);
    const anchorEmbeddings =
      noiseAnchorsData.anchors.length > 0
        ? await bgeM3Embedding(env, noiseAnchorsData.anchors)
        : [];

    // 启发式 type 推断 + 过滤重复 + noise filter
    const dedupCandidates: { gram: string; count: number }[] = [];
    const usedGrams = new Set<string>();

    for (let i = 0; i < candidateGrams.length; i++) {
      const gram = candidateGrams[i];
      const emb = embeddings[i];
      if (!emb) continue;

      // 跟已有 entity 比相似度
      let isDuplicate = false;
      for (let j = 0; j < existingEmbeddings.length; j++) {
        const sim = cosineSimilarity(emb, existingEmbeddings[j]);
        if (sim > 0.85) {
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) continue;
      if (usedGrams.has(gram)) continue;
      usedGrams.add(gram);

      dedupCandidates.push({ gram, count: filtered[i].count });
    }

    // noise filter (18:22 确定)
    // 转换 dedupCandidates 到 filter function 期望的 shape {name, count}
    const dedupForFilter = dedupCandidates.map((c) => ({ name: c.gram, count: c.count }));
    const dedupEmbs = dedupForFilter.map((c) => {
      const idx = candidateGrams.indexOf(c.name);
      return embeddings[idx];
    });
    const filterResult = filterNoiseCandidates(
      dedupForFilter,
      dedupEmbs,
      anchorEmbeddings,
      noiseAnchorsData.threshold
    );

    // 构造最终 candidates (review 入口) + noise 数组 (review 实战参考)
    const sampleText = news[0].text.slice(0, 200);
    const candidates: EntityCandidate[] = filterResult.kept
      .sort((a, b) => b.count - a.count)
      .map((c) => ({
        uuid: generateUuidV4(),
        name: c.name,
        type: inferEntityType(c.name),
        frequency: c.count,
        sample_context: sampleText,
        confidence: SELFLEARN_CONFIDENCE,
        source: 'selflearn' as const,
        first_seen: new Date().toISOString(),
      }));

    const noiseCandidates: EntityCandidate[] = filterResult.noise.map((n) => ({
      uuid: generateUuidV4(),
      name: n.candidate.name,
      type: inferEntityType(n.candidate.name),
      frequency: n.candidate.count,
      sample_context: sampleText,
      confidence: SELFLEARN_CONFIDENCE,
      source: 'selflearn' as const,
      first_seen: new Date().toISOString(),
    }));

    // 写 R2 entity-candidates.json (review 入口 · 含 noise 分组)
    await env.csnews_raw.put(
      ENTITY_CANDIDATES_R2_KEY,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          total_news: news.length,
          noise_threshold: noiseAnchorsData.threshold,
          noise_anchors_count: noiseAnchorsData.anchors.length,
          candidates,
          noise: noiseCandidates,
          noise_scores: filterResult.scores,
        },
        null,
        2
      )
    );

    return {
      candidates,
      total: news.length,
      embedded: candidateGrams.length,
      noise_filtered: noiseCandidates.length,
      noise_anchors_count: noiseAnchorsData.anchors.length,
    };
  } catch (e: any) {
    await logEvent(env, 'error', `[entity-selflearn] failed: ${e?.message || e}`, undefined, 'entity');
    return { candidates: [], total: 0, embedded: 0, noise_filtered: 0, noise_anchors_count: 0 };
  }
}
