// ============================================================
//14 个 Action Handler（v0.33+sweep·FT-KR0 · Phase0 · T000）
// ============================================================
//用途：从 index.ts抽出14 个 action=xxx端点处理函数
// KR0通用 pull 在独立 pull.ts(已存在)
//详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
// specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}
import { Env, getSupabaseHost } from './shared';
import { NewsItem } from './types';
import { handlePull } from './pull';
import { corsHeaders } from './auth';
import { classify, classifyByAI, classifyRule } from './classify';
import { scoreRule, AI_ROUTE_R_THRESHOLD, TOPIC_MATCH_THRESHOLD, R2_DUP_THRESHOLD, hashStr } from './score';
import { cleanupStaleTopics, findSimilarNews, updateTopicScore, recordTrendSnapshot, createTopic, insertNewsHotspot, saveToR2, joinTopicMember } from './news-process';

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
export async function handleProcessAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
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

 return new Response(JSON.stringify({
 processed: results.length,
 cleaned: cleaned?.deleted_topic_count ||0,
 items: results,
 }), { headers: { 'Content-Type': 'application/json', ...cors } });
}
