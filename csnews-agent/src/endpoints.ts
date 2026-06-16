// ============================================================
// 16 个 Action Handler
// ============================================================
// 用途：从 index.ts 抽出 16 个 action=xxx 端点处理函数
// 通用 pull 在独立 pull.ts
// 新增 health + logs 端点 (Worker 可观测性)
// 详见：tasks/csnews-agent-okr.md (本地私密 OKR 文档, 不入库)
import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { NewsItem } from './types';
import { handlePull } from './pull';
import { corsHeaders } from './auth';
import { classify, classifyByAI, classifyRule } from './classify';
import { scoreRule, AI_ROUTE_R_THRESHOLD, TOPIC_MATCH_THRESHOLD, R2_DUP_THRESHOLD, hashStr } from './score';
import { cleanupStaleTopics, findSimilarNews, updateTopicScore, recordTrendSnapshot, createTopic, insertNewsHotspot, saveToR2, joinTopicMember } from './news-process';
import { logEvent } from './log';
import { validateId, validateFormat, rateKeyForIp, dailyHitsKeyForToday, escapeHtml, RATE_LIMIT_PER_MIN, PAYLOAD_LIMIT_BYTES } from './content-validation';
import { validateType, validateSince, validateLimit, rateKeyForIp as trendRateKeyForIp, dailyHitsKeyForToday as trendHitsKeyForToday, RATE_LIMIT_PER_MIN as TREND_RATE_LIMIT_PER_MIN, PAYLOAD_LIMIT_BYTES as TREND_PAYLOAD_LIMIT_BYTES } from './trend-validation';
import { validateType as knowledgeValidateType, validateSince as knowledgeValidateSince, validateLimit as knowledgeValidateLimit, validateTopicId, rateKeyForIp as knowledgeRateKeyForIp, dailyHitsKeyForToday as knowledgeHitsKeyForToday, RATE_LIMIT_PER_MIN as KNOWLEDGE_RATE_LIMIT_PER_MIN, PAYLOAD_LIMIT_BYTES as KNOWLEDGE_PAYLOAD_LIMIT_BYTES, knowledgeR2Key, KNOWLEDGE_INDEX_KEY } from './knowledge-validation';
import { countAnomalySignals, Z_THRESHOLD, ZSCORE_REASON_PREFIX } from './zscore';
import { getBudgetStatus } from './ai-budget';
import { runEntitySelfLearn, ENTITY_CANDIDATES_R2_KEY } from './entity-selflearn';
import { runEntityProcess, ENTITY_FINALIZED_R2_KEY } from './entity-process';

// ===================== pull =====================
export async function handlePullAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 try {
 const result = await handlePull(env, url);
 return new Response(JSON.stringify(result), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 } catch (e: any) {
 const status = e.status ||500;
 return new Response(JSON.stringify({ error: e.message || 'pull failed' }), {
 status,
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
}

// ===================== diag =====================
export async function handleDiagAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const results = [];

 //1. Insert topic
 const tr = await fetch(`${getSupabaseHost(env)}/rest/v1/topics`, {
 method: 'POST',
 body: JSON.stringify({ topic_key: 'diag-' + Date.now(), level: 'follow' }),
 headers: {
 'apikey': env.SUPABASE_SERVICE_KEY,
 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
 'Content-Type': 'application/json',
 'Prefer': 'return=representation',
 }
 });
 const t0t = await tr.text();
 let t0id = null;
 try { const d = JSON.parse(t0t); t0id = d?.[0]?.id || d?.id; } catch {}
 results.push({ step: 'topic_insert', status: tr.status, id: t0id, body: t0t.slice(0,100) });

 //2. Insert news
 const nr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_hotspots`, {
 method: 'POST',
 body: JSON.stringify({ title: 'diag-' + Date.now(), source: 'zaker', category: '测试' }),
 headers: {
 'apikey': env.SUPABASE_SERVICE_KEY,
 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
 'Content-Type': 'application/json',
 'Prefer': 'return=representation',
 }
 });
 const t1t = await nr.text();
 let t1id = null;
 try { const d = JSON.parse(t1t); t1id = d?.[0]?.id || d?.id; } catch {}
 results.push({ step: 'news_insert', status: nr.status, id: t1id, body: t1t.slice(0,100) });

 //3. Join (if both IDs exist)
 if (t0id && t1id) {
 const jr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_topic_members`, {
 method: 'POST',
 body: JSON.stringify({ news_id: t1id, topic_id: t0id, role: 'seed' }),
 headers: {
 'apikey': env.SUPABASE_SERVICE_KEY,
 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
 'Content-Type': 'application/json',
 'Prefer': 'return=representation',
 }
 });
 const t2t = await jr.text();
 results.push({ step: 'join', status: jr.status, body: t2t.slice(0,200) });
 } else {
 results.push({ step: 'join', status: -1, reason: 'missing IDs', tid: t0id, nid: t1id });
 }

 return new Response(JSON.stringify({ ts: Date.now(), results }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== ping =====================
export async function handlePingAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== model-test =====================
// 注:extractText + maybeFissionReport 已抽到 utils.ts (T000 helper,避免循环依赖)
import { extractText, maybeFissionReport } from './utils';

export async function handleModelTestAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const r = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
 messages: [{ role: 'user', content: '说一段话介绍自己' }],
 max_tokens:100,
 }) as any;
 return new Response(JSON.stringify({
 ok: true,
 model: 'llama-3-8b-instruct',
 response: extractText(r).substring(0,200),
 }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== ai-test =====================
export async function handleAiTestAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const title = url.searchParams.get('title') || 'OpenAI发布GPT-5,AI行业迎来新一轮革命';
 const report = await maybeFissionReport(title, env,9.0); // test always uses high score
 return new Response(JSON.stringify({ title, report }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== score =====================
export async function handleScoreAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const title = url.searchParams.get('title');
 if (!title) {
 return new Response(JSON.stringify({ error: 'missing title param' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }

 const rule = scoreRule(title);
 const category = await classify(title, env);
 const useAI = url.searchParams.get('ai') !== 'false';
 let aiReport = '';

 if (useAI) {
 aiReport = await maybeFissionReport(title, env, rule.score);
 }

 return new Response(JSON.stringify({
 title,
 score: rule.score,
 category,
 reason: rule.reason,
 ai_report: aiReport,
 }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== classify =====================
export async function handleClassifyAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const title = url.searchParams.get('title');
 if (!title) {
 return new Response(JSON.stringify({ error: 'missing title param' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
 const aiCat = await classifyByAI(title, env);
 const kwCat = classifyRule(title);
 return new Response(JSON.stringify({ title, aiCat, kwCat }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== batch-score =====================
export async function handleBatchScoreAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 let body: { items: NewsItem[]; use_ai?: boolean } | null = null;
 try {
 body = await request.json();
 } catch {
 return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }

 const items = body?.items || [];
 const useAI = body?.use_ai !== false;

 const results = await Promise.all(items.map(async (item) => {
 const rule = scoreRule(item.title);
 const category = await classify(item.title, env);
 let aiReport = '';
 if (useAI) {
 aiReport = await maybeFissionReport(item.title, env, rule.score);
 }
 return {
 title: item.title,
 score: rule.score,
 category,
 reason: rule.reason,
 ai_report: aiReport,
 };
 }));

 return new Response(JSON.stringify({ count: results.length, results }, null,2), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== fission =====================
export async function handleFissionAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const seed = url.searchParams.get('seed') || url.searchParams.get('title');
 if (!seed) {
 return new Response(JSON.stringify({ error: 'missing seed param' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
 const r = scoreRule(seed);
 if (r.score < AI_ROUTE_R_THRESHOLD) {
 return new Response(JSON.stringify({
 seed,
 queries: [],
 count:0,
 skipped: true,
 reason: `R=${r.score} < ${AI_ROUTE_R_THRESHOLD}，AI跳过`
 }), { headers: { 'Content-Type': 'application/json', ...cors } });
 }
 try {
 const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
 messages: [
 { role: 'user', content: `生成5个深度裂变搜索查询词(每个不超过15字),用|分隔:
新闻:${seed}` }
 ],
 max_tokens:200,
 temperature:0.3,
 }) as any;
 const text = extractText(resp);
 const queries = text.split('|').map(q => q.trim()).filter(q => q.length >0 && q.length <=20);
 return new Response(JSON.stringify({ seed, queries, count: queries.length }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 } catch (e: any) {
 return new Response(JSON.stringify({ error: e.message }), {
 status:500, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
}

// ===================== save =====================
export async function handleSaveAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const title = url.searchParams.get('title') || '';
 const category = url.searchParams.get('category') || '综合';
 const score = parseFloat(url.searchParams.get('score') || '5');
 const source = url.searchParams.get('source') || 'zaker';

 if (!title) {
 return new Response(JSON.stringify({ error: 'missing title' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }

 try {
 const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
 const item = { id, title, category, score, source, created_at: new Date().toISOString() };
 const key = `news/${source}/${id}.json`;
 await env.csnews_raw.put(key, JSON.stringify(item), {
 httpMetadata: { contentType: 'application/json' },
 });
 return new Response(JSON.stringify({ ok: true, key, item }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 } catch (e: any) {
 return new Response(JSON.stringify({ error: e.message }), {
 status:500, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
}

// ===================== list =====================
export async function handleListAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const prefix = url.searchParams.get('prefix') || 'news/zaker/';
 // 支持 ?limit=N（默认50，上限200）和 ?order=desc|asc（默认 desc，因为 R2 list 默认字典序是 asc）
 const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'),200);
 const order = (url.searchParams.get('order') || 'desc').toLowerCase();
 const list = await env.csnews_raw.list({ prefix });
 // R2 list() 不支持 order，必须客户端排序（修复 KR0 #1）
 const sorted = [...list.objects].sort((a, b) =>
 order === 'desc' ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)
 );
 const items = await Promise.all(
 sorted.slice(0, limit).map(async (obj) => {
 const body = await env.csnews_raw.get(obj.key);
 const text = await body?.text();
 try { return JSON.parse(text || '{}'); } catch { return { key: obj.key }; }
 })
 );
 return new Response(JSON.stringify({
 count: items.length,
 total: list.objects.length,
 truncated: list.objects.length > limit,
 order,
 items,
 }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
}

// ===================== embed =====================
export async function handleEmbedAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 const text = url.searchParams.get('text') || url.searchParams.get('title') || '';
 if (!text) {
 return new Response(JSON.stringify({ error: 'missing text param' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }

 try {
 const resp = await env.AI.run('@cf/baai/bge-m3', {
 text: [text],
 }) as any;

 // bge-m3 返回格式:{ shape: [n, dim], data: [...], response: string }
 const raw = resp as any;
 //尝试多种路径取 embedding
 let embedding: number[] = [];
 if (Array.isArray(raw?.data) && raw.data.length >0) {
 const item = raw.data[0];
 if (Array.isArray(item?.embedding)) embedding = item.embedding;
 else if (Array.isArray(item)) embedding = item;
 }

 if (!embedding || embedding.length ===0) {
 return new Response(JSON.stringify({ error: 'embedding empty', shape: raw?.shape, keys: raw ? Object.keys(raw) : [] }), {
 status:500, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }

 //存 R2
 const key = `embeddings/${Date.now()}.json`;
 await env.csnews_raw.put(key, JSON.stringify({ text, embedding, dim: embedding.length, model: 'bge-m3' }), {
 httpMetadata: { contentType: 'application/json' },
 });

 return new Response(JSON.stringify({
 text,
 dim: embedding.length,
 model: '@cf/baai/bge-m3',
 sample: embedding.slice(0,5),
 key,
 }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 } catch (e: any) {
 return new Response(JSON.stringify({ error: e.message }), {
 status:500, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
}

// ===================== zaker-hot =====================
export async function handleZakerHotAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
 try {
 const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
 const json = await r.json() as any;
 const list: any[] = json?.data?.list || [];
 const results = [];

 for (const item of list.slice(0,1)) {
 const title = item.title || '';
 if (!title) continue;

 const rule = scoreRule(title);
 const category = await classify(title, env);

 //跳过向量化和R2,只测Supabase写入
 await insertNewsHotspot(env, {
 title,
 url: item.url || '',
 source: 'zaker',
 category,
 hot_score: rule.score,
 published_at: item.publish_time || new Date().toISOString(),
 summary: (item.summary || '').substring(0,200),
 });

 results.push({ title, category, score: rule.score });
 }

 return new Response(JSON.stringify({ count: results.length, items: results }), {
 headers: { 'Content-Type': 'application/json', ...cors }
 });
 } catch (e: any) {
 return new Response(JSON.stringify({ error: e.message }), {
 status:500, headers: { 'Content-Type': 'application/json', ...cors }
 });
 }
}

// ===================== process (KR0 News Self Growth 主流程) =====================
export async function handleProcessAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
 //Step0:清理过期话题簇(1 subrequest)
 const cleaned = await cleanupStaleTopics(env) as any;

 //Step1:拉 ZAKER热点(1 subrequest)
 const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
 const json = await r.json() as any;
 const list: any[] = json?.data?.list || [];
 if (list.length ===0) {
 return new Response(JSON.stringify({ error: 'no news' }), { headers: { 'Content-Type': 'application/json', ...cors } });
 }

 const results = [];
 //10 items max:
 // - Full flow adds one TIE-lite snapshot RPC after topic join.
 // -6 full items +2 global requests remain under the free Worker subrequest limit.
 // - 后4条只写Supabase(跳过向量查重)节省 Neurons
 const FULL_COUNT =6;

 for (let i =0; i < list.slice(0,10).length; i++) {
 const item = list[i];
 const title = item.title || '';
 if (!title) continue;

 //规则引擎评分+分类
 const rule = scoreRule(title);
 const category = await classify(title, env);

 let topicId: string | undefined;
 let isStoredR2 = false;
 let newsLevel = 'follow';
 let newsScore =0;
 let fission = false;
 let isNewTopic = false;
 let embedding: number[] = [];
 let matchedSimilarity: number | null = null;
 let r2Key: string | undefined;
 let storedReason = i < FULL_COUNT ? 'embedding_empty' : 'lightweight_no_embedding';
 let trendSnapshot: any = null;

 //仅前 FULL_COUNT 条做 embedding + 向量查重(Workers AI CPU限制)
 if (i < FULL_COUNT) {
 try {
 const embResp = await env.AI.run('@cf/baai/bge-m3', { text: [title] }) as any;
 const raw = embResp as any;
 if (Array.isArray(raw?.data) && raw.data.length >0) {
 const it = raw.data[0];
 embedding = Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
 }
 } catch { /* 向量化失败不影响 */ }

 if (embedding.length >0) {
 const similar = await findSimilarNews(env, embedding, TOPIC_MATCH_THRESHOLD,3);
 if (similar.length >0 && similar[0].topic_id) {
 const top = similar[0];
 topicId = top.topic_id;
 const updated = await updateTopicScore(env, top.topic_id,1) as any;
 newsScore = updated.new_score ||0;
 newsLevel = updated.new_level || 'follow';
 fission = updated.fission_triggered || false;

 const simScore = top.similarity ||0;
 matchedSimilarity = simScore;
 if (simScore < R2_DUP_THRESHOLD) {
 r2Key = await saveToR2(env, 'news/zaker', {
 title, category, score: rule.score, source: 'zaker',
 topic_id: topicId, level: newsLevel, fission, similarity: simScore,
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
 //topic_key 只是「topic标识」，相似新闻不依赖它撞同 key
 //（findSimilarNews 已基于 bge-m3 向量聚类，相似新闻走 update_topic_score 不走这里）
 //修复 KR0：原实现对中文标题会被清空（title.slice(0,8).replace(/[^a-zA-Z0-9]/g,'')）
 //改为纯 hashStr，兼容中文；加 't-' 前缀便于辨识
 const titleHash = Math.abs(hashStr(title)).toString(36);
 const topicKey = `t-${titleHash}`;
 const created = await createTopic(env, topicKey, 'follow') as any;
 if (created?.id) {
 topicId = created.id;
 newsScore =0;
 newsLevel = 'follow';
 isNewTopic = true;
 r2Key = await saveToR2(env, 'news/zaker', {
 title, category, score: rule.score, source: 'zaker',
 topic_id: topicId, level: newsLevel, fission: false,
 created_at: new Date().toISOString(),
 });
 isStoredR2 = true;
 storedReason = embedding.length >0 ? 'new_topic' : 'new_topic_without_embedding';
 }
 }
 }

 //Step4:写 Supabase(实时打分层)-1 subrequest
 const newsId = await insertNewsHotspot(env, {
 title,
 url: item.url || '',
 source: 'zaker',
 category,
 hot_score: rule.score,
 published_at: item.publish_time || new Date().toISOString(),
 summary: (item.summary || '').substring(0,200),
 embedding: embedding.length >0 ? embedding : undefined,
 r2_key: r2Key,
 topic_id: topicId,
 level: newsLevel,
 score: newsScore,
 is_stored_r2: isStoredR2,
 });

 //Step5:关联新闻-话题(news_topic_members)-1 subrequest
 if (newsId && topicId) {
 await joinTopicMember(env, newsId, topicId, isNewTopic ? 'seed' : 'follow');
 trendSnapshot = await recordTrendSnapshot(env, topicId);
 }

 results.push({
 title,
 category,
 score: rule.score,
 topic_id: topicId,
 similarity: matchedSimilarity,
 level: newsLevel,
 is_stored_r2: isStoredR2,
 stored_reason: storedReason,
 trend: trendSnapshot ? {
 snapshot_id: trendSnapshot.snapshot_id,
 warning_id: trendSnapshot.warning_id,
 velocity: trendSnapshot.out_velocity, // v0.30.1: RETURNS TABLE 列改名避开 PL/pgSQL歧义
 acceleration: trendSnapshot.out_acceleration, // v0.30.1
 stage: trendSnapshot.out_stage, // v0.30.1
 warning_created: trendSnapshot.out_warning_created, // v0.30.1
 } : null,
 fission,
 });
 if (fission) console.log(`[FISSION] ${title}`);
 }

  // 写 KV last_process_at (v0.36.4 修: ctx.waitUntil → await)
  // scheduled handler 调 fetch(url) → handleProcessAction → fetch 的 ctx.waitUntil 在 fetch 返回后可能被 GC
  // 改 await: handleProcessAction 是 batch endpoint, 多 50ms 无感, 但保证写完才 return
  if (env.PROCESS_STATE) {
    await env.PROCESS_STATE.put("last_process_at", new Date().toISOString(), { expirationTtl: 86400 * 7 });
  }

  return new Response(JSON.stringify({
  processed: results.length,
  cleaned: cleaned?.deleted_topic_count ||0,
  items: results,
  }), { headers: { 'Content-Type': 'application/json', ...cors } });
}

// ===================== health =====================
// ?action=health 端点
// kzclaw 2026-06-12 20:38 确定: health 端点要真的做到能全面检查 health
//
// 9 大维度检查 (每个独立 try/catch, 失败降级但记录到 health_checks 数组):
//  1. worker_version     - 当前部署版本
//  2. last_process_at    - 最近 process 跑时间 (KV 持久化)
//  3. cron_health        - 派生: last_process_at > 1.5h 前 = degraded / > 3h = down
//  4. secret_resolved    - WORKER_SELF_URL secret 是不是占位符 DO_NOT_USE
//  5. supabase_counts    - 6 张表精确行数 (schema-aware query)
//  6. supabase_reachable - Supabase 6 张表是否全部可查 (用 parallel fetch + ok count)
//  7. r2_latest_write    - R2 news/zaker/ 最新写入 (按 created_at 排序, 不用字典序)
//  8. r2_prefix_counts   - R2 各 prefix 行数 (news/embeddings/fission/trends/warnings/logs)
//  9. cron_history       - R2 logs/ 上一小时 [scheduler] log 数量 (判断 cron 跑没跑)
//
// 返回 status 字段 (ok / degraded / down) + 9 维度详情
export async function handleHealthAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const ts = Date.now();
  const checks: Record<string, { status: "ok" | "degraded" | "down" | "unknown"; detail: any }> = {};
  const result: any = {
    worker_version: env.WORKER_VERSION || "unknown",
    status: "ok",  // 整体 status: ok / degraded / down
    ts,
  };

  // ========== 1. worker_version（已设 result.worker_version）==========
  checks.worker_version = { status: "ok", detail: result.worker_version };

  // ========== 2. last_process_at（KV 持久化）==========
  try {
    if (env.PROCESS_STATE) {
      const last = await env.PROCESS_STATE.get("last_process_at");
      result.last_process_at = last;
      checks.last_process_at = { status: last ? "ok" : "degraded", detail: last || "KV empty" };
    } else {
      result.last_process_at = null;
      checks.last_process_at = { status: "down", detail: "PROCESS_STATE KV binding missing" };
    }
  } catch (e: any) {
    result.last_process_at = { error: e?.message || "kv unavailable" };
    checks.last_process_at = { status: "down", detail: e?.message };
  }

  // ========== 3. cron_health（派生）==========
  let cronHealth: "ok" | "degraded" | "down" = "ok";
  if (typeof result.last_process_at === "string") {
    const lastMs = Date.parse(result.last_process_at);
    if (Number.isFinite(lastMs)) {
      const ageMs = ts - lastMs;
      if (ageMs > 3 * 3600_000) cronHealth = "down";
      else if (ageMs > 1.5 * 3600_000) cronHealth = "degraded";
    }
  } else if (checks.last_process_at.status === "down") {
    cronHealth = "down";
  } else {
    // KV 空但不是 down = degraded (没数据不代表没跑, 但也无法判断)
    cronHealth = "degraded";
  }
  result.cron_health = cronHealth;
  checks.cron_health = {
    status: cronHealth,
    detail: typeof result.last_process_at === "string"
      ? `${Math.round((ts - Date.parse(result.last_process_at)) / 60000)} min ago`
      : "no last_process_at recorded"
  };

  // ========== 4. secret_resolved（看 WORKER_SELF_URL 是不是占位符）==========
  const selfUrl = env.WORKER_SELF_URL || "";
  const isPlaceholder = selfUrl === "DO_NOT_USE" ||
                       selfUrl === "https://YOUR-WORKER.workers.dev" ||
                       selfUrl.includes("YOUR-WORKER") ||
                       selfUrl === "";
  checks.secret_resolved = {
    status: isPlaceholder ? "down" : "ok",
    detail: isPlaceholder ? `placeholder: "${selfUrl}"` : `set to non-placeholder URL`
  };

  // ========== 5+6. supabase_counts + supabase_reachable（6 张表 parallel fetch）==========
  // kzclaw 2026-06-12 20:30 确定: 每张表用 schema-aware 列
  const supabaseTables: { name: string; column: string }[] = [
    { name: "news_hotspots", column: "id" },
    { name: "topics", column: "id" },
    { name: "news_topic_members", column: "news_id" },
    { name: "trend_snapshots", column: "id" },
    { name: "warnings", column: "id" },
    { name: "fission_searches", column: "id" },
  ];
  const supabaseCounts: Record<string, number | { error: string }> = {};
  const supabaseResults = await Promise.allSettled(
    supabaseTables.map(async (tbl) => {
      const r = await fetch(`${getSupabaseHost(env)}/rest/v1/${tbl.name}?select=${tbl.column}&limit=0`, {
        headers: {
          "apikey": env.SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Prefer": "count=exact",
        },
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`${tbl.name}: HTTP ${r.status} ${errText.slice(0, 200)}`);
      }
      const cr = r.headers.get("Content-Range") || "";
      const total = cr.split("/").pop();
      return { name: tbl.name, total: (total && total !== "*") ? parseInt(total, 10) : 0 };
    })
  );
  let supabaseOkCount = 0;
  for (let i = 0; i < supabaseResults.length; i++) {
    const r = supabaseResults[i];
    const tblName = supabaseTables[i].name;
    if (r.status === "fulfilled") {
      supabaseCounts[tblName] = r.value.total;
      supabaseOkCount++;
    } else {
      supabaseCounts[tblName] = { error: r.reason?.message || "fetch failed" };
    }
  }
  result.supabase_counts = supabaseCounts;
  checks.supabase_reachable = {
    status: supabaseOkCount === supabaseTables.length ? "ok" : supabaseOkCount === 0 ? "down" : "degraded",
    detail: `${supabaseOkCount}/${supabaseTables.length} tables OK`
  };

  // ========== 7. r2_latest_write（按 created_at 排序的真正最新 news）==========
  // v0.36.1 旧实现 bug: list 默认升序, limit 50 全是老 obj, sort 倒序取到 5-29 范围内最大
  // 修 v0.36.2: list 拿 1000 条 (R2 单次 list 上限) + 按 R2 key 倒序 + get obj content
  try {
    const list = await env.csnews_raw.list({ prefix: "news/zaker/", limit: 1000 });
    if (list.objects && list.objects.length > 0) {
      // 按 R2 key 倒序（key 含毫秒时间戳，字典序 = 时间序）
      const sorted = [...list.objects].sort((a, b) => b.key.localeCompare(a.key));
      const latestObj = sorted[0];
      const body = await env.csnews_raw.get(latestObj.key);
      if (body) {
        const text = await body.text();
        try {
          const parsed = JSON.parse(text);
          result.r2_latest_write = {
            key: latestObj.key,
            created_at: parsed.created_at || null,
            title: parsed.title || null,
          };
          // 看 created_at 多新
          if (parsed.created_at) {
            const writeAgeMs = ts - Date.parse(parsed.created_at);
            if (writeAgeMs < 2 * 3600_000) checks.r2_latest_write = { status: "ok", detail: `last write ${Math.round(writeAgeMs / 60000)} min ago` };
            else if (writeAgeMs < 6 * 3600_000) checks.r2_latest_write = { status: "degraded", detail: `last write ${Math.round(writeAgeMs / 60)} min ago (> 2h)` };
            else checks.r2_latest_write = { status: "down", detail: `last write ${Math.round(writeAgeMs / 3600_000)}h ago (> 6h)` };
          } else {
            checks.r2_latest_write = { status: "unknown", detail: "no created_at field in R2 obj" };
          }
        } catch {
          result.r2_latest_write = { key: latestObj.key, parse_error: true };
          checks.r2_latest_write = { status: "unknown", detail: "R2 obj not JSON" };
        }
      } else {
        result.r2_latest_write = null;
        checks.r2_latest_write = { status: "unknown", detail: "R2 obj body empty" };
      }
    } else {
      result.r2_latest_write = null;
      checks.r2_latest_write = { status: "down", detail: "no objects in news/zaker/" };
    }
  } catch (e: any) {
    result.r2_latest_write = { error: e?.message || "r2 unavailable" };
    checks.r2_latest_write = { status: "down", detail: e?.message };
  }

  // ========== 8. r2_prefix_counts（各 prefix 行数）==========
  const r2Prefixes = ["news/zaker/", "news/", "embeddings/", "fission/", "trends/", "warnings/", "logs/"];
  const r2PrefixCounts: Record<string, number | { error: string }> = {};
  const r2Results = await Promise.allSettled(
    r2Prefixes.map(async (prefix) => {
      const list = await env.csnews_raw.list({ prefix, limit: 1000 });
      return { prefix, count: list.objects?.length || 0 };
    })
  );
  for (let i = 0; i < r2Results.length; i++) {
    const r = r2Results[i];
    const prefix = r2Prefixes[i];
    if (r.status === "fulfilled") {
      r2PrefixCounts[prefix] = r.value.count;
    } else {
      r2PrefixCounts[prefix] = { error: r.reason?.message || "list failed" };
    }
  }
  result.r2_prefix_counts = r2PrefixCounts;

  // ========== 9. cron_history（看上一小时 R2 logs 是否有 [scheduler] log）==========
  // kzclaw 2026-06-12 确定: log 颗粒度做细 → 新格式 key=logs/YYYY-MM-DD/HH/MM-SS-fff-source.log
  // 兼容: 旧格式 logs/YYYY-MM-DD/HH.log (单条 line 在 file 内)
  try {
    const now = new Date(ts);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const list = await env.csnews_raw.list({ prefix: `logs/${yyyy}-${mm}-${dd}/${hh}/`, limit: 100 });
    const thisHourSchedulerLogs = list.objects?.filter((o) => o.key.includes("-scheduler.log")) || [];
    result.cron_history = {
      this_hour: {
        hour: `${yyyy}-${mm}-${dd}T${hh}`,
        scheduler_log_count: thisHourSchedulerLogs.length,
      },
    };
    checks.cron_history = {
      status: thisHourSchedulerLogs.length >= 1 ? "ok" : "degraded",
      detail: thisHourSchedulerLogs.length >= 1
        ? `${thisHourSchedulerLogs.length} scheduler logs this hour`
        : "no scheduler logs this hour (cron may not have run)"
    };
  } catch (e: any) {
    result.cron_history = { error: e?.message };
    checks.cron_history = { status: "unknown", detail: e?.message };
  }

  // ========== 10. zscore_signals_today (KR0+1 · 蓝图 2.5 公式 · v0.36.8) ==========
  // 0 DDL: 从 trend_snapshots 拉 last 7d 算 z-score > 3 的 topic 数
  // OKR KR0+1 确定: "z-score 异常信号 30 天内累计 ≥ 5 条" 指标
  // 5h 配额期"快赢" v2 修订: 推迟到下个 5h 配额期起床后拍 schema migration 时集成到 record_trend_snapshot RPC
  // 5h 配额期 04:39 确定"0 确定点, 蓝图公式已定, 直接推"
  try {
    const sevenDaysAgo = new Date(ts - 7 * 24 * 3600 * 1000).toISOString();
    const snapshotsRes = await supabaseFetch(env, `/rest/v1/trend_snapshots?select=id,topic_id,score,velocity,acceleration,created_at&created_at=gte.${sevenDaysAgo}&order=created_at.desc&limit=500`);
    const snapshots = (await safeJson(snapshotsRes) as any[]) || [];

    let totalAnomalies = 0;
    const anomaliesByField: Record<string, number> = { score: 0, velocity: 0, acceleration: 0 };
    if (snapshots.length >= 2) {
      // 按 topic_id 分组, 对每个 topic 算 z-score
      const byTopic: Record<string, any[]> = {};
      for (const s of snapshots) {
        if (!s.topic_id) continue;
        if (!byTopic[s.topic_id]) byTopic[s.topic_id] = [];
        byTopic[s.topic_id].push(s);
      }
      for (const topicSnapshots of Object.values(byTopic)) {
        if (topicSnapshots.length < 2) continue;
        for (const field of ['score', 'velocity', 'acceleration'] as const) {
          const count = countAnomalySignals(topicSnapshots, field);
          anomaliesByField[field] += count;
          totalAnomalies += count;
        }
      }
    }

    result.zscore_signals_today = {
      total_7d: totalAnomalies,
      by_field_7d: anomaliesByField,
      snapshots_analyzed: snapshots.length,
      window: '7d',
    };
    checks.zscore_signals_today = {
      status: "ok",  // 0 = 正常 (新功能, 没异常是 expected)
      detail: totalAnomalies > 0
        ? `${totalAnomalies} z-score anomalies in last 7d (${JSON.stringify(anomaliesByField)})`
        : `0 anomalies in last 7d (algorithm ready, 起床后 review)`,
    };
  } catch (e: any) {
    result.zscore_signals_today = { error: e?.message || "zscore calc failed" };
    checks.zscore_signals_today = { status: "unknown", detail: e?.message };
  }

  // ========== 11. ai_budget_today (KR0+1 · 蓝图 2.9 · v0.36.9) ==========
  // 复用 ai-budget.ts getBudgetStatus，0 新逻辑
  try {
    const budget = await getBudgetStatus(env);
    result.ai_budget_today = {
      used: budget.used,
      tier: budget.tier,
      remaining: budget.remaining,
      quota: budget.quota,
    };
    checks.ai_budget_today = {
      status: budget.tier === 'shutdown' ? 'down'
        : budget.tier === 'critical' ? 'degraded'
        : 'ok',
      detail: `daily used: ${budget.used} / ${budget.quota} (${budget.tier})`,
    };
  } catch (e: any) {
    result.ai_budget_today = { error: e?.message || "ai_budget calc failed" };
    checks.ai_budget_today = { status: "unknown", detail: e?.message };
  }

  // ========== 整体 status 聚合 ==========
  // down > degraded > ok (取最差)
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes("down")) result.status = "down";
  else if (statuses.includes("degraded")) result.status = "degraded";
  else if (statuses.every((s) => s === "ok" || s === "unknown")) result.status = "ok";
  else result.status = "degraded";

  result.checks = checks;

  return new Response(JSON.stringify(result, null, 2), {
    status: result.status === "down" ? 503 : 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== logs =====================
// ?action=logs&date=YYYY-MM-DD&hour=HH&limit=N 端点
// 读 R2 `logs/YYYY-MM-DD/HH.log` 按 ts 倒序返回
export async function handleLogsAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const params = url.searchParams;
  const now = new Date();
  const todayUtc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;

  // 1. 解析 + 校验
  const rawDate = params.get("date") || "today";
  let date: string;
  if (rawDate === "today") {
    date = todayUtc;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    date = rawDate;
  } else {
    return new Response(JSON.stringify({ error: "date must be YYYY-MM-DD or 'today'" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const hourParam = params.get("hour");
  let hour: number | null = null;
  if (hourParam !== null) {
    hour = parseInt(hourParam, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return new Response(JSON.stringify({ error: "hour must be 0-23" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  const limit = Math.min(Math.max(parseInt(params.get("limit") || "100", 10), 1), 500);

  // 2. date range ≤ 7d 校验
  const requestedDate = new Date(date + "T00:00:00Z");
  const todayDate = new Date(todayUtc + "T00:00:00Z");
  const diffDays = (todayDate.getTime() - requestedDate.getTime()) / 86400_000;
  if (diffDays > 7 || diffDays < 0) {
    return new Response(JSON.stringify({ error: "date range max 7 days (0-7 days back)" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  // 3. R2 list + 读 log entries
  // kzclaw 2026-06-12 确定: log 颗粒度做细 (v0.36)
  // 旧设计: 1 小时 1 个 file (key=logs/YYYY-MM-DD/HH.log) → put 覆盖丢失
  // 新设计: 每条 log 1 个 file (key=logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log)
  //   - 改用 prefix=logs/YYYY-MM-DD/ 列出当天所有 hour 子目录
  //   - 每个 hour 子目录下 MM-SS-fff-*.log 是单条 log
  //   - 用 obj.key 路径分段过滤 hour
  let entries: any[] = [];
  try {
    const prefix = `logs/${date}/`;
    const list = await env.csnews_raw.list({ prefix, limit: 1000 });
    for (const obj of list.objects) {
      // 旧格式兼容: HH.log (无子目录)
      if (/^\d{2}\.log$/.test(obj.key.split("/").pop() || "")) {
        if (hour !== null && !obj.key.endsWith(`/${String(hour).padStart(2, "0")}.log`)) continue;
      } else {
        // 新格式: HH/MM-SS-fff-source.log
        const parts = obj.key.split("/");
        if (parts.length < 3) continue;
        const hh = parts[parts.length - 2];
        if (hour !== null && hh !== String(hour).padStart(2, "0")) continue;
      }
      const body = await env.csnews_raw.get(obj.key);
      if (!body) continue;
      const text = await body.text();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          entries.push(JSON.parse(t));
        } catch {
          // 跳过损坏行
        }
      }
    }
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "r2 unavailable", detail: e?.message || String(e) }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 4. 按 ts 倒序
  entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  // 5. 取 limit
  const items = entries.slice(0, limit);
  const truncated = entries.length > items.length;

  return new Response(JSON.stringify({
    date,
    hour: hour,
    count: items.length,
    total: entries.length,
    truncated,
    items,
  }), {
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ===================== content (KR0 R2 全文内容读取端点 · v0.36.6) =====================
// 用途：消费者（kzclaw 推送 / 第三方 IM 转发）从 R2 拿 news_hotspots 关联的摘要 + 原始 URL
// v0.36.6 方案 A 范围（kzclaw 2026-06-16 02:56 确定 + main session 推荐 A）：
//   - 不动 news-process.ts 写路径（0 风险）
//   - 不 fetch 正文（留给 KR0 = process 加 fetch 详情页存 R2 content 字段，等 KR0 异步化后做）
//   - 端点返 R2 真实存的 9 字段 + Supabase 关联的 url 字段
//   - text/html/json 三档格式 (text/html 因没 content 字段, 返 '该新闻仅存摘要 + 原始 URL' 提示)
// 反爬：单 IP 60 req/min（复用 PROCESS_STATE KV，key prefix content_rate:<ip>，TTL 60s）
// 鉴权：index.ts fetch handler 入口已统一 authRequest, 本 handler 不重复
// 部署边界：git push 触发 auto-deploy（v0.36.2 部署边界铁律）
export async function handleContentAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验 (业务红线)
  const id = url.searchParams.get('id') || '';
  const idValidation = validateId(id);
  if (!idValidation.ok) {
    return new Response(JSON.stringify({ error: idValidation.error, reason: idValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const formatValidation = validateFormat(format);
  if (!formatValidation.ok) {
    return new Response(JSON.stringify({ error: formatValidation.error, reason: formatValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 2. 反爬限流 (单 IP 60 req/min, 复用 PROCESS_STATE KV)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = rateKeyForIp(ip);
  if (env.PROCESS_STATE) {
    try {
      const cur = parseInt((await env.PROCESS_STATE.get(rateKey)) || '0', 10);
      if (cur >= RATE_LIMIT_PER_MIN) {
        return new Response(JSON.stringify({ error: 'rate_limited', reason: `单 IP ${RATE_LIMIT_PER_MIN} req/min 上限, 请稍后重试` }), {
          status: 429, headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
        });
      }
      // 计数 +1 (TTL 60s 滚动窗口)
      ctx.waitUntil(env.PROCESS_STATE.put(rateKey, String(cur + 1), { expirationTtl: 60 }));
    } catch {
      // 限流检查失败不阻塞主流程 (KV 临时不可用降级为不限流)
    }
  }

  // 3. Supabase 查 news_hotspots (拿 url + r2_key + 基础摘要)
  const newsRes = await supabaseFetch(env, `/rest/v1/news_hotspots?id=eq.${id}&select=id,title,url,source,category,hot_score,score,level,topic_id,r2_key,created_at&limit=1`);
  const newsData = await safeJson(newsRes) as any[];
  if (!newsData || newsData.length === 0) {
    return new Response(JSON.stringify({ error: 'not_found', reason: `id=${id} 在 news_hotspots 表不存在` }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const news = newsData[0];

  // 4. R2 拿 content (按 news.r2_key)
  let r2Data: any = null;
  let r2Error: string | null = null;
  if (news.r2_key) {
    try {
      const obj = await env.csnews_raw.get(news.r2_key);
      if (obj) {
        const text = await obj.text();
        r2Data = JSON.parse(text);
      } else {
        r2Error = 'r2_key_found_but_object_missing';
      }
    } catch (e: any) {
      r2Error = `r2_read_failed: ${e?.message || e}`;
    }
  } else {
    r2Error = 'no_r2_key';
  }

  // 5. 大小限制 (单条 ≤ PAYLOAD_LIMIT_BYTES)
  const contentLength = r2Data ? JSON.stringify(r2Data).length : 0;
  if (contentLength > PAYLOAD_LIMIT_BYTES) {
    return new Response(JSON.stringify({ error: 'payload_too_large', reason: `R2 content > ${PAYLOAD_LIMIT_BYTES} bytes, 请用 format=ids 分页` }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 6. 监控计数 (r2_content_endpoint_hits_24h) - 复用 PROCESS_STATE
  if (env.PROCESS_STATE) {
    try {
      const counterKey = dailyHitsKeyForToday();
      const cur = parseInt((await env.PROCESS_STATE.get(counterKey)) || '0', 10);
      ctx.waitUntil(env.PROCESS_STATE.put(counterKey, String(cur + 1), { expirationTtl: 86400 }));
    } catch {
      // 监控失败不阻塞
    }
  }

  // 7. 按 format 渲染响应
  if (format === 'json') {
    // 合并 Supabase 字段 + R2 字段 (R2 字段加 r2_ 前缀避免冲突)
    const responseBody = {
      id: news.id,
      title: news.title,
      url: news.url,
      source: news.source,
      category: news.category,
      hot_score: news.hot_score,
      score: news.score,
      level: news.level,
      topic_id: news.topic_id,
      created_at: news.created_at,
      // R2 实际存的字段
      r2: r2Data ? {
        key: news.r2_key,
        title: r2Data.title,
        category: r2Data.category,
        score: r2Data.score,
        level: r2Data.level,
        topic_id: r2Data.topic_id,
        fission: r2Data.fission,
        created_at: r2Data.created_at,
        content_length: contentLength,
      } : null,
      // 关键提示：R2 没存正文, 消费者想发全文用 url 跳到原始页面
      ...(r2Error ? { notice: `该新闻仅存摘要 + 原始 URL · R2 不存正文 (原因: ${r2Error}) · 全文请访问 ${news.url}` } : {}),
    };
    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (format === 'text') {
    // text 格式: 没有 content 字段, 返提示 + URL
    const lines: string[] = [];
    lines.push(`标题: ${news.title}`);
    lines.push(`来源: ${news.source} · ${news.category || '未知分类'}`);
    lines.push(`热度: hot_score=${news.hot_score ?? '?'} score=${news.score ?? '?'} level=${news.level ?? '?'}`);
    if (news.topic_id) lines.push(`话题: ${news.topic_id}`);
    lines.push(`入库时间: ${news.created_at}`);
    if (r2Data) {
      lines.push('');
      lines.push(`R2 摘要 (key=${news.r2_key}):`);
      lines.push(JSON.stringify(r2Data, null, 2));
    }
    lines.push('');
    lines.push(`⚠️ 该新闻仅存摘要, R2 不存正文 (原因: ${r2Error || 'N/A'})`);
    lines.push(`全文请访问: ${news.url}`);
    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors },
    });
  }

  // format === 'html'
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(news.title || '')}</title>
</head>
<body>
<h1>${escapeHtml(news.title || '')}</h1>
<p><strong>来源:</strong> ${escapeHtml(news.source || '?')} · ${escapeHtml(news.category || '未知分类')}</p>
<p><strong>热度:</strong> hot_score=${news.hot_score ?? '?'} · score=${news.score ?? '?'} · level=${escapeHtml(news.level || '?')}</p>
<p><strong>入库时间:</strong> ${escapeHtml(news.created_at || '')}</p>
${r2Data ? `<pre>${escapeHtml(JSON.stringify(r2Data, null, 2))}</pre>` : ''}
<p style="color:#888">⚠️ 该新闻仅存摘要, R2 不存正文 (原因: ${escapeHtml(r2Error || 'N/A')})<br>
全文请访问: <a href="${escapeHtml(news.url || '#')}">${escapeHtml(news.url || '')}</a></p>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors },
  });
}

// ===================== trend (KR0 Trend topic velocity · v0.36.7 · O8 Trend Engine) =====================
// 用途：消费者（kzclaw 推送 / 第三方 IM 转发 / dashboard）每小时看 topic 演化
// kzclaw 2026-06-16 03:25 确定：'trend 新闻趋势是可以的' (业务价值, 不是 system health)
// 3 档 type:
//   - topics: 当前所有 active topic + 最近 news count (基础信息)
//   - velocity: topic 1h 增量 / 24h 平均 = velocity ratio (>2 = 爆发, <0.5 = 衰退)
//   - acceleration: velocity 的 1h 增量 (二阶导 = 加速中)
// 反爬：单 IP 60 req/min（独立 KV prefix trend_rate:<ip>, 跟 KR0 content_rate:<ip> 分开计数）
// 鉴权：index.ts fetch handler 入口统一 authRequest
// 部署边界：git push 触发 auto-deploy（v0.36.2 部署边界铁律）
export async function handleTrendAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验
  const typeValidation = validateType(url.searchParams.get('type'));
  if (!typeValidation.ok) {
    return new Response(JSON.stringify({ error: typeValidation.error, reason: typeValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const type = typeValidation.reason!;

  const sinceValidation = validateSince(url.searchParams.get('since'));
  if (!sinceValidation.ok) {
    return new Response(JSON.stringify({ error: sinceValidation.error, reason: sinceValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const sinceIso = sinceValidation.since!;

  const limitValidation = validateLimit(url.searchParams.get('limit'));
  if (!limitValidation.ok) {
    return new Response(JSON.stringify({ error: limitValidation.error, reason: limitValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const limit = limitValidation.limit;

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = trendRateKeyForIp(ip);
  if (env.PROCESS_STATE) {
    try {
      const cur = parseInt((await env.PROCESS_STATE.get(rateKey)) || '0', 10);
      if (cur >= TREND_RATE_LIMIT_PER_MIN) {
        return new Response(JSON.stringify({ error: 'rate_limited', reason: `单 IP ${TREND_RATE_LIMIT_PER_MIN} req/min 上限, 请稍后重试` }), {
          status: 429, headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
        });
      }
      ctx.waitUntil(env.PROCESS_STATE.put(rateKey, String(cur + 1), { expirationTtl: 60 }));
    } catch {
      // 限流失败不阻塞
    }
  }

  // 3. 计算时间窗边界
  const sinceTime = new Date(sinceIso);
  const oneHourAgo = new Date(sinceTime.getTime() - 3600 * 1000);
  const twoHourAgo = new Date(sinceTime.getTime() - 7200 * 1000);

  // 4. 根据 type 查数据
  let items: any[] = [];
  let description = '';

  if (type === 'topics') {
    // 基础信息: active topics + last_active_at + score + 最近 news count
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at,first_news_id&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      // 对每个 topic 计算 since 之后的 news count
      items = await Promise.all(topics.map(async (t) => {
        const countRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        // 用 head 模式拿 total (PostgREST Content-Range)
        const totalHeader = countRes.headers.get('content-range');
        const total = totalHeader ? parseInt(totalHeader.split('/')[1] || '0', 10) : 0;
        // since 之后 new news count (近似: total - <since 的 count)
        return {
          topic_id: t.id,
          topic_key: t.topic_key,
          level: t.level,
          score: t.score,
          last_active_at: t.last_active_at,
          first_news_id: t.first_news_id,
          total_news_count: total,
        };
      }));
    }
    description = '当前所有 active topic (按 last_active_at 倒序)';
  } else if (type === 'velocity') {
    // velocity: 1h 增量 / 24h 平均
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      items = await Promise.all(topics.map(async (t) => {
        // 1h 增量: news_topic_members joined_at >= sinceTime - 1h
        // acceleration 用 now-1h / now-2h (不要用 since-1h / since-2h, since 太大查询范围大且跟 velocity 重复)
        const nowMs = Date.now();
        const nowMinus1h = new Date(nowMs - 3600 * 1000);
        const nowMinus2h = new Date(nowMs - 7200 * 1000);
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${nowMinus1h.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // since 总数: news_topic_members joined_at >= since
        const sinceRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`, { headers: { 'Prefer': 'count=exact' } });
        const sinceTotal = parseInt(sinceRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 24h 均值 = sinceTotal / 24 (小时)
        const hourlyAvg = sinceTotal / 24;
        const velocityRatio = hourlyAvg > 0 ? (last1hTotal / hourlyAvg) : 0;
        return {
          topic_id: t.id,
          topic_key: t.topic_key,
          level: t.level,
          score: t.score,
          last_1h_count: last1hTotal,
          hourly_avg: Math.round(hourlyAvg * 100) / 100,
          velocity_ratio: Math.round(velocityRatio * 100) / 100,
          trend: velocityRatio > 2 ? 'explosive' : velocityRatio > 1 ? 'rising' : velocityRatio < 0.5 ? 'declining' : 'stable',
        };
      }));
    }
    description = 'topic velocity (1h 增量 / 24h 均值)';
  } else if (type === 'acceleration') {
    // acceleration: 1h 增量 - 2h 增量 = 二阶导 (加速 / 减速)
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      items = await Promise.all(topics.map(async (t) => {
        // acceleration 用 since-1h / since-2h 跟 velocity 同款时间窗
        // (上次 now-1h / now-2h 实测 content-range 返 null = PostgREST 某些边缘场景不返 metadata)
        // 1h 增量 (last 1h, since-1h to since)
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 2h 增量 (between 2h ago and 1h ago)
        const between1h2hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${twoHourAgo.toISOString()}&joined_at=lt.${oneHourAgo.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const between1h2hTotal = parseInt(between1h2hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // acceleration = last1h - between1h2h (正=加速, 负=减速)
        const acceleration = last1hTotal - between1h2hTotal;
        return {
          topic_id: t.id,
          topic_key: t.topic_key,
          level: t.level,
          score: t.score,
          last_1h_count: last1hTotal,
          previous_1h_count: between1h2hTotal,
          acceleration: acceleration,
          trend: acceleration > 0 ? 'accelerating' : acceleration < 0 ? 'decelerating' : 'stable',
        };
      }));
    }
    description = 'topic acceleration (二阶导, 1h 增量 - 上一小时增量)';
  }

  // 5. 大小限制
  const responseBody = {
    type,
    since: sinceIso,
    description,
    count: items.length,
    limit,
    items,
  };
  const responseStr = JSON.stringify(responseBody);
  if (responseStr.length > TREND_PAYLOAD_LIMIT_BYTES) {
    return new Response(JSON.stringify({ error: 'payload_too_large', reason: `trend response > ${TREND_PAYLOAD_LIMIT_BYTES} bytes, 请用 limit 调小` }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 6. 监控计数
  if (env.PROCESS_STATE) {
    try {
      const counterKey = trendHitsKeyForToday();
      const cur = parseInt((await env.PROCESS_STATE.get(counterKey)) || '0', 10);
      ctx.waitUntil(env.PROCESS_STATE.put(counterKey, String(cur + 1), { expirationTtl: 86400 }));
    } catch {
      // 监控失败不阻塞
    }
  }

  return new Response(responseStr, {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== knowledge (v0.36.7 · KR0 · O10 快赢) =====================
// 快赢哲学 (5h 配额期 routine 协调授权):
//   - 不新建 Supabase 表 (避免5h 配额期起床跑 SQL Editor)
//   - knowledge 数据全在 R2 持久化 (早晨日报金句入口)
//   - 累积 job 在 cron inline 跑, 遍历 active topics → 写 knowledge/yyyymm/<topic_id>-<ts>.md
//   - 端点读 R2 索引 + 单 topic 详情 (跟 trend endpoint 模式同款)
export async function handleKnowledgeAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验 (跟 trend 同款, 独立 validation import)
  const typeValidation = knowledgeValidateType(url.searchParams.get('type'));
  if (!typeValidation.ok) {
    return new Response(JSON.stringify({ error: typeValidation.error, reason: typeValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const type = typeValidation.reason!;

  const sinceValidation = knowledgeValidateSince(url.searchParams.get('since'));
  if (!sinceValidation.ok) {
    return new Response(JSON.stringify({ error: sinceValidation.error, reason: sinceValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const sinceIso = sinceValidation.since!;

  const limitValidation = knowledgeValidateLimit(url.searchParams.get('limit'));
  if (!limitValidation.ok) {
    return new Response(JSON.stringify({ error: limitValidation.error, reason: limitValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const limit = limitValidation.limit;

  const topicIdValidation = validateTopicId(url.searchParams.get('topic_id'), type);
  if (!topicIdValidation.ok) {
    return new Response(JSON.stringify({ error: topicIdValidation.error, reason: topicIdValidation.reason }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  const topicId = topicIdValidation.topicId;

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix) (跟 trend 同模式)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = knowledgeRateKeyForIp(ip);
  if (env.PROCESS_STATE) {
    try {
      const cur = parseInt((await env.PROCESS_STATE.get(rateKey)) || '0', 10);
      if (cur >= KNOWLEDGE_RATE_LIMIT_PER_MIN) {
        return new Response(JSON.stringify({ error: 'rate_limited', reason: `单 IP ${KNOWLEDGE_RATE_LIMIT_PER_MIN} req/min 上限, 请稍后重试` }), {
          status: 429, headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
        });
      }
      ctx.waitUntil(env.PROCESS_STATE.put(rateKey, String(cur + 1), { expirationTtl: 60 }));
    } catch {
      // 限流失败不阻塞
    }
  }

  // 3. 根据 type 查数据
  let items: any[] = [];
  let description = '';

  if (type === 'daily') {
    // daily: 拉 R2 knowledge 索引 (早晨日报入口)
    // 索引路径: knowledge/_index.json (累积 job 每次写新 knowledge 记录时 append)
    // 索引格式: [{ r2_key, topic_id, topic_key, level, score, period_start, period_end, news_count, velocity_ratio, acceleration, created_at }]
    const indexObj = await env.csnews_raw.get(KNOWLEDGE_INDEX_KEY);
    let allIndex: any[] = [];
    if (indexObj) {
      const text = await indexObj.text();
      try {
        allIndex = JSON.parse(text);
        if (!Array.isArray(allIndex)) allIndex = [];
      } catch {
        allIndex = [];
      }
    }
    // 过滤 since 之后 + 按 created_at 倒序 + 取 limit
    const sinceMs = new Date(sinceIso).getTime();
    items = allIndex
      .filter((k) => k?.created_at && new Date(k.created_at).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    description = 'knowledge daily 索引 (早晨日报入口, 跨 topic 累积)';
  } else if (type === 'topic') {
    // topic: 拉单个 topic 的所有 knowledge 记录 (从 _index.json 过滤)
    if (!topicId) {
      // validateTopicId 已保证 type=topic 时 topicId 必填, 这里只是 TS narrowing
      return new Response(JSON.stringify({ error: 'internal_logic', reason: 'topic_id 缺失 (validateTopicId 应已拦截)' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    const indexObj = await env.csnews_raw.get(KNOWLEDGE_INDEX_KEY);
    let allIndex: any[] = [];
    if (indexObj) {
      const text = await indexObj.text();
      try {
        allIndex = JSON.parse(text);
        if (!Array.isArray(allIndex)) allIndex = [];
      } catch {
        allIndex = [];
      }
    }
    const sinceMs = new Date(sinceIso).getTime();
    items = allIndex
      .filter((k) => k?.topic_id === topicId)
      .filter((k) => k?.created_at && new Date(k.created_at).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    description = `knowledge topic 详情 (topic_id=${topicId}, 累积的所有 knowledge 记录)`;
  }

  // 4. 大小限制 (跟 trend 同款)
  const responseBody = {
    type,
    since: sinceIso,
    description,
    count: items.length,
    limit,
    topic_id: topicId || null,
    items,
  };
  const responseStr = JSON.stringify(responseBody);
  if (responseStr.length > KNOWLEDGE_PAYLOAD_LIMIT_BYTES) {
    return new Response(JSON.stringify({ error: 'payload_too_large', reason: `knowledge response > ${KNOWLEDGE_PAYLOAD_LIMIT_BYTES} bytes, 请用 limit 调小` }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 5. 监控计数 (跟 trend 同模式, 独立 prefix)
  if (env.PROCESS_STATE) {
    try {
      const counterKey = knowledgeHitsKeyForToday();
      const cur = parseInt((await env.PROCESS_STATE.get(counterKey)) || '0', 10);
      ctx.waitUntil(env.PROCESS_STATE.put(counterKey, String(cur + 1), { expirationTtl: 86400 }));
    } catch {
      // 监控失败不阻塞
    }
  }

  return new Response(responseStr, {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== runKnowledgeAccumulation (v0.36.7 · KR0 · cron inline 调用) =====================
// 快赢哲学: 整点 process 跑完调, 遍历 active topics → 累积 24h trend → 写 1 条 knowledge 记录
// 不调 LLM, 纯 SQL + 模板 + R2 only (0 Supabase DDL, 0 5h 配额期打扰)
export async function runKnowledgeAccumulation(env: Env, ctx: ExecutionContext): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors = 0;
  try {
    // 1. 拉所有 active topics (跟 trend 同款, last_active_at desc, limit 50 = 早晨日报默认覆盖)
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=50`);
    const topics = await safeJson(topicsRes) as any[];
    if (!topics || topics.length === 0) {
      return { written: 0, errors: 0 };
    }

    // 2. 对每个 topic 累积 24h 趋势数据 (复用 trend endpoint 的 since-1h / since-24h 模式)
    const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const twoHourAgo = new Date(Date.now() - 7200 * 1000).toISOString();

    // 3. 读 R2 索引 (累积分页查询用)
    const indexObj = await env.csnews_raw.get(KNOWLEDGE_INDEX_KEY);
    let allIndex: any[] = [];
    if (indexObj) {
      const text = await indexObj.text();
      try {
        allIndex = JSON.parse(text);
        if (!Array.isArray(allIndex)) allIndex = [];
      } catch {
        allIndex = [];
      }
    }

    // 4. 累积每个 topic
    for (const t of topics) {
      try {
        // 4.1 24h news count
        const sinceRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const since24hTotal = parseInt(sinceRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 4.2 1h 增量
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 4.3 2h 增量 (跟 trend acceleration 同款)
        const between1h2hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${twoHourAgo}&joined_at=lt.${oneHourAgo}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const between1h2hTotal = parseInt(between1h2hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 4.4 计算 velocity + acceleration
        const hourlyAvg = since24hTotal / 24;
        const velocityRatio = hourlyAvg > 0 ? (last1hTotal / hourlyAvg) : 0;
        const acceleration = last1hTotal - between1h2hTotal;

        // 4.5 写 R2 knowledge Markdown (早晨日报金句)
        const ts = new Date();
        const r2Key = knowledgeR2Key(t.id, ts);
        const markdown = `# ${t.topic_key}\n\n` +
          `> 累积时间: ${ts.toISOString()}\n` +
          `> 等级: ${t.level} · 分数: ${t.score}\n\n` +
          `## 24h 累积数据\n\n` +
          `- **24h 新闻数**: ${since24hTotal}\n` +
          `- **1h 增量**: ${last1hTotal}\n` +
          `- **2h 增量**: ${between1h2hTotal}\n` +
          `- **24h 均值 (per hour)**: ${Math.round(hourlyAvg * 100) / 100}\n` +
          `- **Velocity Ratio** (1h / 24h均值): ${Math.round(velocityRatio * 100) / 100}\n` +
          `- **Acceleration** (1h - 2h): ${acceleration}\n\n` +
          `## 趋势判定\n\n` +
          `- **Velocity Trend**: ${velocityRatio > 2 ? '🔥 explosive' : velocityRatio > 1 ? '📈 rising' : velocityRatio < 0.5 ? '📉 declining' : '➡️ stable'}\n` +
          `- **Acceleration Trend**: ${acceleration > 0 ? '⚡ accelerating' : acceleration < 0 ? '🐌 decelerating' : '⚖️ stable'}\n\n` +
          `## 早晨金句模板 (待 KR0+1 接 AI 摘要)\n\n` +
          `_本 topic 在过去 24h 累积 ${since24hTotal} 条新闻, 1h 增量 ${last1hTotal} (${velocityRatio > 1 ? '高于' : '低于'} 24h 均值 ${Math.round(hourlyAvg * 100) / 100}), ` +
          `${acceleration > 0 ? '呈加速上升' : acceleration < 0 ? '呈减速下降' : '保持稳定'}._\n`;
        await env.csnews_raw.put(r2Key, markdown, { httpMetadata: { contentType: 'text/markdown' } });

        // 4.6 append 索引 (9:00 起床看 1 个 GET 拿所有 knowledge 索引)
        const indexEntry = {
          r2_key: r2Key,
          topic_id: t.id,
          topic_key: t.topic_key,
          level: t.level,
          score: t.score,
          period_start: sinceIso,
          period_end: ts.toISOString(),
          news_count: since24hTotal,
          velocity_ratio: Math.round(velocityRatio * 100) / 100,
          acceleration: acceleration,
          created_at: ts.toISOString(),
        };
        allIndex.push(indexEntry);
        written++;
      } catch (e: any) {
        errors++;
        console.error(`[knowledge] topic ${t.id} accumulation failed: ${e?.message || e}`);
      }
    }

    // 5. 写 R2 索引 (累积分页查询用, 早晨日报入口)
    if (written > 0) {
      // 限制索引大小 (保留最近 1000 条, 避免索引无限增长)
      if (allIndex.length > 1000) {
        allIndex = allIndex
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 1000);
      }
      await env.csnews_raw.put(KNOWLEDGE_INDEX_KEY, JSON.stringify(allIndex), { httpMetadata: { contentType: 'application/json' } });
    }

    return { written, errors };
  } catch (e: any) {
    console.error(`[knowledge] accumulation job failed: ${e?.message || e}`);
    return { written, errors: errors + 1 };
  }
}

// ===================== entity (Entity Engine · v0.36.11) =====================
// kzclaw 16:28 确定: 0 硬编码, 纯自适应/自学习/自进化
// kzclaw 16:33 确定推 · bge-m3 走 CF Workers AI 独立池
// 3 档 type:
//   - candidates: 读 R2 entity-candidates.json (kzclaw review 入口)
//   - selflearn: 触发 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type)
//   - process: 触发 runEntityProcess (kzclaw 0 DDL = 暂存 R2 entity-finalized.json, 等 5h 配额期外拍 schema migration)
// 反爬：单 IP 60 req/min (复用 KR0 / KR0 模式)
// 鉴权：index.ts fetch handler 入口统一 authRequest
// 部署边界：git push 触发 auto-deploy (v0.36.2 部署边界铁律)
export async function handleEntityAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验
  const type = url.searchParams.get('type') || 'candidates';
  const validTypes = ['candidates', 'selflearn', 'process', 'finalized'];
  if (!validTypes.includes(type)) {
    return new Response(JSON.stringify({
      error: 'invalid_type',
      reason: `type 必须是 candidates|selflearn|process|finalized 四选一, 当前 ${type}`,
    }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = `entity_rate:${ip}`;
  if (env.PROCESS_STATE) {
    try {
      const cur = parseInt((await env.PROCESS_STATE.get(rateKey)) || '0', 10);
      if (cur >= 60) {
        return new Response(JSON.stringify({ error: 'rate_limited', reason: '单 IP 60 req/min 上限, 请稍后重试' }), {
          status: 429, headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
        });
      }
      ctx.waitUntil(env.PROCESS_STATE.put(rateKey, String(cur + 1), { expirationTtl: 60 }));
    } catch {
      // 限流失败不阻塞
    }
  }

  // 3. 根据 type 查数据
  if (type === 'candidates') {
    // 读 R2 entity-candidates.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'candidates',
          description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn, 或自学习 0 候选)',
          candidates: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ candidates: any[]; generated_at: string; total_news: number }>();
      return new Response(JSON.stringify({
        type: 'candidates',
        description: 'kzclaw review 入口 (R2 entity-candidates.json)',
        generated_at: json.generated_at,
        total_news: json.total_news,
        total: json.candidates?.length || 0,
        candidates: json.candidates || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'selflearn') {
    // 触发 runEntitySelfLearn (n-gram + bge-m3)
    const result = await runEntitySelfLearn(env);
    return new Response(JSON.stringify({
      type: 'selflearn',
      description: '跑 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type)',
      total_news: result.total,
      embedded: result.embedded,
      candidates: result.candidates.length,
      top_candidates: result.candidates.slice(0, 10),
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'process') {
    // kzclaw 0 DDL = 暂存 R2 entity-finalized.json
    const result = await runEntityProcess(env);
    return new Response(JSON.stringify({
      type: 'process',
      description: 'kzclaw 0 DDL = 暂存 R2 entity-finalized.json, 等 5h 配额期外拍 schema migration',
      finalized: result.finalized,
      written: result.written,
      errors: result.errors,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'finalized') {
    // 读 R2 entity-finalized.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_FINALIZED_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'finalized',
          description: 'R2 entity-finalized.json 不存在 (尚未运行 process)',
          entities: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ entities: any[]; generated_at: string }>();
      return new Response(JSON.stringify({
        type: 'finalized',
        description: 'kzclaw review 后入库的实体 (R2 entity-finalized.json, kzclaw 0 DDL = 暂存 R2)',
        generated_at: json.generated_at,
        total: json.entities?.length || 0,
        entities: json.entities || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  // unreachable
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500, headers: { 'Content-Type': 'application/json', ...cors },
  });
}
