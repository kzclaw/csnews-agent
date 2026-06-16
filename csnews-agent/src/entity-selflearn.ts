/**
 * CSNEWS Agent · 实体自学习 (v0.36.11)
 *
 * kzclaw 16:28 确定: 0 硬编码, 纯自适应/自学习/自进化
 * kzclaw 16:33 确定推 · bge-m3 走 CF Workers AI 独立池
 *
 * 业务流程:
 *   1. 拉 news_topic_members + news_hotspots (last 24h)
 *   2. 抽 title + summary 文本
 *   3. 提取 n-gram (2-4 字) 频率统计 (kzclaw 0 硬编码 = 启发式 type 推断)
 *   4. 用 bge-m3 embedding 计算与已有 entity 的相似度
 *   5. 过滤: 频率 ≥ 阈值 + 相似度 < 阈值 (跟现有 entity 不重复)
 *   6. 写 R2 entity-candidates.json (kzclaw review)
 *
 * kzclaw 0 维护 = 系统自动跑, kzclaw只 review 错词
 * kzclaw 5h 配额期哲学 = 0 Neurons (bge-m3 embedding 走 CF Workers AI 独立池, 跟 KR0+1 MiniMax 0 关系)
 */
import { Env } from './shared';
import { supabaseFetch, safeJson } from './shared';

export interface EntityCandidate {
  name: string;
  type: 'person' | 'org' | 'place';
  frequency: number;
  sample_context: string;
  confidence: number;
  source: 'selflearn';
  first_seen: string;
}

export const ENTITY_CANDIDATES_R2_KEY = 'entity-candidates.json';
export const SELFLEARN_MIN_FREQUENCY = 3;
export const SELFLEARN_NGRAM_SIZES = [2, 3, 4];
export const SELFLEARN_CONFIDENCE = 0.5;
export const SELFLEARN_MAX_CANDIDATES = 50;
export const SELFLEARN_BATCH_SIZE = 50;

/**
 * 从文本中提取 n-gram 频率
 */
export function extractNgramFrequency(text: string, sizes: number[] = SELFLEARN_NGRAM_SIZES): Map<string, number> {
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
 * 启发式 type 推断 (kzclaw 16:28 确定 0 硬编码 · 启发式 OK)
 * 含常见组织关键词 → org
 * 含常见地名关键词 → place
 * 其他 → person
 */
export function inferEntityType(gram: string): 'person' | 'org' | 'place' {
  if (/公司|集团|科技|AI|银行|学院|大学|社|局|部|委|所|院|校|厂|店|行|司|署/.test(gram)) return 'org';
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
 * 从 news_topic_members 拉 last N hours news
 */
async function fetchRecentNewsTitles(env: Env, sinceHours: number = 24): Promise<{ id: string; text: string }[]> {
  const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const res = await supabaseFetch(
    env,
    `/rest/v1/news_hotspots?select=id,title,summary&created_at=gte.${sinceIso}&order=created_at.desc&limit=200`,
  );
  const news = (await safeJson(res) as any[]) || [];
  return news
    .map((n) => ({
      id: n.id,
      text: `${n.title || ''} ${n.summary || ''}`.trim(),
    }))
    .filter((n) => n.text.length > 0);
}

/**
 * bge-m3 embedding (CF Workers AI 独立池, 0 kzclaw KR0+1 Neurons 关系)
 */
async function bgeM3Embedding(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = (await env.AI.run('@cf/baai/bge-m3', { text: texts })) as { data: number[][] };
  return result.data || [];
}

/**
 * 余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * 读 R2 已有 entity-candidates.json (kzclaw review 后的实体)
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
 * 主函数: 自学习 (kzclaw 5h 配额期可推, 1-2 min 跑完)
 */
export async function runEntitySelfLearn(env: Env): Promise<{ candidates: EntityCandidate[]; total: number; embedded: number }> {
  try {
    const news = await fetchRecentNewsTitles(env, 24);
    if (news.length === 0) {
      return { candidates: [], total: 0, embedded: 0 };
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
      return { candidates: [], total: news.length, embedded: 0 };
    }

    // bge-m3 embedding 候选词 (batch, 0 Neurons kzclaw 5h 配额期 0 关系)
    const embeddings = await bgeM3Embedding(env, candidateGrams);

    // 跟已有 candidates 比相似度 (去重)
    const existing = await loadExistingCandidates(env);
    const existingEmbeddings = existing.length > 0
      ? await bgeM3Embedding(env, existing.slice(0, 50).map((c) => c.name))
      : [];

    // 启发式 type 推断 + 过滤重复
    const candidates: EntityCandidate[] = [];
    const sampleText = news[0].text.slice(0, 200);
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

      candidates.push({
        name: gram,
        type: inferEntityType(gram),
        frequency: filtered[i].count,
        sample_context: sampleText,
        confidence: SELFLEARN_CONFIDENCE,
        source: 'selflearn',
        first_seen: new Date().toISOString(),
      });
    }

    // 按 frequency 倒序
    candidates.sort((a, b) => b.frequency - a.frequency);

    // 写 R2 entity-candidates.json
    await env.csnews_raw.put(ENTITY_CANDIDATES_R2_KEY, JSON.stringify({
      generated_at: new Date().toISOString(),
      total_news: news.length,
      candidates,
    }, null, 2));

    return { candidates, total: news.length, embedded: candidateGrams.length };
  } catch (e: any) {
    console.error(`[entity-selflearn] failed: ${e?.message || e}`);
    return { candidates: [], total: 0, embedded: 0 };
  }
}
