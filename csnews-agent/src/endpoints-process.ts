// ============================================================
// News Self Growth endpoints — process, health, logs, tavily
// ============================================================
// Responsibilities:
//   - process: News Self Growth cron pipeline
//   - health: 15-dimension worker observability checks
//   - logs: R2 log retrieval
//   - tavily: Tavily News API ingestion
// ============================================================

import { Env } from './shared';
import { logEvent } from './log';
import { resetCacheMetrics } from './cache';
import { MCP_TOOLS_COUNT } from './mcp-handler';
import {
  fetchZakerHot,
  embedTitle,
  findSimilarForEmbedding,
} from './process-vector';
import { scoreTitle, classifyTitle } from './process-ai';
import {
  createTopicForTitle,
  updateTopicScoreById,
  insertNewsBatch,
  dualWriteVectors,
  recordTrendForNews,
} from './process-db';
import {
  cleanupStaleTopics,
  saveToR2,
} from './news-process';
import {
  checkLastProcessAt,
  checkSecretResolved,
  checkSupabaseCounts,
  checkR2LatestWrite,
  checkR2LatestSupabaseWrite,
  checkR2PrefixCounts,
  checkCronHistory,
  checkZscoreSignals,
  checkAiBudget,
  checkEntityAndEventFreshness,
  checkCacheMetrics,
  checkPullCacheFreshness,
  checkAiCallsBreakdown,
} from './health-checks';
import type { CleanupStaleTopicsResult } from './types';

// ===================== process (News Self Growth cron) =====================
export async function handleProcessAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // Step 0a: reset per-isolate cache metrics at cron start
    resetCacheMetrics();

    // Step 0b: cleanup stale topic clusters
    const cleaned = (await cleanupStalesTopics(env)) as CleanupStaleTopicsResult;

    // Step 1: fetch hot articles from ZAKER
    const list = await fetchZakerHot();
    if (list.length === 0) {
      return new Response(JSON.stringify({ error: 'no news' }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Only first 10 items are processed
    const FULL_COUNT = 6;
    const pendingNews: PendingItem[] = [];

    for (let i = 0; i < list.slice(0, 10).length; i++) {
      const result = await processZakerItem(list[i], i, env, FULL_COUNT);
      if (result) {
        pendingNews.push(result);
        if (result.fission) console.log(`[FISSION] ${result.title}`);
      }
    }

    // Batch insert + dual-write to Vectorize
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

    // Record trend membership per news item
    const results = [];
    for (let i = 0; i < pendingNews.length; i++) {
      const p = pendingNews[i];
      const newsId = batchIds[i];
      if (newsId && p.topicId) {
        const trendSnapshot = await recordTrendForNews(env, newsId, p.topicId, p.isNewTopic);
        results.push({
          title: p.title,
          category: p.category,
          score: p.rule.score,
          topic_id: p.topicId,
          similarity: p.matchedSimilarity,
          level: p.newsLevel,
          is_stored_r2: p.isStoredR2,
          stored_reason: p.storedReason,
          trend: trendSnapshot
            ? {
                snapshot_id: trendSnapshot.snapshot_id,
                warning_id: trendSnapshot.warning_id,
                velocity: trendSnapshot.out_velocity,
                acceleration: trendSnapshot.out_acceleration,
                stage: trendSnapshot.out_stage,
                warning_created: trendSnapshot.out_warning_created,
              }
            : null,
          fission: p.fission,
        });
      } else {
        results.push({
          title: p.title,
          category: p.category,
          score: p.rule.score,
          topic_id: p.topicId,
          similarity: p.matchedSimilarity,
          level: p.newsLevel,
          is_stored_r2: p.isStoredR2,
          stored_reason: p.storedReason,
          trend: null,
          fission: p.fission,
        });
      }
    }

    return new Response(
      JSON.stringify({
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
      }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  } finally {
    // Always record cron last-run time in KV, even on failure
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

// ===================== health =====================
// 17+ dimension checks (delegated to health-checks.ts)
//  1. last_process_at              8. r2_prefix_counts           15. pull_cache_freshness
//  2. cron_health                 9. cron_history               16. neurons_used_today
//  3. secret_resolved           10. zscore_signals_today      17. ai_budget_status
//  4. supabase_counts           11. ai_budget_today           18. ai_calls_breakdown
//  5. supabase_reachable       12. entity_freshness          19. mcp_tools_count
//  6. r2_latest_write           13. event_freshness
//  7. r2_latest_supabase_write 14. cache_metrics
export async function handleHealthAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const ts = Date.now();
  const checks: Record<string, { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: any }> =
    {};
  const result: any = { status: 'ok', ts };

  const lastProcessResult = await checkLastProcessAt(env, ts);
  result.last_process_at = lastProcessResult.last_process_at;
  result.cron_health = lastProcessResult.cron_health;
  checks.last_process_at = lastProcessResult.checks.last_process_at;
  checks.cron_health = lastProcessResult.checks.cron_health;

  const secretResult = checkSecretResolved(env);
  checks.secret_resolved = secretResult.checks.secret_resolved;

  const supabaseResult = await checkSupabaseCounts(env);
  result.supabase_counts = supabaseResult.supabase_counts;
  checks.supabase_reachable = supabaseResult.checks.supabase_reachable;

  const r2LatestResult = await checkR2LatestWrite(env, ts);
  result.r2_latest_write = r2LatestResult.r2_latest_write;
  checks.r2_latest_write = r2LatestResult.checks.r2_latest_write;

  const r2SupabaseResult = await checkR2LatestSupabaseWrite(env, ts);
  result.r2_latest_supabase_write = r2SupabaseResult.r2_latest_supabase_write;
  checks.r2_latest_supabase_write = r2SupabaseResult.checks.r2_latest_supabase_write;

  const r2PrefixResult = await checkR2PrefixCounts(env);
  result.r2_prefix_counts = r2PrefixResult.r2_prefix_counts;
  const r2PrefixErrorCount = Object.values(r2PrefixResult.r2_prefix_counts).filter(
    (v) => typeof v === 'object' && 'error' in v
  ).length;
  checks.r2_prefix_counts = {
    status:
      r2PrefixErrorCount === 0
        ? 'ok'
        : r2PrefixErrorCount < Object.keys(r2PrefixResult.r2_prefix_counts).length
          ? 'degraded'
          : 'down',
    detail: `${r2PrefixErrorCount}/${Object.keys(r2PrefixResult.r2_prefix_counts).length} prefixes failed`,
  };

  const cronHistoryResult = await checkCronHistory(env, ts);
  result.cron_history = cronHistoryResult.cron_history;
  checks.cron_history = cronHistoryResult.checks.cron_history;

  const zscoreResult = await checkZscoreSignals(env, ts);
  result.zscore_signals_today = zscoreResult.zscore_signals_today;
  checks.zscore_signals_today = zscoreResult.checks.zscore_signals_today;

  const aiBudgetResult = await checkAiBudget(env);
  result.ai_budget_today = aiBudgetResult.ai_budget_today;
  checks.ai_budget_today = aiBudgetResult.checks.ai_budget_today;

  const freshnessResult = await checkEntityAndEventFreshness(env);
  result.entity_freshness = freshnessResult.entity_freshness;
  result.event_freshness = freshnessResult.event_freshness;
  checks.entity_freshness = freshnessResult.checks.entity_freshness;
  checks.event_freshness = freshnessResult.checks.event_freshness;

  const cacheResult = checkCacheMetrics();
  result.cache_metrics = cacheResult.cache_metrics;
  checks.cache_metrics = cacheResult.checks.cache_metrics;

  const pullCacheFreshnessResult = await checkPullCacheFreshness(env, ts);
  result.pull_cache_freshness = pullCacheFreshnessResult.pull_cache_freshness;
  checks.pull_cache_freshness = pullCacheFreshnessResult.checks.pull_cache_freshness;

  const aiCallsResult = await checkAiCallsBreakdown(env);
  result.neurons_used_today = aiCallsResult.neurons_used_today;
  result.ai_budget_status = aiCallsResult.ai_budget_status;
  result.ai_calls_breakdown = aiCallsResult.ai_calls_breakdown;
  checks.ai_calls_breakdown = aiCallsResult.checks.ai_calls_breakdown;

  result.mcp_tools_count = MCP_TOOLS_COUNT;

  const statuses = Object.values(checks)
    .filter(
      (c): c is { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: any } =>
        c != null && 'status' in c
    )
    .map((c) => c.status as string);
  if (statuses.includes('down')) result.status = 'down';
  else if (statuses.includes('degraded')) result.status = 'degraded';
  else if (statuses.every((s) => s === 'ok' || s === 'unknown')) result.status = 'ok';
  else result.status = 'degraded';

  result.checks = checks;

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== ai-usage =====================
// ?action=ai-usage — aggregate 7-day AI usage from KV
export async function handleAiUsageAction(env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.AI_USAGE_KV) {
    return new Response(JSON.stringify({ error: 'AI_USAGE_KV binding missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    );
  }

  const kvResults = await Promise.allSettled(
    dates.map((date) => env.AI_USAGE_KV!.get(`usage/${date}`))
  );

  type DayModelAgg = { calls: number; neurons: number };
  const aggregated: Record<string, Record<string, DayModelAgg>> = {};

  for (let i = 0; i < kvResults.length; i++) {
    const result = kvResults[i];
    const date = dates[i];
    aggregated[date] = {};

    if (result.status === 'fulfilled' && result.value) {
      try {
        const record = JSON.parse(result.value) as {
          total: number;
          calls: Array<{ model: string; neurons: number }>;
        };
        for (const call of record.calls ?? []) {
          const model = call.model || 'unknown';
          if (!aggregated[date][model]) aggregated[date][model] = { calls: 0, neurons: 0 };
          aggregated[date][model].calls++;
          aggregated[date][model].neurons += call.neurons;
        }
      } catch {
        /* parse failed — skip */
      }
    }
  }

  type UsageEntry = { date: string; model: string; calls: number; neurons: number };
  const entries: UsageEntry[] = [];
  for (const [date, models] of Object.entries(aggregated)) {
    for (const [model, agg] of Object.entries(models)) {
      entries.push({ date, model, calls: agg.calls, neurons: agg.neurons });
    }
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  return new Response(
    JSON.stringify({ days: 7, entries, total_entries: entries.length }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}

// ===================== logs =====================
// ?action=logs&date=YYYY-MM-DD&hour=HH&limit=N — read R2 log files
export async function handleLogsAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const params = url.searchParams;
  const now = new Date();
  const todayUtc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  const rawDate = params.get('date') || 'today';
  let date: string;
  if (rawDate === 'today') {
    date = todayUtc;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    date = rawDate;
  } else {
    return new Response(JSON.stringify({ error: "date must be YYYY-MM-DD or 'today'" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const hourParam = params.get('hour');
  let hour: number | null = null;
  if (hourParam !== null) {
    hour = parseInt(hourParam, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return new Response(JSON.stringify({ error: 'hour must be 0-23' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  const limit = Math.min(Math.max(parseInt(params.get('limit') || '100', 10), 1), 500);

  const requestedDate = new Date(date + 'T00:00:00Z');
  const todayDate = new Date(todayUtc + 'T00:00:00Z');
  const diffDays = (todayDate.getTime() - requestedDate.getTime()) / 86400_000;
  if (diffDays > 7 || diffDays < 0) {
    return new Response(JSON.stringify({ error: 'date range max 7 days (0-7 days back)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let entries: any[] = [];
  try {
    const prefix = `logs/${date}/`;
    const list = await env.csnews_raw.list({ prefix, limit: 1000 });
    for (const obj of list.objects) {
      if (/^\d{2}\.log$/.test(obj.key.split('/').pop() || '')) {
        if (hour !== null && !obj.key.endsWith(`/${String(hour).padStart(2, '0')}.log`)) continue;
      } else {
        const parts = obj.key.split('/');
        if (parts.length < 3) continue;
        const hh = parts[parts.length - 2];
        if (hour !== null && hh !== String(hour).padStart(2, '0')) continue;
      }
      const body = await env.csnews_raw.get(obj.key);
      if (!body) continue;
      const text = await body.text();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          entries.push(JSON.parse(t));
        } catch {
          /* skip corrupted lines */
        }
      }
    }
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: 'r2 unavailable', detail: e?.message || String(e) }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }

  entries.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const items = entries.slice(0, limit);
  const truncated = entries.length > items.length;

  return new Response(
    JSON.stringify({ date, hour, count: items.length, total: entries.length, truncated, items }),
    { headers: { 'Content-Type': 'application/json', ...cors } }
  );
}

// ===================== tavily (Tavily News API ingestion) =====================
// Runs every 2 hours via cron. Fetches ~10 articles, dedups via Vectorize,
// batch inserts, and dual-writes embeddings.
const TAVILY_QUERIES = [
  'top trending news today worldwide',
  'breaking technology business science news',
];

export async function handleTavilyAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const start = Date.now();
  const apiKey = env.TAVILY_API_KEY;
  const maxPerQuery = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('max') || '5', 10), 10)
  );

  const { fetchTavilyNews } = await import('./tavily');
  const allArticles: import('./tavily').NormalizedArticle[] = [];
  const fetchErrors: string[] = [];

  for (const query of TAVILY_QUERIES) {
    const articles = await fetchTavilyNews(apiKey, query, maxPerQuery);
    if (articles.length === 0 && apiKey && apiKey !== 'YOUR_KEY_HERE') {
      fetchErrors.push(`query="${query}" returned 0 results`);
    }
    allArticles.push(...articles);
  }

  if (allArticles.length === 0) {
    return new Response(
      JSON.stringify({
        source: 'tavily',
        fetched: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: fetchErrors,
        elapsed_ms: Date.now() - start,
      }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const uniqueArticles = allArticles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  const results: Array<{ title: string; url: string; similarity: number | null; stored_reason: string }> = [];
  const pendingNews: Array<{
    title: string;
    url: string;
    source: string;
    category: string | undefined;
    published_at: string;
    summary: string | undefined;
    embedding: number[];
    topicId: string | undefined;
    isNewTopic: boolean;
    newsLevel: string;
    newsScore: number;
    matchedSimilarity: number | null;
  }> = [];

  const EMBED_COUNT = 6;

  for (let i = 0; i < uniqueArticles.length; i++) {
    const article = uniqueArticles[i];
    const title = article.title;

    let topicId: string | undefined;
    let embedding: number[] = [];
    let matchedSimilarity: number | null = null;
    let newsLevel = 'follow';
    let newsScore = 0;
    let isNewTopic = false;
    let storedReason = 'lightweight_no_embedding';

    if (i < EMBED_COUNT) {
      embedding = await embedTitle(env, title);

      if (embedding.length > 0) {
        const similar = await findSimilarForEmbedding(env, embedding, 0.88, 3);
        if (similar.length > 0 && similar[0].topic_id) {
          const top = similar[0];
          topicId = top.topic_id;
          const updated = await updateTopicScoreById(env, top.topic_id);
          newsScore = updated.new_score || 0;
          newsLevel = updated.new_level || 'follow';
          matchedSimilarity = top.similarity || null;
          const simScore = top.similarity || 0;
          storedReason = simScore < 0.95 ? 'same_topic_new_angle' : 'same_topic_duplicate';
        }
      }

      if (!topicId) {
        const created = await createTopicForTitle(env, title, 'follow');
        if (created?.id) {
          topicId = created.id;
          newsScore = 0;
          newsLevel = 'follow';
          isNewTopic = true;
          storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
        }
      }
    }

    pendingNews.push({
      title,
      url: article.url,
      source: 'tavily',
      category: article.category,
      published_at: article.published_at,
      summary: article.summary,
      embedding,
      topicId,
      isNewTopic,
      newsLevel,
      newsScore,
      matchedSimilarity,
    });

    results.push({
      title,
      url: article.url,
      similarity: matchedSimilarity,
      stored_reason: storedReason,
    });
  }

  const batchNewsArray = pendingNews.map((p) => ({
    title: p.title,
    url: p.url || '',
    source: p.source,
    category: p.category,
    hot_score: undefined as number | undefined,
    published_at: p.published_at,
    summary: (p.summary || '').substring(0, 200),
    embedding: p.embedding.length > 0 ? p.embedding : undefined,
    r2_key: undefined as string | undefined,
    topic_id: p.topicId,
    level: p.newsLevel,
    score: p.newsScore,
    is_stored_r2: false,
  }));

  const batchIds = await insertNewsBatch(env, batchNewsArray);
  dualWriteVectors(env, batchNewsArray, batchIds);

  for (let i = 0; i < pendingNews.length; i++) {
    const p = pendingNews[i];
    const newsId = batchIds[i];
    if (newsId && p.topicId) {
      await recordTrendForNews(env, newsId, p.topicId, p.isNewTopic);
    }
  }

  const inserted = batchIds.filter(Boolean).length;
  const skipped = results.filter((r) => r.stored_reason === 'same_topic_duplicate').length;

  return new Response(
    JSON.stringify({
      source: 'tavily',
      fetched: uniqueArticles.length,
      inserted,
      skipped_duplicates: skipped,
      errors: fetchErrors,
      elapsed_ms: Date.now() - start,
      items: results,
    }),
    { headers: { 'Content-Type': 'application/json', ...cors } }
  );
}

// ===================== internal helpers =====================

// Wrapper for cleanupStaleTopics — ensures typed result
async function cleanupStalesTopics(env: Env) {
  return cleanupStTopics(env);
}

// Workaround: avoid import alias collision by calling news-process directly
import { cleanupStaleTopics as cleanupStTopics } from './news-process';

// ===================== internal helpers =====================

/** Per-item processing for the ZAKER hot list pipeline. */
async function processZakerItem(
  item: import('./types').ZakerArticle,
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
          r2Key = await saveToR2(env, 'news/zaker', {
            title, category, score: rule.score, source: 'zaker',
            topic_id: topicId, level: newsLevel, fission,
            similarity: simScore, created_at: new Date().toISOString(),
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
        r2Key = await saveToR2(env, 'news/zaker', {
          title, category, score: rule.score, source: 'zaker',
          topic_id: topicId, level: newsLevel, fission: false,
          created_at: new Date().toISOString(),
        });
        isStoredR2 = true;
        storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
      }
    }
  }

  return { item, topicId, isNewTopic, newsLevel, newsScore, fission,
    matchedSimilarity, isStoredR2, storedReason, r2Key, embedding, title, category, rule };
}

// Intermediate data structure for the per-item loop in handleProcessAction
interface PendingItem {
  item: import('./types').ZakerArticle;
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
