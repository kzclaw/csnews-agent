// ============================================================
// News Self Growth 核心函数
// ============================================================
//用途：News Self Growth 流水线核心 · 9 个函数实现话题簇/新闻/查重/趋势/存储
import { Env, supabaseFetch, safeJson } from './shared';
import { logEvent } from './log';
import { VectorizeClient } from './vectorize';
import type {
  CleanupStaleTopicsResult,
  SimilarNewsItem,
  UpdateTopicScoreResult,
  RecordTrendWithMemberResult,
  InsertedNewsHotspotRow,
} from './types';

//清理过期话题簇(跟进7天/重要14天/爆炸28天)
export async function cleanupStaleTopics(env: Env) {
  // Supabase PostgREST RPC 返回数组，不包装 {data} 对象
  const json = (await (
    await supabaseFetch(env, '/rest/v1/rpc/cleanup_stale_topics', {
      method: 'POST',
    })
  ).json()) as CleanupStaleTopicsResult[] | null;
  if (!json) return { deleted_topic_count: 0, deleted_news_count: 0 };
  return json[0] || { deleted_topic_count: 0, deleted_news_count: 0 };
}

//向量查重:查相似新闻 (Vectorize-first with Supabase fallback)
export async function findSimilarNews(
  env: Env,
  embedding: number[],
  threshold = 0.88,
  matchCount = 5
): Promise<SimilarNewsItem[]> {
  // Try Vectorize first
  const vectorClient = new VectorizeClient(env.VECTORIZE);
  if (vectorClient.isAvailable()) {
    try {
      const vectorResults = await vectorClient.query(embedding, matchCount);
      if (vectorResults.length > 0) {
        // Fetch topic_ids from Supabase for the Vectorize results
        const ids = vectorResults.map((r) => r.id);
        const idsParam = ids.map((id) => `"${id}"`).join(',');
        const res = await supabaseFetch(
          env,
          `/rest/v1/news_hotspots?id=in.(${idsParam})&select=id,topic_id`,
          { method: 'GET' }
        );
        if (res.ok) {
          const newsItems = (await safeJson(res)) as Array<{ id: string; topic_id: string | null }>;
          // Map scores back to results
          const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));
          const results: SimilarNewsItem[] = newsItems
            .filter((n) => n.topic_id)
            .map((n) => ({
              topic_id: n.topic_id!,
              similarity: scoreMap.get(n.id) || 0,
            }));
          console.log(`[findSimilarNews] Vectorize hit: ${results.length} results`);
          return results;
        }
        console.warn('[findSimilarNews] Failed to fetch topic_ids from Supabase');
      }
    } catch (err) {
      console.warn('[findSimilarNews] Vectorize query failed, falling back to Supabase:', err);
    }
  }

  // Phase 2: Fall back to Supabase pgvector
  console.log('[findSimilarNews] Using Supabase fallback');
  const res = await supabaseFetch(env, '/rest/v1/rpc/find_similar_news', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: embedding, threshold, match_count: matchCount }),
  });
  const data = (await safeJson(res)) as SimilarNewsItem[];
  return data || [];
}

//更新话题簇积分
export async function updateTopicScore(env: Env, topicId: string, delta = 1) {
  const res = await supabaseFetch(env, '/rest/v1/rpc/update_topic_score', {
    method: 'POST',
    body: JSON.stringify({ p_topic_id: topicId, p_score_delta: delta }),
  });
  const data = (await safeJson(res)) as UpdateTopicScoreResult[];
  return (
    data?.[0] || { new_score: 0, new_level: 'follow', upgraded: false, fission_triggered: false }
  );
}

//记录 TIE-lite趋势快照并按规则触发 warning，不调用 LLM
export async function recordTrendSnapshot(env: Env, topicId: string) {
  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/record_trend_snapshot', {
      method: 'POST',
      body: JSON.stringify({ p_topic_id: topicId }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[TIE] record_trend_snapshot HTTP ${res.status} for ${topicId}: ${errText.slice(0, 200)}`
      );
      return null;
    }
    const data = (await safeJson(res)) as RecordTrendWithMemberResult[];
    return Array.isArray(data) ? data[0] || null : null;
  } catch (e: any) {
    console.error(`[TIE] record_trend_snapshot threw for ${topicId}: ${e?.message || e}`);
    return null;
  }
}

//插入话题簇
export async function createTopic(
  env: Env,
  topicKey: string,
  level = 'follow',
  firstNewsId?: string
): Promise<any> {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await supabaseFetch(env, '/rest/v1/topics', {
    method: 'POST',
    body: JSON.stringify({ id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId }),
  });
  return { id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId };
}

//插入新闻记录
export async function insertNewsHotspot(
  env: Env,
  news: {
    title: string;
    url?: string;
    source?: string;
    category?: string;
    hot_score?: number;
    published_at?: string;
    summary?: string;
    embedding?: number[];
    r2_key?: string;
    topic_id?: string;
    level?: string;
    score?: number;
    is_stored_r2?: boolean;
  }
): Promise<string | null> {
  //生成确定性 UUID(基于 title + timestamp),避免响应体被 Cloudflare截断
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newsWithId = { id, ...news };
  await supabaseFetch(env, '/rest/v1/news_hotspots', {
    method: 'POST',
    body: JSON.stringify(newsWithId),
  });

  // Dual-write embedding to Vectorize
  if (news.embedding && news.embedding.length > 0) {
    const vectorClient = new VectorizeClient(env.VECTORIZE);
    vectorClient.upsert(news.embedding, id, {
      title: news.title,
      category: news.category || '',
    }).catch((err) => {
      console.error('[Vectorize] dual-write failed:', err);
    });
  }

  return id;
}

//关联新闻-话题
export async function joinTopicMember(
  env: Env,
  newsId: string,
  topicId: string,
  role = 'follow'
): Promise<boolean> {
  const res = await supabaseFetch(env, '/rest/v1/news_topic_members', {
    method: 'POST',
    body: JSON.stringify({ news_id: newsId, topic_id: topicId, role }),
    headers: { Prefer: 'return=representation' },
  });
  const raw = await res.text();
  return !!(raw && raw.trim() && raw !== '[]');
}

//R2存储(去重存储层)
export async function saveToR2(env: Env, prefix: string, data: object): Promise<string> {
  const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await env.csnews_raw.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return key;
}

// ============================================================
// batch insert optimization (v0.36.10)
// ============================================================
//用途：handleProcessAction 每次 cron 调用 10 条新闻, 优化 subrequest 数从 ~56 降到 ~37

//批量插入新闻记录: 单次 subrequest 插 N 条, 返 N 个 id 对应原 array 顺序
export async function insertNewsHotspotsBatch(
  env: Env,
  newsList: Array<{
    title: string;
    url?: string;
    source?: string;
    category?: string;
    hot_score?: number;
    published_at?: string;
    summary?: string;
    embedding?: number[];
    r2_key?: string;
    topic_id?: string;
    level?: string;
    score?: number;
    is_stored_r2?: boolean;
  }>
): Promise<string[]> {
  if (!newsList.length) return [];
  //Client-side 生成 UUID (Supabase 批量 insert 默认不返确定性 id)
  const withIds = newsList.map((n) => ({
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...n,
  }));
  // 2026-06-17 18:48 fix: union 所有 row keys + 缺 key 补 null
  // 修 PGRST102 "All object keys must match" bug:
  //   之前 undefined JSON.stringify 整 key 消失 → 有/无 embedding row keys 数不一致
  //   现在补 null → JSON.stringify 保留 key → 所有 row 14 keys 一致
  //   pgvector embedding 列 schema 允许 NULL (无 NOT NULL 约束) 所以 null 安全
  const allKeys = Array.from(new Set(withIds.flatMap((r) => Object.keys(r))));
  const normalizedRows = withIds.map((r) => {
    // 每个 key 的值类型取决于 news 属性：string | number | number[] | boolean | null
    const out: Record<string, string | number | number[] | boolean | null> = {};
    for (const k of allKeys)
      out[k] =
        (r as Record<string, string | number | number[] | boolean | null | undefined>)[k] ?? null;
    return out;
  });
  const res = await supabaseFetch(env, '/rest/v1/news_hotspots', {
    method: 'POST',
    body: JSON.stringify(normalizedRows),
    headers: { Prefer: 'return=representation' },
  });
  // 2026-06-17 修订: 用 logEvent (fire-and-forget R2) 诊断 batch 静默 fail
  // 不 throw 避免破坏 cron 行为 (return [] 仍然让 caller 走 else 分支)
  // 上一版 console.log 错: console.log 只到 CF Workers Tail Logs, 不自动写 R2 csnews_raw
  await logEvent(
    env,
    'info',
    'batch-insert response',
    {
      rows: withIds.length,
      status: res.status,
      ok: res.ok,
      content_type: res.headers.get('content-type') || 'n/a',
    },
    'process'
  );
  if (!res.ok) {
    const errText = await res.text();
    await logEvent(
      env,
      'error',
      'batch-insert HTTP errBody',
      {
        status: res.status,
        err_body: errText.slice(0, 500),
        sample_row_fields: Object.keys(withIds[0] || {}).join(','),
      },
      'process'
    );
    return [];
  }
  const data = (await safeJson(res)) as InsertedNewsHotspotRow[];
  await logEvent(
    env,
    'info',
    'batch-insert result',
    {
      returned_ids: data?.length || 0,
      expected_ids: withIds.length,
      sample_returned: JSON.stringify(data?.[0] || null).slice(0, 300),
    },
    'process'
  );
  //返 ids 按输入顺序 (Supabase PostgREST 保证 RETURNING 顺序 = INSERT 顺序)
  return Array.isArray(data) ? data.map((r) => r.id) : [];
}

// Dual-write embeddings to Vectorize after batch insert
// Called after insertNewsHotspotsBatch returns successfully
export async function dualWriteEmbeddingsToVectorize(
  env: Env,
  newsList: Array<{
    title: string;
    category?: string;
    embedding?: number[];
  }>,
  ids: string[]
): Promise<void> {
  const vectorClient = new VectorizeClient(env.VECTORIZE);
  if (!vectorClient.isAvailable()) {
    console.warn('[Vectorize] binding not available, skipping dual-write');
    return;
  }

  const vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string | number | boolean> }> = [];

  for (let i = 0; i < newsList.length; i++) {
    const news = newsList[i];
    const id = ids[i];
    if (news.embedding && news.embedding.length > 0 && id) {
      vectors.push({
        id,
        values: news.embedding,
        metadata: {
          title: news.title,
          category: news.category || '',
        },
      });
    }
  }

  if (vectors.length === 0) {
    return;
  }

  try {
    await env.VECTORIZE!.upsert(vectors);
    console.log(`[Vectorize] dual-write batch upserted ${vectors.length} vectors`);
  } catch (err) {
    console.error('[Vectorize] dual-write batch failed:', err);
    // Don't throw — Vectorize failure should not block process flow
  }
}

//合并 join_topic_member + record_trend_snapshot 为 1 个 RPC
//原子事务: news_topic_members INSERT + trend_snapshots INSERT + warnings INSERT 一起提交
export async function recordTrendWithMember(
  env: Env,
  newsId: string,
  topicId: string,
  isNewTopic = false
): Promise<any> {
  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/record_trend_with_member', {
      method: 'POST',
      body: JSON.stringify({ p_news_id: newsId, p_topic_id: topicId, p_is_seed: isNewTopic }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `record_trend_with_member HTTP ${res.status} for ${newsId}/${topicId}: ${errText.slice(0, 200)}`
      );
      return null;
    }
    // record_trend_with_member RPC 返回形状由 SQL 函数决定，用 RecordTrendWithMemberResult
    const data = (await safeJson(res)) as RecordTrendWithMemberResult[];
    return Array.isArray(data) ? data[0] || null : null;
  } catch (e: any) {
    console.error(`record_trend_with_member threw for ${newsId}/${topicId}: ${e?.message || e}`);
    return null;
  }
}
