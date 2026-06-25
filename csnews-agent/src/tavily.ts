// ============================================================
// Tavily News API client — second data source for CSNEWS
// ============================================================
// Normalized articles flow into the same insert pipeline as ZAKER.
// Cross-source dedup: each article is checked against Vectorize
// before insertion (similarity > 0.88 → skip).

import { Env } from './shared';
import { logEvent } from './log';
import {
  embedTitle,
  findSimilarForEmbedding,
} from './process-vector';
import {
  createTopicForTitle,
  updateTopicScoreById,
  insertNewsBatch,
  dualWriteVectors,
  recordTrendForNews,
} from './process-db';

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
  apiKey: string | undefined,
  query: string,
  maxResults = 10
): Promise<NormalizedArticle[]> {
  // Guard: no key configured
  if (!apiKey) {
    console.warn('[Tavily] TAVILY_API_KEY not configured — skipping fetch');
    return [];
  }

  // Test/mock mode: placeholder key
  if (apiKey === 'YOUR_KEY_HERE') {
    console.log('[Tavily] mock mode: returning 3 test articles');
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
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Tavily] HTTP ${res.status}: ${errText.slice(0, 300)}`);
      return [];
    }

    const json = (await res.json()) as TavilySearchResponse;
    const results = json.results || [];

    console.log(`[Tavily] fetched ${results.length} results for query "${query}"`);
    return results.map(normalizeTavilyResult);
  } catch (err) {
    console.error('[Tavily] fetch failed:', err);
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


// ---- cron query list ----
const TAVILY_QUERIES = [
  'top trending news today worldwide',
  'breaking technology business science news',
];

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
  const maxPerQuery = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('max') || '5', 10), 10)
  );

  const allArticles: NormalizedArticle[] = [];
  const fetchErrors: string[] = [];

  for (const query of TAVILY_QUERIES) {
    const articles = await fetchTavilyNews(apiKey, query, maxPerQuery);
    if (articles.length === 0 && apiKey && apiKey !== 'YOUR_KEY_HERE') {
      fetchErrors.push(`query="${query}" returned 0 results`);
    }
    allArticles.push(...articles);
  }

  // Nothing fetched
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
