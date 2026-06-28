// ============================================================
// Vector processing — ZAKER fetch, bge-m3 embedding, similarity search
// ============================================================

import { Env } from './shared';
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
 * Generate bge-m3 embedding for a single title.
 * Returns empty array on failure — callers must handle gracefully.
 */
export async function embedTitle(env: Env, title: string): Promise<number[]> {
  try {
    const embResp = (await env.AI.run('@cf/baai/bge-m3', {
      text: [title],
    })) as BgeEmbeddingResponse;
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
