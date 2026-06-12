// ============================================================
// 16 个 Action Handler
// ============================================================
// 用途：从 index.ts 抽出 16 个 action=xxx 端点处理函数
// 通用 pull 在独立 pull.ts
// 新增 health + logs 端点 (Worker 可观测性)
// 详见：tasks/csnews-agent-okr.md (本地私密 OKR 文档, 不入库)
import { Env, getSupabaseHost } from './shared';
import { NewsItem } from './types';
import { handlePull } from './pull';
import { corsHeaders } from './auth';
import { classify, classifyByAI, classifyRule } from './classify';
import { scoreRule, AI_ROUTE_R_THRESHOLD, TOPIC_MATCH_THRESHOLD, R2_DUP_THRESHOLD, hashStr } from './score';
import { cleanupStaleTopics, findSimilarNews, updateTopicScore, recordTrendSnapshot, createTopic, insertNewsHotspot, saveToR2, joinTopicMember } from './news-process';
import { logEvent } from './log';

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
  // 旧实现用 list() 字典序最大 key → 2 周前的 1780049985620
  // 修: list desc → get obj content → 看 created_at
  try {
    const list = await env.csnews_raw.list({ prefix: "news/zaker/", limit: 50 });
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
