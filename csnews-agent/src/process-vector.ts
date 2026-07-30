// ============================================================
// Vector processing — ZAKER fetch, bge-m3 embedding, similarity search
// ============================================================

import { Env } from './shared';
import { recordAiCall, computeNeurons } from './ai-budget';
import { findSimilarNews } from './news-process';
import type {
  BgeEmbeddingResponse,
  ZakerArticle,
  ZakerHotResponse,
  SimilarNewsItem,
} from './types';

const ZAKER_HOT_URL = 'https://skills.myzaker.com/api/v1/article/hot?v=1.0.3';
const ZAKER_TIMEOUT_MS = 10_000;

/** Fetch hot articles from ZAKER API. Returns empty array on failure. */
export async function fetchZakerHot(): Promise<ZakerArticle[]> {
  try {
    const r = await fetch(ZAKER_HOT_URL, {
      signal: AbortSignal.timeout(ZAKER_TIMEOUT_MS),
    });
    const json = (await r.json()) as ZakerHotResponse;
    return json?.data?.list || [];
  } catch {
    return [];
  }
}

/**
 * Generate bge-m3 embedding for a news item.
 * Concatenates title + summary when both present so the vector captures
 * both the headline angle and the body detail — News Self Growth
 * topic clustering benefits from the extra semantic signal.
 *
 * Still a single bge-m3 API call (text: [combinedText]); the call cost
 * stays at 1 neuron-billing event, only the input token count grows
 * (~+10-30% per call vs title-only).
 *
 * Returns empty array on failure — callers must handle gracefully.
 */
export async function embedTitle(env: Env, title: string, summary?: string): Promise<number[]> {
  const combined = summary && summary.trim().length > 0
    ? `${title} ${summary.trim()}`
    : title;
  try {
    const embResp = (await env.AI.run('@cf/baai/bge-m3', {
      text: [combined],
    })) as BgeEmbeddingResponse;
    // AI budget tracking
    const neurons = computeNeurons('@cf/baai/bge-m3', { inputTexts: [combined] });
    await recordAiCall('@cf/baai/bge-m3', neurons, env);
    if (Array.isArray(embResp?.data) && embResp.data.length > 0) {
      const it = embResp.data[0];
      return Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
    }
  } catch {
    /* embedding failure is non-fatal */
  }
  return [];
}

/**
 * Find similar news for a given embedding.
 * Combines embedTitle + findSimilarNews into one step.
 */
export async function findSimilarForEmbedding(
  env: Env,
  embedding: number[],
  threshold: number,
  matchCount: number
): Promise<SimilarNewsItem[]> {
  if (embedding.length === 0) return [];
  return findSimilarNews(env, embedding, threshold, matchCount);
}
