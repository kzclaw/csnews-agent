// ============================================================
// Tavily News API client — second data source for CSNEWS
// ============================================================
// Normalized articles flow into the same insert pipeline as ZAKER.
// Cross-source dedup: each article is checked against Vectorize
// before insertion (similarity > 0.88 → skip).

import { Env, jsonResponse, supabaseFetch, safeJson } from './shared';
import { logEvent } from './log';
import { embedTitle, findSimilarForEmbedding } from './process-vector';
import {
  createTopicForTitle,
  updateTopicScoreByIdWithDelta,
  insertNewsBatch,
  dualWriteVectors,
  recordTrendForNews,
} from './process-db';
import { scoreTitle } from './process-ai';
import { mapNewsScoreToDelta } from './topic-delta';

/**
 * Normalized article shape shared by all data sources.
 * Used by the batch-insert pipeline in endpoints-process.ts.
 */
export interface NormalizedArticle {
  title: string;
  url: string;
  published_at: string; // ISO 8601
  source: 'tavily';
  summary?: string;
  category?: string;
}

// ---- Tavily API response types ----

export interface TavilySearchResult {
  url: string;
  title: string;
  published_date?: string;
  content?: string;
  raw_date?: string;
  score?: number;
}

export interface TavilySearchResponse {
  query: string;
  follow_up_questions?: string[];
  answer?: string;
  results: TavilySearchResult[];
}

// ---- Mock articles for test mode ----

const MOCK_ARTICLES: NormalizedArticle[] = [
  {
    title: 'Tech Giants Report Record Q2 Earnings Amid AI Boom',
    url: 'https://example.com/tech-earnings-q2',
    published_at: new Date().toISOString(),
    source: 'tavily',
    summary:
      'Leading technology companies have posted record quarterly earnings, driven by surging demand for AI products and cloud services.',
    category: 'technology',
  },
  {
    title: 'Global Climate Summit Reaches Historic Agreement on Emissions',
    url: 'https://example.com/climate-summit-2026',
    published_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    source: 'tavily',
    summary:
      'World leaders at the annual climate summit have agreed to accelerated emission reduction targets, marking a significant step forward in the global climate response.',
    category: 'world',
  },
  {
    title: 'Breakthrough in Quantum Computing Achieved by Research Team',
    url: 'https://example.com/quantum-computing-breakthrough',
    published_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
    source: 'tavily',
    summary:
      'Scientists have demonstrated a new quantum computing approach that could accelerate practical quantum applications by an order of magnitude.',
    category: 'science',
  },
];

/**
 * Normalize a raw Tavily result to the shared NormalizedArticle format.
 */
function normalizeTavilyResult(result: TavilySearchResult): NormalizedArticle {
  const publishedAt = result.published_date || result.raw_date || new Date().toISOString();

  return {
    title: result.title || 'Untitled',
    url: result.url || '',
    published_at: publishedAt,
    source: 'tavily',
    summary: result.content ? result.content.substring(0, 300) : undefined,
  };
}

/**
 * Fetch news from Tavily Search API.
 *
 * @param apiKey       - Tavily API key (from CF Secret: TAVILY_API_KEY)
 * @param query        - Search query string
 * @param maxResults   - Max number of results (default 10)
 * @returns NormalizedArticle[] — empty if API key is missing or invalid
 */
export async function fetchTavilyNews(
  env: Env,
  apiKey: string | undefined,
  query: string,
  maxResults = 10
): Promise<NormalizedArticle[]> {
  // Guard: no key configured
  if (!apiKey) {
    await logEvent(
      env,
      'warn',
      '[Tavily] TAVILY_API_KEY not configured — skipping fetch',
      undefined,
      'tavily'
    );
    return [];
  }

  // Test/mock mode: placeholder key
  if (apiKey === 'YOUR_KEY_HERE') {
    await logEvent(
      env,
      'info',
      '[Tavily] mock mode: returning 3 test articles',
      undefined,
      'tavily'
    );
    return MOCK_ARTICLES;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        search_depth: 'advanced',
        max_results: maxResults,
        topic: 'general',
        time_range: 'day',
        country: 'china',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      await logEvent(
        env,
        'error',
        `[Tavily] HTTP ${res.status}: ${errText.slice(0, 300)}`,
        undefined,
        'tavily'
      );
      return [];
    }

    const json = (await res.json()) as TavilySearchResponse;
    const results = json.results || [];

    await logEvent(
      env,
      'info',
      `[Tavily] fetched ${results.length} results for query "${query}"`,
      undefined,
      'tavily'
    );
    return results.map(normalizeTavilyResult);
  } catch (err) {
    await logEvent(env, 'error', '[Tavily] fetch failed', { err: err as any }, 'tavily');
    return [];
  }
}

// ============================================================
// Tavily cron pipeline — runs every 2 hours
// ============================================================
// Fetches ~10 articles per query, deduplicates, embeds top-N,
// assigns topics via Vectorize similarity, batch-inserts, and
// dual-writes to Vectorize.
// ============================================================

// ---- cron query list (dynamic · 替换 v0.37.39 硬 编 码 英 文 常 量) ----
// Primary: Supabase topics top 5 explosive/important (跟 ZAKER / news_hotspots 同 源 · 中文)
// Fallback 1: news_hotspots 24h top 10 → Workers AI llama-3.1-8b 抽 5 中 文 搜 索 词
// Fallback 2: R2 latest daily snapshot 拉 最 近 几 条 news title 直 接 当 query

async function getDynamicQueriesFromTopics(env: Env): Promise<string[]> {
  try {
    const res = await supabaseFetch(
      env,
      `/rest/v1/topics?select=title&level=in.(explosive,important)&order=score.desc&limit=5`
    );
    if (!res.ok) return [];
    const rows = ((await safeJson(res)) as any[]) || [];
    return rows
      .map((r: any) => r.title)
      .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

async function getDynamicQueriesFromNewsHotspots(env: Env): Promise<string[]> {
  try {
    const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await supabaseFetch(
      env,
      `/rest/v1/news_hotspots?select=title&published_at=gte.${encodeURIComponent(sinceIso)}&order=published_at.desc&limit=10`
    );
    if (!res.ok) return [];
    const rows = ((await safeJson(res)) as any[]) || [];
    const titles = rows
      .map((r: any) => r.title)
      .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0);
    if (titles.length === 0) return [];

    const prompt = `基于以下最近 24 小时新闻标题,生成 5 个简洁的中文搜索关键词(每行一个,不带数字序号或符号),用于 tavily API 检索更多相关结果:\n\n${titles.slice(0, 10).join('\n')}`;
    const aiResp = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    })) as { response?: string };
    const text = aiResp?.response || '';
    return text
      .split('\n')
      .map((l: string) => l.trim().replace(/^[-*\d.\s)]+/, ''))
      .filter((l: string) => l.length >= 2 && l.length < 60)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function getDynamicQueriesFromR2(env: Env, limit = 5): Promise<string[]> {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const obj = await env.csnews_raw.get(`news/${dateStr}/latest.json`);
    if (!obj) return [];
    const data = JSON.parse(await obj.text()) as { items?: { title: string }[] };
    return (data.items || [])
      .map((i) => i.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function getDynamicQueries(env: Env): Promise<string[]> {
  // Primary: trending topics
  let queries = await getDynamicQueriesFromTopics(env);
  if (queries.length > 0) {
    await logEvent(
      env,
      'info',
      `[Tavily] dynamic queries from topics: ${queries.length}`,
      undefined,
      'tavily'
    );
    return queries;
  }

  // Fallback 1: news_hotspots 24h + Workers AI
  queries = await getDynamicQueriesFromNewsHotspots(env);
  if (queries.length > 0) {
    await logEvent(
      env,
      'info',
      `[Tavily] dynamic queries from LLM (news_hotspots): ${queries.length}`,
      undefined,
      'tavily'
    );
    return queries;
  }

  // Fallback 2: R2 daily snapshot latest titles
  queries = await getDynamicQueriesFromR2(env, 5);
  if (queries.length > 0) {
    await logEvent(
      env,
      'info',
      `[Tavily] dynamic queries from R2: ${queries.length}`,
      undefined,
      'tavily'
    );
    return queries;
  }

  await logEvent(
    env,
    'warn',
    '[Tavily] no dynamic queries available (topics/news_hotspots/R2 all empty)',
    undefined,
    'tavily'
  );
  return [];
}

// ---- shared result shape ----
interface TavilyResultItem {
  title: string;
  url: string;
  similarity: number | null;
  stored_reason: string;
}

interface TavilyPendingItem {
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
}

/**
 * Full Tavily cron pipeline.
 * Called by endpoints-process.ts handleTavilyAction.
 */
export async function runTavilyPipeline(
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const start = Date.now();
  const apiKey = env.TAVILY_API_KEY;
  const maxPerQuery = Math.max(1, Math.min(parseInt(url.searchParams.get('max') || '5', 10), 10));

  const allArticles: NormalizedArticle[] = [];
  const fetchErrors: string[] = [];

  // (替 换 v0.37.39 硬 编 码 TAVILY_QUERIES → dynamic queries)
  const queries = await getDynamicQueries(env);
  if (queries.length === 0) {
    return jsonResponse(
      {
        source: 'tavily',
        fetched: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: ['no dynamic queries available (topics/news_hotspots/R2 all empty)'],
        elapsed_ms: Date.now() - start,
      },
      cors
    );
  }

  for (const query of queries) {
    const articles = await fetchTavilyNews(env, apiKey, query, maxPerQuery);
    if (articles.length === 0 && apiKey && apiKey !== 'YOUR_KEY_HERE') {
      fetchErrors.push(`query="${query}" returned 0 results`);
    }
    allArticles.push(...articles);
  }

  // Nothing fetched
  if (allArticles.length === 0) {
    return jsonResponse(
      {
        source: 'tavily',
        fetched: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: fetchErrors,
        elapsed_ms: Date.now() - start,
      },
      cors
    );
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const uniqueArticles = allArticles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  const results: TavilyResultItem[] = [];
  const pendingNews: TavilyPendingItem[] = [];
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
      embedding = await embedTitle(env, title, article.summary);

      if (embedding.length > 0) {
        const similar = await findSimilarForEmbedding(env, embedding, 0.88, 3);
        if (similar.length > 0 && similar[0].topic_id) {
          const top = similar[0];
          topicId = top.topic_id;
          // v0.37.37: hot_score → delta 5 档 映射 · 跟 endpoints-process 同 范式
          const rule = scoreTitle(title);
          const delta = mapNewsScoreToDelta(rule.score);
          const updated = await updateTopicScoreByIdWithDelta(env, top.topic_id, delta);
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

  return jsonResponse(
    {
      source: 'tavily',
      fetched: uniqueArticles.length,
      inserted,
      skipped_duplicates: skipped,
      errors: fetchErrors,
      elapsed_ms: Date.now() - start,
      items: results,
    },
    cors
  );
}
