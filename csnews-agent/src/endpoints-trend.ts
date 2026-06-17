// ============================================================
// endpoints-trend.ts · v0.36.20 · csnews-audit 修复
// 3 个 action handler + 1 个 helper: content / trend / knowledge /
// runKnowledgeAccumulation
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - content: R2 全文内容读取端点
//   - trend: Trend topic velocity / acceleration
//   - knowledge: Knowledge Engine (早晨日报金句入口)
//   - runKnowledgeAccumulation: cron inline 调用
// ============================================================

import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import {
  validateId, validateFormat, rateKeyForIp, dailyHitsKeyForToday,
  escapeHtml, RATE_LIMIT_PER_MIN, PAYLOAD_LIMIT_BYTES,
} from './content-validation';
import {
  validateType, validateSince, validateLimit,
  rateKeyForIp as trendRateKeyForIp,
  dailyHitsKeyForToday as trendHitsKeyForToday,
  RATE_LIMIT_PER_MIN as TREND_RATE_LIMIT_PER_MIN,
  PAYLOAD_LIMIT_BYTES as TREND_PAYLOAD_LIMIT_BYTES,
} from './trend-validation';
import {
  validateType as knowledgeValidateType,
  validateSince as knowledgeValidateSince,
  validateLimit as knowledgeValidateLimit,
  validateTopicId,
  rateKeyForIp as knowledgeRateKeyForIp,
  dailyHitsKeyForToday as knowledgeHitsKeyForToday,
  RATE_LIMIT_PER_MIN as KNOWLEDGE_RATE_LIMIT_PER_MIN,
  PAYLOAD_LIMIT_BYTES as KNOWLEDGE_PAYLOAD_LIMIT_BYTES,
  knowledgeR2Key, KNOWLEDGE_INDEX_KEY,
} from './knowledge-validation';
import { checkRateLimit, rateLimitResponse, readR2Json } from './utils';

// ===================== content (R2 全文内容读取端点) =====================
// 用途: 消费者 (推送 / 第三方 IM 转发) 从 R2 拿 news_hotspots 关联的摘要 + 原始 URL
//   - 不动 news-process.ts 写路径 (0 风险)
//   - 不 fetch 正文 (留给后续 KR)
//   - 端点返 R2 真实存的字段 + Supabase 关联的 url 字段
//   - text/html/json 三档格式
// 反爬: 单 IP 60 req/min (复用 PROCESS_STATE KV)
// 鉴权: index.ts fetch handler 入口已统一 authRequest
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
  const { exceeded } = await checkRateLimit(env, ctx, rateKeyForIp(ip), RATE_LIMIT_PER_MIN);
  if (exceeded) return rateLimitResponse(cors, RATE_LIMIT_PER_MIN);

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
      ...(r2Error ? { notice: `该新闻仅存摘要 + 原始 URL · R2 不存正文 (原因: ${r2Error}) · 全文请访问 ${news.url}` } : {}),
    };
    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (format === 'text') {
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

// ===================== trend (Trend topic velocity) =====================
// 3 档 type:
//   - topics: 当前所有 active topic + 最近 news count
//   - velocity: topic 1h 增量 / 24h 平均 = velocity ratio
//   - acceleration: velocity 的 1h 增量 (二阶导)
// 反爬: 单 IP 60 req/min (独立 KV prefix trend_rate:<ip>)
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
  const { exceeded: trendExceeded } = await checkRateLimit(env, ctx, trendRateKeyForIp(ip), TREND_RATE_LIMIT_PER_MIN);
  if (trendExceeded) return rateLimitResponse(cors, TREND_RATE_LIMIT_PER_MIN);

  // 3. 计算时间窗边界
  const sinceTime = new Date(sinceIso);
  const oneHourAgo = new Date(sinceTime.getTime() - 3600 * 1000);
  const twoHourAgo = new Date(sinceTime.getTime() - 7200 * 1000);

  // 4. 根据 type 查数据
  let items: any[] = [];
  let description = '';

  if (type === 'topics') {
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at,first_news_id&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      items = await Promise.all(topics.map(async (t) => {
        const countRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const totalHeader = countRes.headers.get('content-range');
        const total = totalHeader ? parseInt(totalHeader.split('/')[1] || '0', 10) : 0;
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
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      items = await Promise.all(topics.map(async (t) => {
        const nowMs = Date.now();
        const nowMinus1h = new Date(nowMs - 3600 * 1000);
        const nowMinus2h = new Date(nowMs - 7200 * 1000);
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${nowMinus1h.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        const sinceRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`, { headers: { 'Prefer': 'count=exact' } });
        const sinceTotal = parseInt(sinceRes.headers.get('content-range')?.split('/')[1] || '0', 10);
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
    const topicsRes = await supabaseFetch(env, `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=${limit}`);
    const topics = await safeJson(topicsRes) as any[];
    if (topics && topics.length > 0) {
      items = await Promise.all(topics.map(async (t) => {
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        const between1h2hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${twoHourAgo.toISOString()}&joined_at=lt.${oneHourAgo.toISOString()}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const between1h2hTotal = parseInt(between1h2hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
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

// ===================== knowledge (早晨日报金句入口) =====================
// 快赢哲学:
//   - 不新建 Supabase 表 (避免 5h 配额期起床跑 SQL Editor)
//   - knowledge 数据全在 R2 持久化
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

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: knowledgeExceeded } = await checkRateLimit(env, ctx, knowledgeRateKeyForIp(ip), KNOWLEDGE_RATE_LIMIT_PER_MIN);
  if (knowledgeExceeded) return rateLimitResponse(cors, KNOWLEDGE_RATE_LIMIT_PER_MIN);

  // 3. 根据 type 查数据
  let items: any[] = [];
  let description = '';

  if (type === 'daily') {
    const allIndex = await readR2Json<any[]>(env, KNOWLEDGE_INDEX_KEY, []);
    const sinceMs = new Date(sinceIso).getTime();
    items = allIndex
      .filter((k) => k?.created_at && new Date(k.created_at).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    description = 'knowledge daily 索引 (早晨日报入口, 跨 topic 累积)';
  } else if (type === 'topic') {
    if (!topicId) {
      return new Response(JSON.stringify({ error: 'internal_logic', reason: 'topic_id 缺失 (validateTopicId 应已拦截)' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    const allIndex = await readR2Json<any[]>(env, KNOWLEDGE_INDEX_KEY, []);
    const sinceMs = new Date(sinceIso).getTime();
    items = allIndex
      .filter((k) => k?.topic_id === topicId)
      .filter((k) => k?.created_at && new Date(k.created_at).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    description = `knowledge topic 详情 (topic_id=${topicId}, 累积的所有 knowledge 记录)`;
  }

  // 4. 大小限制
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

// ===================== runKnowledgeAccumulation (cron inline 调用) =====================
// 整点 process 跑完调, 遍历 active topics → 累积 24h trend → 写 1 条 knowledge 记录
// 不调 LLM, 纯 SQL + 模板 + R2 only (0 Supabase DDL)
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

    // 2. 对每个 topic 累积 24h 趋势数据
    const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const twoHourAgo = new Date(Date.now() - 7200 * 1000).toISOString();

    // 3. 读 R2 索引 (累积分页查询用)
    let allIndex = await readR2Json<any[]>(env, KNOWLEDGE_INDEX_KEY, []);

    // 4. 累积每个 topic
    for (const t of topics) {
      try {
        // 4.1 24h news count
        const sinceRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const since24hTotal = parseInt(sinceRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 4.2 1h 增量
        const last1hRes = await supabaseFetch(env, `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo}&select=news_id&limit=0`, { method: 'HEAD', headers: { 'Prefer': 'count=exact' } });
        const last1hTotal = parseInt(last1hRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        // 4.3 2h 增量
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
          `## 早晨金句模板 (待接 AI 摘要)\n\n` +
          `_本 topic 在过去 24h 累积 ${since24hTotal} 条新闻, 1h 增量 ${last1hTotal} (${velocityRatio > 1 ? '高于' : '低于'} 24h 均值 ${Math.round(hourlyAvg * 100) / 100}), ` +
          `${acceleration > 0 ? '呈加速上升' : acceleration < 0 ? '呈减速下降' : '保持稳定'}._\n`;
        await env.csnews_raw.put(r2Key, markdown, { httpMetadata: { contentType: 'text/markdown' } });

        // 4.6 append 索引
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
