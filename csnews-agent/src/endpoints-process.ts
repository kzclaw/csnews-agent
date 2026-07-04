// ============================================================
// News Self Growth — process / health / logs / tavily endpoints
// ============================================================

import { Env, jsonResponse } from './shared';
  import { resetCacheMetrics } from './cache';
  import { fetchZakerHot, embedTitle, findSimilarForEmbedding } from './process-vector';
  import { scoreTitle, classifyTitle } from './process-ai';
  import { mapNewsScoreToDelta } from './topic-delta';
import {
  createTopicForTitle,
  updateTopicScoreByIdWithDelta,
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
import { runTavilyPipeline, fetchTavilyNews } from './tavily';
// v0.37.36 (董事长 2026-07-04 拍板): Score 自适应 + Fission 接力赛 触发
import { getCurrentScoreThreshold } from './score-threshold';
import { triggerFissionFromTopics } from './fission-trigger';
import { logEvent } from './log';
export { handleHealthAction, handleLogsAction, handleAiUsageAction };

export async function handleProcessAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // v0.37.16: hoisted so the finally block (which persists it to PROCESS_STATE
  // KV) can see the aggregate. Initialised to an empty object so a
  // `no news` early-return still has a defined value to persist.
  let lastProcessStoredReason: {
    run_at: string;
    total_items: number;
    r2_writes: number;
    r2_skipped: number;
    distribution: Record<string, number>;
    human_readable: string;
  } = {
    run_at: new Date().toISOString(),
    total_items: 0,
    r2_writes: 0,
    r2_skipped: 0,
    distribution: {},
    human_readable: 'no items processed in this run',
  };

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

    // v0.37.16: aggregate stored_reason distribution so consumers can see
    // *why* R2 didn't get new writes this run. The dominant reason is
    // usually same_topic_duplicate (similarity ≥ 0.95) — that's by design,
    // not a sign of a broken pipeline.
    const storedReasonDistribution: Record<string, number> = {};
    let r2Writes = 0;
    let r2Skipped = 0;
    for (const r of results) {
      const reason = (r as any).stored_reason || 'unknown';
      storedReasonDistribution[reason] = (storedReasonDistribution[reason] || 0) + 1;
      if ((r as any).is_stored_r2) r2Writes++;
      else r2Skipped++;
    }
    lastProcessStoredReason = {
      run_at: new Date().toISOString(),
      total_items: results.length,
      r2_writes: r2Writes,
      r2_skipped: r2Skipped,
      distribution: storedReasonDistribution,
      human_readable:
        r2Writes === 0
          ? `All ${results.length} items skipped R2 write (${Object.entries(
              storedReasonDistribution
            )
              .map(([k, v]) => `${v}× ${k}`)
              .join(
                ', '
              )}). R2 only stores new angles (similarity < 0.95); this is the by-design cold-archive behavior.`
          : `${r2Writes}/${results.length} items wrote to R2 (new angles). ${r2Skipped} skipped (repeats / lightweight) — normal.`,
    };

    // v0.37.36 (董事长 2026-07-04 拍板): 决策 1+3 实施 — process 完后 立即 触发 fission (sync · 等 fission 跑完 返)
    // 触发 条件: level='explosive' AND score >= current_score_threshold (从 R2 score-threshold-history.json 读 · 自适应 默认 9)
    // 失败 fallback: 6h cron 兜底 (决策 2)
    let fissionTriggerResult: { ok: boolean; status?: number; reason?: string; topic_count?: number } = {
      ok: false,
      reason: 'no_triggerable_topic',
    };
    try {
      const currentThreshold = await getCurrentScoreThreshold(env);
      const triggerableTopics = results
        .filter((r: any) => r.level === 'explosive' && (r.score ?? 0) >= currentThreshold)
        .map((r: any) => ({ name: r.title, title: r.title, score: r.score }));
      if (triggerableTopics.length > 0 && env.FISSION) {
        const r = await triggerFissionFromTopics(env, triggerableTopics, 'post-process-immediate');
        fissionTriggerResult = {
          ok: r.ok,
          status: r.status,
          reason: r.ok ? 'triggered' : (r.error || r.reason || 'unknown'),
          topic_count: triggerableTopics.length,
        };
      } else if (triggerableTopics.length === 0) {
        fissionTriggerResult = { ok: true, reason: 'no_explosive_topics', topic_count: 0 };
      } else {
        fissionTriggerResult = { ok: false, reason: 'FISSION_binding_missing', topic_count: triggerableTopics.length };
      }
    } catch (e: any) {
      // 决策 2: 失败 fallback → 6h cron 兜底 (不 propagate error to user)
      fissionTriggerResult = { ok: false, reason: e?.message || String(e) };
      try {
        await logEvent(env, 'error', `[fission-trigger] post-process failed: ${e?.message || e}`, undefined, 'process');
      } catch {
        // ignore logging error
      }
    }

    // v0.37.39 (拍板 A): 启用 tavily · process 完后 立即 触发 (跟 fission 同 范式)
    // 跟 fission trigger 不同: tavily 总是 跑 (不 需要 topic 触发 条件) · 有 key 就 fetch, 没 key 就 graceful guard 返 空
    // 失败 fallback: 现有 hourly cron 兜底 (manual ?action=tavily endpoint 仍 可用)
    let tavilyTriggerResult: {
      ok: boolean;
      fetched: number;
      inserted: number;
      skipped_duplicates: number;
      errors: string[];
      elapsed_ms: number;
      reason: string;
    } = {
      ok: false, fetched: 0, inserted: 0, skipped_duplicates: 0, errors: [], elapsed_ms: 0, reason: 'not_called',
    };
    // v0.37.51: Tavily inline trigger broken against 50-subrequest budget once
    // pipeline started returning real results (Bearer auth fix unlocked it).
    // Drop the inline run and instead flag PROCESS_STATE['tavily_pending']=1;
    // csnews-fission's 6H scheduled handler picks the flag up, calls the
    // main worker via Service Binding ?action=tavily&max=1, then deletes it.
    // Async trigger avoids burning the calling invocation's budget on a
    // 25-article cluster; csnews-fission gets its own 50 subrequests.
    if (env.PROCESS_STATE) {
      try {
        await env.PROCESS_STATE.put(
          'tavily_pending',
          JSON.stringify({
            requested_at: new Date().toISOString(),
            topics_count: results.length,
          }),
          { expirationTtl: 86400 * 2 }
        );
        tavilyTriggerResult = {
          ok: true,
          fetched: 0,
          inserted: 0,
          skipped_duplicates: 0,
          errors: [],
          elapsed_ms: 0,
          reason: 'scheduled_async',
        };
      } catch (e: any) {
        tavilyTriggerResult = {
          ok: false,
          fetched: 0,
          inserted: 0,
          skipped_duplicates: 0,
          errors: [],
          elapsed_ms: 0,
          reason: `kv_put_failed: ${e?.message || String(e)}`,
        };
        try {
          await logEvent(env, 'error', `[tavily-trigger] KV flag put failed: ${e?.message || e}`, undefined, 'process');
        } catch {
          // ignore logging error
        }
      }
    } else {
      tavilyTriggerResult = {
        ok: false,
        fetched: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: [],
        elapsed_ms: 0,
        reason: 'no_process_state_kv',
      };
    }

    return jsonResponse(
      {
        // v0.37.17 (v0.37.17 board decision): worker_version 由 ?action=health 端点从 PROCESS_STATE KV 读,
        // process 端点不再重复返回 — 关注处理结果,版本号去 health 查.
        // 仍保留 last_process_at 以便 process 调用方知道本次 run 时间戳.
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
        // v0.37.13: include module-level cached R2 put error (from saveToR2) so agent can self-diagnose
        // without needing CF Dashboard access. Cleared after read.
        r2_last_error: (globalThis as any).__R2_LAST_ERROR__ || null,
        // v0.37.16: aggregate stored_reason distribution so consumers know
        // whether the R2 skip pattern is "all duplicates" (normal) vs
        // "0% writes" (suspicious — would need investigation).
        last_process_stored_reason: lastProcessStoredReason,
        // v0.37.36: Fission Service Bindings 接力赛 触发 结果
        fission_trigger: fissionTriggerResult,
        // v0.37.39: Tavily pipeline 接力赛 触发 结果 (跟 fission 同 范式)
        tavily_trigger: tavilyTriggerResult,
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
      // v0.37.16: also persist the stored_reason aggregate so the health
      // endpoint can surface "why R2 isn't getting new writes" without
      // having to re-run the full process. TTL 2h covers the hourly cron
      // and gives headroom for retries.
      await env.PROCESS_STATE.put(
        'last_process_stored_reason',
        JSON.stringify({
          _seed: { fetchedAt: ts, recordCount: 1, state: 'ok' as const, maxContentAgeMin: 0 },
          data: { last_process_stored_reason: lastProcessStoredReason },
        }),
        { expirationTtl: 7200 }
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
  // Direct test mode: ?query=<string> bypasses the dynamic-query chain and
  // hits the upstream search API one time for the literal query, useful
  // for verifying whether a given keyword actually surfaces results.
  const directQuery = url.searchParams.get('query');
  if (directQuery) {
    const apiKey = env.TAVILY_API_KEY;
    const max = Math.max(
      1,
      Math.min(parseInt(url.searchParams.get('max') || '5', 10), 10)
    );
    const results = await fetchTavilyNews(env, apiKey, directQuery, max);
    return jsonResponse(
      {
        source: 'tavily-direct',
        query: directQuery,
        fetched: results.length,
        items: results.map((r) => ({ title: r.title, url: r.url })),
      },
      cors
    );
  }
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
    embedding = await embedTitle(env, title, item.summary);

    if (embedding.length > 0) {
      const similar = await findSimilarForEmbedding(env, embedding, 0.85, 3);
      if (similar.length > 0 && similar[0].topic_id) {
        const top = similar[0];
        topicId = top.topic_id;
        // v0.37.37: hot_score → delta 5 档 映射 · 卡 8 explosive 加速
        const delta = mapNewsScoreToDelta(rule.score);
        const updated = await updateTopicScoreByIdWithDelta(env, top.topic_id, delta);
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
