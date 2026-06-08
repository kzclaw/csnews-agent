// ============================================================
// News Self Growth核心函数（v0.33+sweep·FT-KR0 · Phase0 · T000）
// ============================================================
//用途：KR0 News Self Growth流水线核心 ·9 个函数实现话题簇/新闻/查重/趋势/存储
//详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
// specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}
import { Env, supabaseFetch, safeJson } from './shared';

//清理过期话题簇(跟进7天/重要14天/爆炸28天)
export async function cleanupStaleTopics(env: Env) {
 const { data } = await (await supabaseFetch(env, '/rest/v1/rpc/cleanup_stale_topics', {
 method: 'POST',
 })).json() as any;
 return data?.[0] || { deleted_topic_count:0, deleted_news_count:0 };
}

//向量查重:查相似新闻
export async function findSimilarNews(env: Env, embedding: number[], threshold =0.88, matchCount =5) {
 const res = await supabaseFetch(env, '/rest/v1/rpc/find_similar_news', {
 method: 'POST',
 body: JSON.stringify({ query_embedding: embedding, threshold, match_count: matchCount }),
 });
 const data = await safeJson(res) as any[];
 return data || [];
}

//更新话题簇积分
export async function updateTopicScore(env: Env, topicId: string, delta =1) {
 const res = await supabaseFetch(env, '/rest/v1/rpc/update_topic_score', {
 method: 'POST',
 body: JSON.stringify({ p_topic_id: topicId, p_score_delta: delta }),
 });
 const data = await safeJson(res) as any[];
 return data?.[0] || { new_score:0, new_level: 'follow', upgraded: false, fission_triggered: false };
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
 console.error(`[TIE] record_trend_snapshot HTTP ${res.status} for ${topicId}: ${errText.slice(0,200)}`);
 return null;
 }
 const data = await safeJson(res) as any[];
 return Array.isArray(data) ? data[0] || null : null;
 } catch (e: any) {
 console.error(`[TIE] record_trend_snapshot threw for ${topicId}: ${e?.message || e}`);
 return null;
 }
}

//插入话题簇
export async function createTopic(env: Env, topicKey: string, level = 'follow', firstNewsId?: string): Promise<any> {
 const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
 await supabaseFetch(env, '/rest/v1/topics', {
 method: 'POST',
 body: JSON.stringify({ id, topic_key: topicKey, level, score:0, first_news_id: firstNewsId }),
 });
 return { id, topic_key: topicKey, level, score:0, first_news_id: firstNewsId };
}

//插入新闻记录
export async function insertNewsHotspot(env: Env, news: {
 title: string; url?: string; source?: string; category?: string;
 hot_score?: number; published_at?: string; summary?: string;
 embedding?: number[]; r2_key?: string; topic_id?: string;
 level?: string; score?: number; is_stored_r2?: boolean;
}): Promise<string | null> {
 //生成确定性 UUID(基于 title + timestamp),避免响应体被 Cloudflare截断
 const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const newsWithId = { id, ...news };
 await supabaseFetch(env, '/rest/v1/news_hotspots', {
 method: 'POST',
 body: JSON.stringify(newsWithId),
 });
 return id;
}

//关联新闻-话题
export async function joinTopicMember(env: Env, newsId: string, topicId: string, role = 'follow'): Promise<boolean> {
 const res = await supabaseFetch(env, '/rest/v1/news_topic_members', {
 method: 'POST',
 body: JSON.stringify({ news_id: newsId, topic_id: topicId, role }),
 headers: { 'Prefer': 'return=representation' },
 });
 const raw = await res.text();
 return !!(raw && raw.trim() && (raw !== '[]'));
}

//R2存储(去重存储层)
export async function saveToR2(env: Env, prefix: string, data: object): Promise<string> {
 const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;
 await env.csnews_raw.put(key, JSON.stringify(data), {
 httpMetadata: { contentType: 'application/json' },
 });
 return key;
}
