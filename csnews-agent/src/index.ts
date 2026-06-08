/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 */
import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { handlePull } from './pull';

import { authRequest, corsHeaders } from './auth';
import { classifyRule, classifyByAI, classify } from './classify';

// 清理过期话题簇(跟进7天/重要14天/爆炸28天)
import { hashStr, scoreRule, AI_ROUTE_R_THRESHOLD, TOPIC_MATCH_THRESHOLD, R2_DUP_THRESHOLD } from './score';

async function cleanupStaleTopics(env: Env) {
  const { data } = await (await supabaseFetch(env, '/rest/v1/rpc/cleanup_stale_topics', {
    method: 'POST',
  })).json() as any;
  return data?.[0] || { deleted_topic_count: 0, deleted_news_count: 0 };
}

// 向量查重:查相似新闻
async function findSimilarNews(env: Env, embedding: number[], threshold = 0.88, matchCount = 5) {
  const res = await supabaseFetch(env, '/rest/v1/rpc/find_similar_news', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: embedding, threshold, match_count: matchCount }),
  });
  const data = await safeJson(res) as any[];
  return data || [];
}

// 更新话题簇积分
async function updateTopicScore(env: Env, topicId: string, delta = 1) {
  const res = await supabaseFetch(env, '/rest/v1/rpc/update_topic_score', {
    method: 'POST',
    body: JSON.stringify({ p_topic_id: topicId, p_score_delta: delta }),
  });
  const data = await safeJson(res) as any[];
  return data?.[0] || { new_score: 0, new_level: 'follow', upgraded: false, fission_triggered: false };
}

// 记录 TIE-lite 趋势快照并按规则触发 warning，不调用 LLM
async function recordTrendSnapshot(env: Env, topicId: string) {
  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/record_trend_snapshot', {
      method: 'POST',
      body: JSON.stringify({ p_topic_id: topicId }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[TIE] record_trend_snapshot HTTP ${res.status} for ${topicId}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = await safeJson(res) as any[];
    return Array.isArray(data) ? data[0] || null : null;
  } catch (e: any) {
    console.error(`[TIE] record_trend_snapshot threw for ${topicId}: ${e?.message || e}`);
    return null;
  }
}

// 插入话题簇
async function createTopic(env: Env, topicKey: string, level = 'follow', firstNewsId?: string): Promise<any> {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await supabaseFetch(env, '/rest/v1/topics', {
    method: 'POST',
    body: JSON.stringify({ id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId }),
  });
  return { id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId };
}

// 插入新闻记录
async function insertNewsHotspot(env: Env, news: {
  title: string; url?: string; source?: string; category?: string;
  hot_score?: number; published_at?: string; summary?: string;
  embedding?: number[]; r2_key?: string; topic_id?: string;
  level?: string; score?: number; is_stored_r2?: boolean;
}): Promise<string | null> {
  // 生成确定性 UUID(基于 title + timestamp),避免响应体被 Cloudflare 截断
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newsWithId = { id, ...news };
  await supabaseFetch(env, '/rest/v1/news_hotspots', {
    method: 'POST',
    body: JSON.stringify(newsWithId),
  });
  return id;
}

// 关联新闻-话题
async function joinTopicMember(env: Env, newsId: string, topicId: string, role = 'follow'): Promise<boolean> {
  const res = await supabaseFetch(env, '/rest/v1/news_topic_members', {
    method: 'POST',
    body: JSON.stringify({ news_id: newsId, topic_id: topicId, role }),
    headers: { 'Prefer': 'return=representation' },
  });
  const raw = await res.text();
  return !!(raw && raw.trim() && (raw !== '[]'));
}

// R2 存储(去重存储层)
async function saveToR2(env: Env, prefix: string, data: object): Promise<string> {
  const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await env.csnews_raw.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return key;
}
interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
}

// ============================================================
// 安全中间件（authRequest + corsHeaders 已抽到 src/auth.ts · T000）
// ============================================================

// ============================================================
//评分规则已抽到 src/score.ts ·T000（hashStr +3路由常量 + scoreRule）
// ============================================================
// Workers AI 响应解析
// env.AI.run() 返回格式:{ response: string, usage: {...} }
// ============================================================
function extractText(resp: any): string {
  if (typeof resp === 'string') return resp.trim();
  if (resp && typeof resp === 'object') {
    const text = (resp.response || '').trim();
    if (text) return text;
  }
  return '';
}

// ============================================================
// Workers AI 裂变报告生成
// ============================================================
// Workers AI 裂变报告生成
// KR0: only call AI when R >= AI_ROUTE_R_THRESHOLD
async function maybeFissionReport(title: string, env: Env, rScore: number): Promise<string> {
  if (rScore < AI_ROUTE_R_THRESHOLD) return `(AI跳过-R<${AI_ROUTE_R_THRESHOLD})`;
  try {
    const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'user', content: `根据以下新闻，生成一段50字左右的裂变分析报告：\n\n${title}` }
      ],
      max_tokens: 200,
      temperature: 0.3,
    }) as any;
    return extractText(resp) || '(无AI输出)';
  } catch (e: any) {
    return `(AI错误: ${e.message})`;
  }
}

// ============================================================
// 主 Worker
// ============================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const authError = authRequest(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';

    // -------- 消费面通用 pull 端点(KR0 · v0.31) --------
    // 1 个端点 + 参数组合,覆盖所有"读"场景
    // type 白名单:news / topics / warnings / fission-pending
    // 通用参数:limit / order / order_by / since / until / level / category /
    //          topic_id / status / stage / fission_triggered / select / format
    if (action === 'pull') {
      try {
        const result = await handlePull(env, url);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        const status = e.status || 500;
        return new Response(JSON.stringify({ error: e.message || 'pull failed' }), {
          status,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }



    if (action === 'diag') {
      const results = [];

      // 1. Insert topic
      const t0 = Date.now();
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

      // 2. Insert news
      const t1 = Date.now();
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

      // 3. Join (if both IDs exist)
      if (t0id && t1id) {
        const t2 = Date.now();
        // Join: news_topic_members.news_id = news.id, topic_id = topic.id
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

    if (action === 'ping') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }









    // -------- 模型测试 --------
    if (action === 'model-test') {
      const r = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: '说一段话介绍自己' }],
        max_tokens: 100,
      }) as any;
      return new Response(JSON.stringify({
        ok: true,
        model: 'llama-3-8b-instruct',
        response: extractText(r).substring(0, 200),
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变报告测试 --------
    if (action === 'ai-test') {
      const title = url.searchParams.get('title') || 'OpenAI发布GPT-5,AI行业迎来新一轮革命';
      const report = await maybeFissionReport(title, env, 9.0); // test always uses high score
      return new Response(JSON.stringify({ title, report }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 单条新闻评分 + 分类 --------
    if (action === 'score') {
      const title = url.searchParams.get('title');
      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
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

    // -------- 独立分类测试(调试用)--------
    if (action === 'classify') {
      const title = url.searchParams.get('title');
      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      const aiCat = await classifyByAI(title, env);
      const kwCat = classifyRule(title);
      return new Response(JSON.stringify({ title, aiCat, kwCat }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 批量评分 --------
    if (action === 'batch-score') {
      let body: { items: NewsItem[]; use_ai?: boolean } | null = null;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
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

      return new Response(JSON.stringify({ count: results.length, results }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变查询生成（KR0: 高分新闻才生成，低分跳过）--------
    if (action === 'fission') {
      const seed = url.searchParams.get('seed') || url.searchParams.get('title');
      if (!seed) {
        return new Response(JSON.stringify({ error: 'missing seed param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      const r = scoreRule(seed);
      if (r.score < AI_ROUTE_R_THRESHOLD) {
        return new Response(JSON.stringify({
          seed,
          queries: [],
          count: 0,
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
          max_tokens: 200,
          temperature: 0.3,
        }) as any;
        const text = extractText(resp);
        const queries = text.split('|').map(q => q.trim()).filter(q => q.length > 0 && q.length <= 20);
        return new Response(JSON.stringify({ seed, queries, count: queries.length }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- 保存新闻到 R2(手动单条保存)--------
    if (action === 'save') {
      const title = url.searchParams.get('title') || '';
      const category = url.searchParams.get('category') || '综合';
      const score = parseFloat(url.searchParams.get('score') || '5');
      const source = url.searchParams.get('source') || 'zaker';

      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- 列出 R2 中的新闻 --------
    if (action === 'list') {
      const prefix = url.searchParams.get('prefix') || 'news/zaker/';
      // 支持 ?limit=N（默认 50，上限 200）和 ?order=desc|asc（默认 desc，因为 R2 list 默认字典序是 asc）
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
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

    // -------- Workers AI 向量嵌入(@cf/baai/bge-m3)--------
    if (action === 'embed') {
      const text = url.searchParams.get('text') || url.searchParams.get('title') || '';
      if (!text) {
        return new Response(JSON.stringify({ error: 'missing text param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const resp = await env.AI.run('@cf/baai/bge-m3', {
          text: [text],
        }) as any;

        // bge-m3 返回格式:{ shape: [n, dim], data: [...], response: string }
        const raw = resp as any;
        // 尝试多种路径取 embedding
        let embedding: number[] = [];
        if (Array.isArray(raw?.data) && raw.data.length > 0) {
          const item = raw.data[0];
          if (Array.isArray(item?.embedding)) embedding = item.embedding;
          else if (Array.isArray(item)) embedding = item;
        }

        if (!embedding || embedding.length === 0) {
          return new Response(JSON.stringify({ error: 'embedding empty', shape: raw?.shape, keys: raw ? Object.keys(raw) : [] }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }

        // 存 R2
        const key = `embeddings/${Date.now()}.json`;
        await env.csnews_raw.put(key, JSON.stringify({ text, embedding, dim: embedding.length, model: 'bge-m3' }), {
          httpMetadata: { contentType: 'application/json' },
        });

        return new Response(JSON.stringify({
          text,
          dim: embedding.length,
          model: '@cf/baai/bge-m3',
          sample: embedding.slice(0, 5),
          key,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- ZAKER 热点新闻获取 + 处理 --------
    if (action === 'zaker-hot') {
      try {
        const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
        const json = await r.json() as any;
        const list: any[] = json?.data?.list || [];
        const results = [];

        for (const item of list.slice(0, 1)) {
          const title = item.title || '';
          if (!title) continue;

          const rule = scoreRule(title);
          const category = await classify(title, env);

          // 跳过向量化和R2,只测Supabase写入
          await insertNewsHotspot(env, {
            title,
            url: item.url || '',
            source: 'zaker',
            category,
            hot_score: rule.score,
            published_at: item.publish_time || new Date().toISOString(),
            summary: (item.summary || '').substring(0, 200),
          });

          results.push({ title, category, score: rule.score });
        }

        return new Response(JSON.stringify({ count: results.length, items: results }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }





    // -------- News Self Growth 主流程(ZAKER → 查重 → 积分 → R2)--------
    if (action === 'process') {
      // Step 0: 清理过期话题簇(1 subrequest)
      const cleaned = await cleanupStaleTopics(env) as any;

      // Step 1: 拉 ZAKER 热点(1 subrequest)
      const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
      const json = await r.json() as any;
      const list: any[] = json?.data?.list || [];
      if (list.length === 0) {
        return new Response(JSON.stringify({ error: 'no news' }), { headers: { 'Content-Type': 'application/json', ...cors } });
      }

      const results = [];
      // 10 items max:
      // - Full flow adds one TIE-lite snapshot RPC after topic join.
      // - 6 full items + 2 global requests remain under the free Worker subrequest limit.
      // - 后4条只写Supabase(跳过向量查重)节省 Neurons
      const FULL_COUNT = 6;

      for (let i = 0; i < list.slice(0, 10).length; i++) {
        const item = list[i];
        const title = item.title || '';
        if (!title) continue;

        // 规则引擎评分+分类
        const rule = scoreRule(title);
        const category = await classify(title, env);

        let topicId: string | undefined;
        let isStoredR2 = false;
        let newsLevel = 'follow';
        let newsScore = 0;
        let fission = false;
        let isNewTopic = false;
        let embedding: number[] = [];
        let matchedSimilarity: number | null = null;
        let r2Key: string | undefined;
        let storedReason = i < FULL_COUNT ? 'embedding_empty' : 'lightweight_no_embedding';
        let trendSnapshot: any = null;

        // 仅前 FULL_COUNT 条做 embedding + 向量查重(Workers AI CPU 限制)
        if (i < FULL_COUNT) {
          try {
            const embResp = await env.AI.run('@cf/baai/bge-m3', { text: [title] }) as any;
            const raw = embResp as any;
            if (Array.isArray(raw?.data) && raw.data.length > 0) {
              const it = raw.data[0];
              embedding = Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
            }
          } catch { /* 向量化失败不影响 */ }

          if (embedding.length > 0) {
            const similar = await findSimilarNews(env, embedding, TOPIC_MATCH_THRESHOLD, 3);
            if (similar.length > 0 && similar[0].topic_id) {
              const top = similar[0];
              topicId = top.topic_id;
              const updated = await updateTopicScore(env, top.topic_id, 1) as any;
              newsScore = updated.new_score || 0;
              newsLevel = updated.new_level || 'follow';
              fission = updated.fission_triggered || false;

              const simScore = top.similarity || 0;
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
            // topic_key 只是「topic 标识」，相似新闻不依赖它撞同 key
            // （findSimilarNews 已基于 bge-m3 向量聚类，相似新闻走 update_topic_score 不走这里）
            // 修复 KR0：原实现对中文标题会被清空（title.slice(0,8).replace(/[^a-zA-Z0-9]/g,'')）
            // 改为纯 hashStr，兼容中文；加 't-' 前缀便于辨识
            const titleHash = Math.abs(hashStr(title)).toString(36);
            const topicKey = `t-${titleHash}`;
            const created = await createTopic(env, topicKey, 'follow') as any;
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

        // Step 4: 写 Supabase(实时打分层)- 1 subrequest
        const newsId = await insertNewsHotspot(env, {
          title,
          url: item.url || '',
          source: 'zaker',
          category,
          hot_score: rule.score,
          published_at: item.publish_time || new Date().toISOString(),
          summary: (item.summary || '').substring(0, 200),
          embedding: embedding.length > 0 ? embedding : undefined,
          r2_key: r2Key,
          topic_id: topicId,
          level: newsLevel,
          score: newsScore,
          is_stored_r2: isStoredR2,
        });

        // Step 5: 关联新闻-话题(news_topic_members)- 1 subrequest
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
            velocity: trendSnapshot.out_velocity,        // v0.30.1: RETURNS TABLE 列改名避开 PL/pgSQL 歧义
            acceleration: trendSnapshot.out_acceleration, // v0.30.1
            stage: trendSnapshot.out_stage,              // v0.30.1
            warning_created: trendSnapshot.out_warning_created, // v0.30.1
          } : null,
          fission,
        });
        if (fission) console.log(`[FISSION] ${title}`);
      }

      return new Response(JSON.stringify({
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
      }), { headers: { 'Content-Type': 'application/json', ...cors } });
    }
    return new Response(JSON.stringify({ error: 'unknown action' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors }
    });
  },

  // ====== Cron Trigger: 每小时整点(UTC) 跑 process action ======
  // 替代之前误用的 GitHub Actions (HTTP 403 + Cloudflare challenge)
  // 选 CF cron 原因:
  //   1. Free tier 实际可用(每账号 5 个, CPU 10ms 限制, process 主要是 fetch 等待不算 CPU)
  //   2. Worker → 自家域名走 CF 内部 routing, 绕开 Bot Fight Mode challenge
  //   3. 0 漂移(精准整点), 0 外部依赖, 0 GitHub 配额消耗
  //   4. Mac cron 也可以删了
  // 调试: wrangler dev --test-scheduled
  //       访问 wrangler dev 暴露的 scheduled handler 触发路由(详见 CF 文档)
  async scheduled(controller, env, ctx) {
    const start = Date.now();
    const ts = new Date().toISOString();
    console.log(`[cron] process triggered at ${ts} cron=${controller?.cron || 'unknown'}`);
    try {
      // fetch 自家 Worker —— 走 CF 内部 routing, 不会触发 Bot Fight Mode
      // URL 从 env 读取 (wrangler.toml [vars].WORKER_SELF_URL), 不硬编码
      const url = `${env.WORKER_SELF_URL}?action=process`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${env.BEARER_TOKEN}`,
          'User-Agent': 'csnews-cron-trigger/1.0',
        },
      });
      const body = await res.text();
      const elapsed = Date.now() - start;
      console.log(`[cron] process done status=${res.status} elapsed=${elapsed}ms body=${body.slice(0, 500)}`);
    } catch (e: any) {
      const elapsed = Date.now() - start;
      console.error(`[cron] process failed elapsed=${elapsed}ms err=${e?.message || e}`);
    }
  },
};
