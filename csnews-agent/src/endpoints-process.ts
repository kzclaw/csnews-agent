// ============================================================
// News Self Growth — process / health / logs / tavily endpoints
// ============================================================

import { Env, jsonResponse } from './shared';
import { resetCacheMetrics } from './cache';
import { fetchZakerHot, embedTitle, findSimilarForEmbedding } from './process-vector';
import { scoreTitle, classifyTitle } from './process-ai';
import {
  createTopicForTitle,
  updateTopicScoreById,
  insertNewsBatch,
  dualWriteVectors,
  recordTrendForNews,
} from './process-db';
import { cleanupStaleTopics as cleanupStTopics } from './news-process';
import type { CleanupStaleTopicsResult, ZakerArticle } from './types';

// Delegated handlers (extracted to focused sub-modules)
import { handleHealthAction } from './health-main';
import { handleLogsAction } from './logs';
import { handleAiUsageAction } from './ai-usage';
import { runTavilyPipeline } from './tavily';
export { handleHealthAction, handleLogsAction, handleAiUsageAction };

export async function handleProcessAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    resetCacheMetrics();
    const cleaned = (await cleanupStTopics(env)) as CleanupStaleTopicsResult;
    const list = await fetchZakerHot();
    if (list.length === 0) {
      return jsonResponse({ error: 'no news' }, cors);
    }

    const FULL_COUNT = 6;
    const pendingNews: PendingItem[] = [];

    for (let i = 0; i < list.slice(0, 10).length; i++) {
      const result = await processZakerItem(list[i], i, env, FULL_COUNT);
      if (result) {
        pendingNews.push(result);
      }
    }

    const batchNewsArray = pendingNews.map((p) => ({
      title: p.title,
      url: p.item.url || '',
      source: 'zaker',
      category: p.category,
      hot_score: p.rule.score,
      published_at: p.item.publish_time || new Date().toISOString(),
      summary: (p.item.summary || '').substring(0, 200),
      embedding: p.embedding.length > 0 ? p.embedding : undefined,
      r2_key: p.r2Key,
      topic_id: p.topicId,
      level: p.newsLevel,
      score: p.newsScore,
      is_stored_r2: p.isStoredR2,
    }));

    const batchIds = await insertNewsBatch(env, batchNewsArray);
    dualWriteVectors(env, batchNewsArray, batchIds);

    const results = [];
    for (let i = 0; i < pendingNews.length; i++) {
      const p = pendingNews[i];
      const newsId = batchIds[i];
      let trend: null | object = null;
      if (newsId && p.topicId) {
        const ts = await recordTrendForNews(env, newsId, p.topicId, p.isNewTopic);
        if (ts) {
          trend = {
            snapshot_id: ts.snapshot_id,
            warning_id: ts.warning_id,
            velocity: ts.out_velocity,
            acceleration: ts.out_acceleration,
            stage: ts.out_stage,
            warning_created: ts.out_warning_created,
          };
        }
      }
      results.push({
        title: p.title,
        category: p.category,
        score: p.rule.score,
        topic_id: p.topicId,
        similarity: p.matchedSimilarity,
        level: p.newsLevel,
        is_stored_r2: p.isStoredR2,
        stored_reason: p.storedReason,
        trend,
        fission: p.fission,
      });
    }

    return jsonResponse(
      {
        worker_version: env.WORKER_VERSION || 'unknown',
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
        // v0.37.13: include module-level cached R2 put error (from saveToR2) so agent can self-diagnose
        // without needing CF Dashboard access. Cleared after read.
        r2_last_error: (globalThis as any).__R2_LAST_ERROR__ || null,
      },
      cors
    );
    // v0.37.13: clear cached R2 error after reading (next request gets fresh state)
    delete (globalThis as any).__R2_LAST_ERROR__;
  } finally {
    if (env.PROCESS_STATE) {
      const ts = new Date().toISOString();
      await env.PROCESS_STATE.put(
        'last_process_at',
        JSON.stringify({
          _seed: { fetchedAt: ts, recordCount: 1, state: 'ok' as const, maxContentAgeMin: 0 },
          data: { last_process_at: ts },
        }),
        { expirationTtl: 86400 * 7 }
      );
    }
  }
}

export async function handleTavilyAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  return runTavilyPipeline(env, url, cors);
}

async function processZakerItem(
  item: ZakerArticle,
  i: number,
  env: Env,
  fullCount: number
): Promise<PendingItem | null> {
  const title = item.title || '';
  if (!title) return null;

  const rule = scoreTitle(title);
  const category = await classifyTitle(title, env, item.summary);

  let topicId: string | undefined;
  let isStoredR2 = false;
  let newsLevel = 'follow';
  let newsScore = 0;
  let fission = false;
  let isNewTopic = false;
  let matchedSimilarity: number | null = null;
  let r2Key: string | undefined;
  let storedReason = i < fullCount ? 'embedding_empty' : 'lightweight_no_embedding';
  let embedding: number[] = [];

  if (i < fullCount) {
    embedding = await embedTitle(env, title);

    if (embedding.length > 0) {
      const similar = await findSimilarForEmbedding(env, embedding, 0.85, 3);
      if (similar.length > 0 && similar[0].topic_id) {
        const top = similar[0];
        topicId = top.topic_id;
        const updated = await updateTopicScoreById(env, top.topic_id);
        newsScore = updated.new_score || 0;
        newsLevel = updated.new_level || 'follow';
        fission = updated.fission_triggered || false;
        const simScore = top.similarity || 0;
        matchedSimilarity = simScore;
        if (simScore < 0.95) {
          const { saveToR2 } = await import('./news-process');
          r2Key = await saveToR2(env, 'news/zaker', {
            title,
            category,
            score: rule.score,
            source: 'zaker',
            topic_id: topicId,
            level: newsLevel,
            fission,
            similarity: simScore,
            created_at: new Date().toISOString(),
          });
          isStoredR2 = true;
          storedReason = 'same_topic_new_angle';
        } else {
          storedReason = 'same_topic_duplicate';
        }
      }
    }

    if (!topicId) {
      const created = await createTopicForTitle(env, title, 'follow');
      if (created?.id) {
        topicId = created.id;
        newsScore = 0;
        newsLevel = 'follow';
        isNewTopic = true;
        const { saveToR2 } = await import('./news-process');
        r2Key = await saveToR2(env, 'news/zaker', {
          title,
          category,
          score: rule.score,
          source: 'zaker',
          topic_id: topicId,
          level: newsLevel,
          fission: false,
          created_at: new Date().toISOString(),
        });
        isStoredR2 = true;
        storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
      }
    }
  }

  return {
    item,
    topicId,
    isNewTopic,
    newsLevel,
    newsScore,
    fission,
    matchedSimilarity,
    isStoredR2,
    storedReason,
    r2Key,
    embedding,
    title,
    category,
    rule,
  };
}

interface PendingItem {
  item: ZakerArticle;
  topicId: string | undefined;
  isNewTopic: boolean;
  newsLevel: string;
  newsScore: number;
  fission: boolean;
  matchedSimilarity: number | null;
  isStoredR2: boolean;
  storedReason: string;
  r2Key: string | undefined;
  embedding: number[];
  title: string;
  category: string;
  rule: { score: number; reason: string; isHigh: boolean };
}
