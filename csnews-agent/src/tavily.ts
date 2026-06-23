// ============================================================
// Tavily News API client — second data source for CSNEWS
// ============================================================
// Normalized articles flow into the same insert pipeline as ZAKER.
// Cross-source dedup: each article is checked against Vectorize
// before insertion (similarity > 0.88 → skip).

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
