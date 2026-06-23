/**
 * CSNEWS Fission Worker · 裂变触发器
 *
 * 职责：定时扫描 explosive stage + score=9 的 topic，触发裂变流程
 *
 * 裂变触发条件（SPEC.md Section 1.2）：
 *   - topic score = 9（第三次达到升级阈值）
 *   - topic stage = 'explosive'
 *
 * 触发后：
 *   - score 重置为 0，stage 保持 explosive
 *   - 生成裂变报告（搜索词生成 → 并行搜索 → 合并 → 报告写入 R2）
 *   - topics 表更新 fission_count / fission_triggered_at
 *
 * Phase 2：核心逻辑完整实现
 *   - Workers AI 生成搜索词（llama-3-8b-instruct）
 *   - ZAKER 并行搜索 + Tavily fallback
 *   - Workers AI 生成结构化报告
 *   - R2 写入报告 + index 更新
 *   - topics 表状态更新
 */
import { Env, getSupabaseHost } from './shared';
import { supabaseHeaders } from './utils';

// ============================================================
// Types
// ============================================================

export interface FissionTopic {
  id: string;
  title: string;
  stage: string;
  score: number;
  fission_count: number;
  fission_triggered_at: string | null;
}

export interface FissionResult {
  topic_id: string;
  queries: string[];
  report_content: string;
  r2_key: string;
  fission_type: string;
  status: 'completed' | 'failed';
  triggered_at: string;
}

export interface SearchResult {
  title: string;
  url: string;
  published_at?: string;
  source: string;
  summary?: string;
}

interface ZakerArticle {
  title?: string;
  url?: string;
  publish_time?: string;
  summary?: string;
}

interface ZakerHotResponse {
  data?: {
    list?: ZakerArticle[];
  };
}

// ============================================================
// ZAKER Search API
// ============================================================

/**
 * 并行搜索 ZAKER，返回标准化结果
 */
async function searchZaker(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://waps.gz.189.cn/Teleport/Search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[ZAKER] HTTP ${res.status} for query: ${query}`);
      return [];
    }

    const json = (await res.json()) as ZakerHotResponse;
    const list = json.data?.list || [];

    return list.slice(0, 3).map((item) => ({
      title: item.title || '无标题',
      url: item.url || '',
      published_at: item.publish_time || new Date().toISOString(),
      source: 'zaker',
      summary: item.summary || '',
    }));
  } catch (err) {
    console.warn(`[ZAKER] failed for query "${query}":`, err);
    return [];
  }
}

// ============================================================
// Tavily Search (fallback)
// ============================================================

interface TavilySearchResult {
  url: string;
  title: string;
  published_date?: string;
  content?: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
}

/**
 * Tavily News API fallback
 */
async function searchTavily(apiKey: string, query: string): Promise<SearchResult[]> {
  if (!apiKey || apiKey === 'YOUR_KEY_HERE') return [];

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 3,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[Tavily] HTTP ${res.status} for query: ${query}`);
      return [];
    }

    const json = (await res.json()) as TavilySearchResponse;
    return (json.results || []).map((item) => ({
      title: item.title || '无标题',
      url: item.url || '',
      published_at: item.published_date || new Date().toISOString(),
      source: 'tavily',
      summary: item.content ? item.content.substring(0, 200) : undefined,
    }));
  } catch (err) {
    console.warn(`[Tavily] failed for query "${query}":`, err);
    return [];
  }
}

// ============================================================
// Workers AI helpers
// ============================================================

function extractAIResponse(resp: unknown): string {
  if (typeof resp === 'string') return resp.trim();
  if (resp && typeof resp === 'object') {
    const text = ((resp as Record<string, unknown>).response as string | undefined)?.trim();
    if (text) return text;
  }
  return '';
}

/**
 * Workers AI 生成 5 个中文搜索词
 * Fallback: 返回 [topicTitle] 如果 AI 调用失败
 */
async function generateSearchQueries(
  env: Env,
  topicTitle: string,
  relatedNews: string[]
): Promise<string[]> {
  const relatedCtx = relatedNews.length > 0
    ? `相关报道标题：\n${relatedNews.slice(0, 3).map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '暂无相关报道。';

  const prompt = `你是一个新闻裂变搜索词生成专家。

## 任务
基于以下话题标题和相关新闻，生成 5 个中文搜索关键词，用于搜索该话题的更多相关报道。

## 要求
- 每个搜索词不超过 15 个字符
- 覆盖不同角度：事件主体、影响、原因、最新进展等
- 直接输出 JSON 数组格式，不要解释

## 格式
["搜索词1", "搜索词2", "搜索词3", "搜索词4", "搜索词5"]

## 话题
${topicTitle}

${relatedCtx}`;

  try {
    const resp = (await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.3,
    })) as unknown;

    const raw = extractAIResponse(resp);

    // 尝试解析 JSON 数组
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[AI] generated ${parsed.length} search queries for topic`);
        return parsed.slice(0, 5);
      }
    }

    console.warn('[AI] parse failed, using fallback:', raw.slice(0, 100));
    return [topicTitle];
  } catch (err) {
    console.error('[AI] search query generation failed, using fallback:', err);
    return [topicTitle];
  }
}

/**
 * Workers AI 生成裂变报告
 */
async function generateFissionReport(
  env: Env,
  topicTitle: string,
  searchResults: SearchResult[]
): Promise<string> {
  if (searchResults.length === 0) {
    return `# 裂变报告：${topicTitle}

> 警告：本次裂变未获取到任何搜索结果，报告基于已有数据生成。

## 事件背景
话题「${topicTitle}」已达到裂变触发条件（score=9, stage=explosive），系统自动触发裂变分析。

## 当前状态
- 触发时间：${new Date().toISOString()}
- 搜索结果：0 条（ZAKER 和 Tavily 均无返回）

## 分析
由于未获取到最新报道，无法进行深入趋势分析。建议人工关注该话题的后续发展。

---
*由 CSNEWS 裂变引擎自动生成*
`;
  }

  const newsItems = searchResults
    .map((r, i) => `${i + 1}. **${r.title}**\n   来源：${r.source} | ${r.published_at || '时间未知'}\n   ${r.summary || '（无摘要）'}`)
    .join('\n\n');

  const prompt = `你是一个专业的新闻分析记者。

## 任务
基于以下搜索结果，为话题「${topicTitle}」生成一份结构化的裂变分析报告。

## 要求
- 使用中文撰写
- 结构清晰，包含：事件背景、关键发现、趋势分析、相关报道摘要
- 总字数 800-1500 字
- 客观分析，不添加虚构信息

## 格式（Markdown）
# 裂变报告：{话题标题}

## 事件背景
...

## 关键发现
...

## 趋势分析
...

## 相关报道摘要
...

---
*由 CSNEWS 裂变引擎自动生成 · ${new Date().toISOString()}*

## 搜索结果
${newsItems}`;

  try {
    const resp = (await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.4,
    })) as unknown;

    const report = extractAIResponse(resp);
    if (report) {
      console.log(`[AI] fission report generated, ${report.length} chars`);
      return report;
    }
  } catch (err) {
    console.error('[AI] report generation failed:', err);
  }

  // Fallback：纯文本报告
  return `# 裂变报告：${topicTitle}

> 生成失败，以下为原始搜索结果摘要。

## 相关报道
${searchResults.map((r) => `- [${r.title}](${r.url}) (${r.source})`).join('\n')}

---
*由 CSNEWS 裂变引擎自动生成*
`;
}

// ============================================================
// Supabase helpers
// ============================================================

/**
 * 查询满足裂变条件的 topic（最多 1 个）
 */
export async function findFissionTopics(env: Env): Promise<FissionTopic[]> {
  const supabaseUrl = getSupabaseHost(env);
  const sql = `
    SELECT id, title, stage, score,
           COALESCE(fission_count, 0) as fission_count,
           fission_triggered_at
    FROM topics
    WHERE score = 9
      AND stage = 'explosive'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!res.ok) {
      console.error('[fission] findFissionTopics failed:', await res.text());
      return [];
    }

    const data = await res.json() as { result?: FissionTopic[] };
    return data.result || [];
  } catch (err) {
    console.error('[fission] findFissionTopics exception:', err);
    return [];
  }
}

/**
 * 获取 topic 最近的关联 news 标题（最多 3 条）
 */
async function fetchRelatedNews(env: Env, topicId: string): Promise<string[]> {
  const supabaseUrl = getSupabaseHost(env);
  const sql = `
    SELECT n.title
    FROM news_hotspots n
    JOIN news_topic_members ntm ON ntm.news_id = n.id
    WHERE ntm.topic_id = '${topicId}'
    ORDER BY n.created_at DESC
    LIMIT 3
  `;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!res.ok) return [];

    const data = await res.json() as { result?: { title: string }[] };
    return (data.result || []).map((r) => r.title).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 重置 topic 的 score 为 0，fission_count += 1
 */
export async function resetTopicScore(env: Env, topicId: string, currentCount: number): Promise<void> {
  const supabaseUrl = getSupabaseHost(env);
  const now = new Date().toISOString();

  const res = await fetch(`${supabaseUrl}/rest/v1/topics?id=eq.${topicId}`, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      score: 0,
      fission_triggered_at: now,
      fission_count: currentCount + 1,
    }),
  });

  if (!res.ok) {
    console.error('[fission] resetTopicScore failed for topic:', topicId, await res.text());
  } else {
    console.log(`[fission] topic ${topicId} reset score=0, fission_count=${currentCount + 1}`);
  }
}

/**
 * 记录裂变报告到 fission_reports 表（可选，失败不阻断流程）
 */
async function recordFissionReport(env: Env, result: FissionResult): Promise<void> {
  const supabaseUrl = getSupabaseHost(env);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/fission_reports`, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        topic_id: result.topic_id,
        queries: result.queries,
        report_content: result.report_content,
        r2_key: result.r2_key,
        fission_type: result.fission_type,
        status: result.status,
        triggered_at: result.triggered_at,
        completed_at: result.status === 'completed' ? new Date().toISOString() : null,
      }),
    });

    if (!res.ok) {
      console.warn('[fission] recordFissionReport failed:', await res.text());
    } else {
      console.log('[fission] fission_report recorded for topic:', result.topic_id);
    }
  } catch (err) {
    console.warn('[fission] recordFissionReport exception:', err);
  }
}

// ============================================================
// R2 helpers
// ============================================================

interface FissionIndex {
  reports: FissionIndexEntry[];
}

interface FissionIndexEntry {
  topic_id: string;
  topic_title: string;
  r2_key: string;
  fission_count: number;
  triggered_at: string;
}

/**
 * 读取 R2 fission index
 */
async function readFissionIndex(env: Env): Promise<FissionIndex> {
  try {
    const obj = await env.csnews_raw.get('fission/_index.json');
    if (!obj) return { reports: [] };
    return (await obj.json()) as FissionIndex;
  } catch {
    return { reports: [] };
  }
}

/**
 * 更新 R2 fission index（追加一条记录）
 */
async function appendFissionIndex(env: Env, entry: FissionIndexEntry): Promise<void> {
  const index = await readFissionIndex(env);
  index.reports.push(entry);

  await env.csnews_raw.put('fission/_index.json', JSON.stringify(index, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  console.log(`[R2] fission index updated, total reports: ${index.reports.length}`);
}

// ============================================================
// Parallel search
// ============================================================

/**
 * 并行搜索：每个词调 ZAKER，失败后自动 fallback Tavily
 */
async function parallelSearch(
  queries: string[],
  tavilyKey?: string
): Promise<SearchResult[]> {
  const promises = queries.map(async (query): Promise<SearchResult[]> => {
    let results = await searchZaker(query);

    if (results.length === 0 && tavilyKey) {
      results = await searchTavily(tavilyKey, query);
    }

    return results;
  });

  const settled = await Promise.allSettled(promises);

  const allResults: SearchResult[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      allResults.push(...outcome.value);
    } else {
      console.warn(`[search] query "${queries[i]}" all sources failed`);
    }
  });

  // 去重（按 URL）
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  console.log(`[search] total=${allResults.length} unique=${deduped.length} from ${queries.length} queries`);
  return deduped;
}

// ============================================================
// Main fission flow
// ============================================================

/**
 * 执行单个 topic 的裂变流程（Phase 2 完整实现）
 */
export async function runFissionForTopic(
  env: Env,
  topic: FissionTopic
): Promise<void> {
  console.log(`[fission] processing topic=${topic.id} title="${topic.title}"`);

  const now = new Date().toISOString();
  let queries: string[] = [];
  let reportContent = '';
  let r2Key = '';

  try {
    // Step 1: 获取关联新闻标题（用于 LLM 上下文）
    console.log('[fission] step 1/5 fetching related news...');
    const relatedNews = await fetchRelatedNews(env, topic.id);
    console.log(`[fission] found ${relatedNews.length} related news items`);

    // Step 2: LLM 生成搜索词
    console.log('[fission] step 2/5 generating search queries...');
    queries = await generateSearchQueries(env, topic.title, relatedNews);
    console.log(`[fission] queries: ${JSON.stringify(queries)}`);

    // Step 3: 并行搜索（ZAKER + Tavily fallback）
    console.log('[fission] step 3/5 parallel search...');
    const searchResults = await parallelSearch(queries, env.TAVILY_API_KEY);

    // Step 4: LLM 生成裂变报告
    console.log('[fission] step 4/5 generating fission report...');
    reportContent = await generateFissionReport(env, topic.title, searchResults);

    // Step 5: 写入 R2（报告 + index）
    const yearMonth = now.slice(0, 7); // e.g. "2026-06"
    r2Key = `fission/${yearMonth}/${topic.id}-${now.replace(/[:.]/g, '-')}.md`;

    await env.csnews_raw.put(r2Key, reportContent, {
      httpMetadata: { contentType: 'text/markdown' },
    });
    console.log(`[R2] report written: ${r2Key}`);

    // 更新 index
    await appendFissionIndex(env, {
      topic_id: topic.id,
      topic_title: topic.title,
      r2_key: r2Key,
      fission_count: topic.fission_count + 1,
      triggered_at: now,
    });

    // 记录到 Supabase fission_reports（可选，失败不阻断）
    await recordFissionReport(env, {
      topic_id: topic.id,
      queries,
      report_content: reportContent,
      r2_key: r2Key,
      fission_type: 'expansion',
      status: 'completed',
      triggered_at: now,
    });

    // 重置 topic score
    await resetTopicScore(env, topic.id, topic.fission_count);

    console.log(`[fission] completed topic=${topic.id} r2_key=${r2Key}`);
  } catch (err) {
    console.error(`[fission] error for topic=${topic.id}:`, err);

    // 即使失败也记录
    await recordFissionReport(env, {
      topic_id: topic.id,
      queries,
      report_content: `Fission failed: ${String(err)}\n\nPartial report:\n${reportContent}`,
      r2_key: r2Key,
      fission_type: 'expansion',
      status: 'failed',
      triggered_at: now,
    });

    // 失败时仍重置 score，避免无限重试
    await resetTopicScore(env, topic.id, topic.fission_count);
  }
}

/**
 * 主入口：扫描所有满足条件的 topic 并执行裂变
 */
export async function runFissionTrigger(env: Env): Promise<void> {
  console.log('[fission] scanning for explosive topics with score=9...');

  const topics = await findFissionTopics(env);

  if (topics.length === 0) {
    console.log('[fission] no topics match fission criteria, skipping');
    return;
  }

  // 每次最多处理 1 个 topic（节省 Neurons 预算）
  const topic = topics[0];
  console.log(`[fission] found ${topics.length} topic(s), processing 1: ${topic.title}`);
  await runFissionForTopic(env, topic);
}
