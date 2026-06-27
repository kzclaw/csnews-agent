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

import { Env, supabaseFetch, safeJson, validationError, parseCountHeader, payloadTooLargeResponse, jsonResponse } from './shared';
import { logEvent } from './log';
import {
  validateId,
  validateFormat,
  rateKeyForIp,
  dailyHitsKeyForToday,
  escapeHtml,
  RATE_LIMIT_PER_MIN,
  PAYLOAD_LIMIT_BYTES,
} from './content-validation';
import {
  validateType,
  validateSince,
  validateLimit,
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
  knowledgeR2Key,
  KNOWLEDGE_INDEX_KEY,
} from './knowledge-validation';
import { checkRateLimit, rateLimitResponse, readR2Json, incrementHitCounter } from './utils';
import { shouldTriggerAiCall } from './ai-budget';
import type { NewsHotspotRow, TopicRow, R2ContentData } from './types';

// ===================== content (R2 全文内容读取端点) =====================
// 用途: 消费者 (推送 / 第三方 IM 转发) 从 R2 拿 news_hotspots 关联的摘要 + 原始 URL
//   - 不动 news-process.ts 写路径 (0 风险)
//   - 不 fetch 正文 (留给后续 KR)
//   - 端点返 R2 真实存的字段 + Supabase 关联的 url 字段
//   - text/html/json 三档格式
// 反爬: 单 IP 60 req/min (复用 PROCESS_STATE KV)
// 鉴权: index.ts fetch handler 入口已统一 authRequest
export async function handleContentAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 输入校验 (业务红线)
  const id = url.searchParams.get('id') || '';
  const idValidation = validateId(id);
  if (!idValidation.ok) return validationError(idValidation, cors);

  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const formatValidation = validateFormat(format);
  if (!formatValidation.ok) return validationError(formatValidation, cors);

  // 2. 反爬限流 (单 IP 60 req/min, 复用 PROCESS_STATE KV)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded } = await checkRateLimit(env, ctx, rateKeyForIp(ip), RATE_LIMIT_PER_MIN);
  if (exceeded) return rateLimitResponse(cors, RATE_LIMIT_PER_MIN);

  // 3. Supabase 查 news_hotspots (拿 url + r2_key + 基础摘要)
  const newsRes = await supabaseFetch(
    env,
    `/rest/v1/news_hotspots?id=eq.${id}&select=id,title,url,source,category,hot_score,score,level,topic_id,r2_key,created_at&limit=1`
  );
  const newsData = (await safeJson(newsRes)) as NewsHotspotRow[];
  if (!newsData || newsData.length === 0) {
    return jsonResponse(
      { error: 'not_found', reason: `id=${id} 在 news_hotspots 表不存在` },
      cors,
      { status: 404 }
    );
  }
  const news = newsData[0];

  // 4. R2 拿 content (按 news.r2_key)
  // R2ContentData 接口覆盖 content endpoint 用到的字段（来自 saveToR2 写入结构）
  let r2Data: R2ContentData | null = null;
  let r2Error: string | null = null;
  if (news.r2_key) {
    try {
      const obj = await env.csnews_raw.get(news.r2_key);
      if (obj) {
        const text = await obj.text();
        r2Data = JSON.parse(text) as R2ContentData;
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
    return payloadTooLargeResponse(
      `R2 content > ${PAYLOAD_LIMIT_BYTES} bytes, 请用 format=ids 分页`,
      PAYLOAD_LIMIT_BYTES,
      cors
    );
  }

  // 6. 监控计数 (r2_content_endpoint_hits_24h) - 复用 PROCESS_STATE
  ctx.waitUntil(incrementHitCounter(env, ctx, dailyHitsKeyForToday, PAYLOAD_LIMIT_BYTES));

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
      r2: r2Data
        ? {
            key: news.r2_key,
            title: r2Data.title,
            category: r2Data.category,
            score: r2Data.score,
            level: r2Data.level,
            topic_id: r2Data.topic_id,
            fission: r2Data.fission,
            created_at: r2Data.created_at,
            content_length: contentLength,
          }
        : null,
      ...(r2Error
        ? {
            notice: `该新闻仅存摘要 + 原始 URL · R2 不存正文 (原因: ${r2Error}) · 全文请访问 ${news.url}`,
          }
        : {}),
    };
    return jsonResponse(responseBody, cors);
  }

  if (format === 'text') {
    const lines: string[] = [];
    lines.push(`标题: ${news.title}`);
    lines.push(`来源: ${news.source} · ${news.category || '未知分类'}`);
    lines.push(
      `热度: hot_score=${news.hot_score ?? '?'} score=${news.score ?? '?'} level=${news.level ?? '?'}`
    );
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
export async function handleTrendAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 输入校验
  const typeValidation = validateType(url.searchParams.get('type'));
  if (!typeValidation.ok) return validationError(typeValidation, cors);
  const type = typeValidation.reason!;

  const sinceValidation = validateSince(url.searchParams.get('since'));
  if (!sinceValidation.ok) return validationError(sinceValidation, cors);
  const sinceIso = sinceValidation.since!;

  const limitValidation = validateLimit(url.searchParams.get('limit'));
  if (!limitValidation.ok) return validationError(limitValidation, cors);
  const limit = limitValidation.limit;

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: trendExceeded } = await checkRateLimit(
    env,
    ctx,
    trendRateKeyForIp(ip),
    TREND_RATE_LIMIT_PER_MIN
  );
  if (trendExceeded) return rateLimitResponse(cors, TREND_RATE_LIMIT_PER_MIN);

  // 3. 计算时间窗边界
  const sinceTime = new Date(sinceIso);
  const oneHourAgo = new Date(sinceTime.getTime() - 3600 * 1000);
  const twoHourAgo = new Date(sinceTime.getTime() - 7200 * 1000);

  // 4. 根据 type 查数据
  let items: any[] = [];
  let description = '';

  if (type === 'topics') {
    const topicsRes = await supabaseFetch(
      env,
      `/rest/v1/topics?select=id,topic_key,level,score,last_active_at,first_news_id&order=last_active_at.desc&limit=${limit}`
    );
    const topics = (await safeJson(topicsRes)) as TopicRow[];
    if (topics && topics.length > 0) {
      items = await Promise.all(
        topics.map(async (t) => {
          const countRes = await supabaseFetch(
            env,
            `/rest/v1/news_topic_members?topic_id=eq.${t.id}&select=news_id&limit=0`,
            { method: 'HEAD', headers: { Prefer: 'count=exact' } }
          );
          const total = parseCountHeader(countRes);
          return {
            topic_id: t.id,
            topic_key: t.topic_key,
            level: t.level,
            score: t.score,
            last_active_at: t.last_active_at,
            first_news_id: t.first_news_id,
            total_news_count: total,
          };
        })
      );
    }
    description = '当前所有 active topic (按 last_active_at 倒序)';
  } else if (type === 'velocity' || type === 'acceleration') {
    // 公共: 拉取 topic 列表 (velocity / acceleration 共用)
    const topicsRes = await supabaseFetch(
      env,
      `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=${limit}`
    );
    const topics = (await safeJson(topicsRes)) as TopicRow[];
    if (topics && topics.length > 0) {
      if (type === 'velocity') {
        items = await Promise.all(
          topics.map(async (t) => {
            const nowMs = Date.now();
            const nowMinus1h = new Date(nowMs - 3600 * 1000);
            const last1hRes = await supabaseFetch(
              env,
              `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${nowMinus1h.toISOString()}&select=news_id&limit=0`,
              { method: 'HEAD', headers: { Prefer: 'count=exact' } }
            );
            const last1hTotal = parseCountHeader(last1hRes);
            const sinceRes = await supabaseFetch(
              env,
              `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`,
              { headers: { Prefer: 'count=exact' } }
            );
            const sinceTotal = parseCountHeader(sinceRes);
            const hourlyAvg = sinceTotal / 24;
            const velocityRatio = hourlyAvg > 0 ? last1hTotal / hourlyAvg : 0;
            return {
              topic_id: t.id,
              topic_key: t.topic_key,
              level: t.level,
              score: t.score,
              last_1h_count: last1hTotal,
              hourly_avg: Math.round(hourlyAvg * 100) / 100,
              velocity_ratio: Math.round(velocityRatio * 100) / 100,
              trend:
                velocityRatio > 2
                  ? 'explosive'
                  : velocityRatio > 1
                    ? 'rising'
                    : velocityRatio < 0.5
                      ? 'declining'
                      : 'stable',
            };
          })
        );
        description = 'topic velocity (1h 增量 / 24h 均值)';
      } else {
        items = await Promise.all(
          topics.map(async (t) => {
            const last1hRes = await supabaseFetch(
              env,
              `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo.toISOString()}&select=news_id&limit=0`,
              { method: 'HEAD', headers: { Prefer: 'count=exact' } }
            );
            const last1hTotal = parseCountHeader(last1hRes);
            const between1h2hRes = await supabaseFetch(
              env,
              `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${twoHourAgo.toISOString()}&joined_at=lt.${oneHourAgo.toISOString()}&select=news_id&limit=0`,
              { method: 'HEAD', headers: { Prefer: 'count=exact' } }
            );
            const between1h2hTotal = parseCountHeader(between1h2hRes);
            const acceleration = last1hTotal - between1h2hTotal;
            return {
              topic_id: t.id,
              topic_key: t.topic_key,
              level: t.level,
              score: t.score,
              last_1h_count: last1hTotal,
              previous_1h_count: between1h2hTotal,
              acceleration: acceleration,
              trend:
                acceleration > 0 ? 'accelerating' : acceleration < 0 ? 'decelerating' : 'stable',
            };
          })
        );
        description = 'topic acceleration (二阶导, 1h 增量 - 上一小时增量)';
      }
    }
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
    return payloadTooLargeResponse(
      `trend response > ${TREND_PAYLOAD_LIMIT_BYTES} bytes, 请用 limit 调小`,
      TREND_PAYLOAD_LIMIT_BYTES,
      cors
    );
  }

  // 6. 监控计数
  ctx.waitUntil(incrementHitCounter(env, ctx, trendHitsKeyForToday, TREND_PAYLOAD_LIMIT_BYTES));

  return jsonResponse(JSON.parse(responseStr), cors);
}

// ===================== knowledge (早晨日报金句入口) =====================
// 快赢哲学:
//   - 不新建 Supabase 表 (避免 5h 配额期起床跑 SQL Editor)
//   - knowledge 数据全在 R2 持久化
//   - 累积 job 在 cron inline 跑, 遍历 active topics → 写 knowledge/yyyymm/<topic_id>-<ts>.md
//   - 端点读 R2 索引 + 单 topic 详情 (跟 trend endpoint 模式同款)
export async function handleKnowledgeAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 输入校验 (跟 trend 同款, 独立 validation import)
  const typeValidation = knowledgeValidateType(url.searchParams.get('type'));
  if (!typeValidation.ok) return validationError(typeValidation, cors);
  const type = typeValidation.reason!;

  const sinceValidation = knowledgeValidateSince(url.searchParams.get('since'));
  if (!sinceValidation.ok) return validationError(sinceValidation, cors);
  const sinceIso = sinceValidation.since!;

  const limitValidation = knowledgeValidateLimit(url.searchParams.get('limit'));
  if (!limitValidation.ok) return validationError(limitValidation, cors);
  const limit = limitValidation.limit;

  const topicIdValidation = validateTopicId(url.searchParams.get('topic_id'), type);
  if (!topicIdValidation.ok) return validationError(topicIdValidation, cors);
  const topicId = topicIdValidation.topicId;

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: knowledgeExceeded } = await checkRateLimit(
    env,
    ctx,
    knowledgeRateKeyForIp(ip),
    KNOWLEDGE_RATE_LIMIT_PER_MIN
  );
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
      return jsonResponse(
        {
          error: 'internal_logic',
          reason: 'topic_id 缺失 (validateTopicId 应已拦截)',
        },
        cors,
        { status: 500 }
      );
    }
    const allIndex = await readR2Json<any[]>(env, KNOWLEDGE_INDEX_KEY, []);
    const sinceMs = new Date(sinceIso).getTime();
    items = allIndex
      .filter((k) => k?.topic_id === topicId && k?.created_at && new Date(k.created_at).getTime() >= sinceMs)
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
    return payloadTooLargeResponse(
      `knowledge response > ${KNOWLEDGE_PAYLOAD_LIMIT_BYTES} bytes, 请用 limit 调小`,
      KNOWLEDGE_PAYLOAD_LIMIT_BYTES,
      cors
    );
  }

  // 5. 监控计数 (跟 trend 同模式, 独立 prefix)
  ctx.waitUntil(incrementHitCounter(env, ctx, knowledgeHitsKeyForToday, KNOWLEDGE_PAYLOAD_LIMIT_BYTES));

  return jsonResponse(JSON.parse(responseStr), cors);
}

// ===================== runKnowledgeAccumulation (cron inline 调用) =====================
// 整点 process 跑完调, 遍历 active topics → 累积 24h trend → 写 1 条 knowledge 记录
// 不调 LLM, 纯 SQL + 模板 + R2 only (0 Supabase DDL)
export async function runKnowledgeAccumulation(
  env: Env,
  ctx: ExecutionContext
): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors = 0;
  try {
    // 1. 拉所有 active topics (跟 trend 同款, last_active_at desc, limit 50 = 早晨日报默认覆盖)
    const topicsRes = await supabaseFetch(
      env,
      `/rest/v1/topics?select=id,topic_key,level,score,last_active_at&order=last_active_at.desc&limit=50`
    );
    const topics = (await safeJson(topicsRes)) as TopicRow[];
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
        const since24hRes = await supabaseFetch(
          env,
          `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${sinceIso}&select=news_id&limit=0`,
          { method: 'HEAD', headers: { Prefer: 'count=exact' } }
        );
        const since24hTotal = parseCountHeader(since24hRes);
        // 4.2 1h 增量
        const last1hRes = await supabaseFetch(
          env,
          `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${oneHourAgo}&select=news_id&limit=0`,
          { method: 'HEAD', headers: { Prefer: 'count=exact' } }
        );
        const last1hTotal = parseCountHeader(last1hRes);
        // 4.3 2h 增量
        const between1h2hRes = await supabaseFetch(
          env,
          `/rest/v1/news_topic_members?topic_id=eq.${t.id}&joined_at=gte.${twoHourAgo}&joined_at=lt.${oneHourAgo}&select=news_id&limit=0`,
          { method: 'HEAD', headers: { Prefer: 'count=exact' } }
        );
        const between1h2hTotal = parseCountHeader(between1h2hRes);
        // 4.4 计算 velocity + acceleration
        const hourlyAvg = since24hTotal / 24;
        const velocityRatio = hourlyAvg > 0 ? last1hTotal / hourlyAvg : 0;
        const acceleration = last1hTotal - between1h2hTotal;

        // 4.5 写 R2 knowledge Markdown (早晨日报金句)
        const ts = new Date();
        const r2Key = knowledgeR2Key(t.id, ts);
        const markdown =
          `# ${t.topic_key}\n\n` +
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
        await env.csnews_raw.put(r2Key, markdown, {
          httpMetadata: { contentType: 'text/markdown' },
        });

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
        await logEvent(env, 'error', `[knowledge] topic ${t.id} accumulation failed: ${e?.message || e}`, undefined, 'trend');
      }
    }

    // 5. 写 R2 索引 (累积分页查询用, 早晨日报入口)
    if (written > 0) {
      if (allIndex.length > 1000) {
        allIndex = allIndex
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 1000);
      }
      await env.csnews_raw.put(KNOWLEDGE_INDEX_KEY, JSON.stringify(allIndex), {
        httpMetadata: { contentType: 'application/json' },
      });
    }

    return { written, errors };
  } catch (e: any) {
    await logEvent(env, 'error', `[knowledge] accumulation job failed: ${e?.message || e}`, undefined, 'trend');
    return { written, errors: errors + 1 };
  }
}

// ===================== runKnowledgeGeneration (warning-triggered 24h insight) =====================
// Warning 创建 24h 后自动生成 insight:
//   1. 扫 warnings 表找 created_at 落在 23h-25h 窗口的记录 (覆盖 cron 漂移)
//   2. 查 Supabase knowledge 表确认该 warning_id 未处理 (幂等)
//   3. 查 topic 信息 + top-5 新闻标题 + trend_snapshots
//   4. 写 R2: knowledge/{topic_id}/{timestamp}.md (结构化 Markdown)
//   5. 写 Supabase knowledge 表 (索引/引用)
//
// 不调 LLM, 纯 SQL + 模板 (快赢哲学)
// 触发: application-level scheduler (不依赖 pg_cron)
export async function runKnowledgeGeneration(
  env: Env
): Promise<{ written: number; skipped: number; errors: number }> {
  // Phase 2: 预算检查 L6（Knowledge generation）
  if (!(await shouldTriggerAiCall(env, 'L6'))) {
    await logEvent(env, 'warn', '[knowledge-gen] skipped: Neurons budget exceeded for L6 threshold', undefined, 'trend');
    return { written: 0, skipped: 0, errors: 0 };
  }

  let written = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // 1. 时间窗口: 23h-25h ago (覆盖 cron 漂移 ±1h)
    const now = Date.now();
    const windowStart = new Date(now - 25 * 3600 * 1000).toISOString();
    const windowEnd = new Date(now - 23 * 3600 * 1000).toISOString();

    // 2. 扫 warnings 表
    const warningsRes = await supabaseFetch(
      env,
      `/rest/v1/warnings?created_at=gte.${encodeURIComponent(windowStart)}&created_at=lte.${encodeURIComponent(windowEnd)}&status=eq.open&select=id,topic_id,warning_type,severity,reason,created_at`
    );
    const warnings: Array<{
      id: string;
      topic_id: string;
      warning_type: string;
      severity: string;
      reason: string;
      created_at: string;
    }> = await safeJson(warningsRes);
    if (!warnings || warnings.length === 0) {
      return { written: 0, skipped: 0, errors: 0 };
    }

    // 3. 查已有 knowledge 记录 (幂等:跳过已处理的 warning)
    const existingRes = await supabaseFetch(
      env,
      `/rest/v1/knowledge?warning_id=in.(${warnings.map((w) => w.id).join(',')})&select=warning_id`
    );
    const existing: Array<{ warning_id: string }> = await safeJson(existingRes);
    const processedWarnings = new Set(existing.map((e) => e.warning_id));

    const pendingWarnings = warnings.filter((w) => !processedWarnings.has(w.id));
    if (pendingWarnings.length === 0) {
      return { written: 0, skipped: warnings.length, errors: 0 };
    }

    // 4. 对每个 pending warning 生成 insight
    for (const w of pendingWarnings) {
      try {
        const ts = new Date();
        const tsIso = ts.toISOString();

        // 4.1 查 topic 信息
        const topicRes = await supabaseFetch(
          env,
          `/rest/v1/topics?id=eq.${w.topic_id}&select=id,topic_key,level,score,last_active_at&limit=1`
        );
        const topics: Array<{ id: string; topic_key: string; level: string; score: number; last_active_at: string | null }> =
          await safeJson(topicRes);
        const topic = topics[0];
        if (!topic) {
          await logEvent(env, 'warn', `[knowledge-gen] topic ${w.topic_id} not found for warning ${w.id}`, undefined, 'trend');
          skipped++;
          continue;
        }

        // 4.2 查 top-5 新闻标题 (按 hot_score desc)
        const sinceIso = new Date(now - 24 * 3600 * 1000).toISOString();
        const newsRes = await supabaseFetch(
          env,
          `/rest/v1/news_hotspots?topic_id=eq.${w.topic_id}&published_at=gte.${encodeURIComponent(sinceIso)}&select=id,title,source,hot_score&order=hot_score.desc&limit=5`
        );
        const news: Array<{ id: string; title: string | null; source: string | null; hot_score: number | null }> =
          await safeJson(newsRes);

        // 4.3 查 trend_snapshots (最近 24h)
        const snapshotsRes = await supabaseFetch(
          env,
          `/rest/v1/trend_snapshots?topic_id=eq.${w.topic_id}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,score,velocity,acceleration,stage,created_at&order=created_at.desc&limit=10`
        );
        const snapshots: Array<{
          id: string;
          score: number | null;
          velocity: number | null;
          acceleration: number | null;
          stage: string | null;
          created_at: string;
        }> = await safeJson(snapshotsRes);

        // 4.4 计算汇总数据
        const newsCount = news.length;
        const latestSnapshot = snapshots[0] || null;
        const avgVelocity =
          snapshots.length > 0
            ? snapshots.reduce((s, snap) => s + (snap.velocity || 0), 0) / snapshots.length
            : 0;
        const maxVelocity =
          snapshots.length > 0 ? Math.max(...snapshots.map((s) => s.velocity || 0)) : 0;
        const confidence = Math.min(
          0.99,
          Math.max(0.1, (topic.score || 0) / 10 + (newsCount / 5) * 0.2)
        );

        // 4.5 生成 insight 摘要文本
        const velocityLabel =
          avgVelocity > 2
            ? '🔥 高热'
            : avgVelocity > 1
              ? '📈 上升'
              : avgVelocity < 0.5
                ? '📉 下降'
                : '➡️ 平稳';
        const insight =
          `【${topic.topic_key}】${velocityLabel} · 24h ${newsCount}条新闻 · ` +
          `话题评分 ${topic.score} · ${latestSnapshot?.stage ? `阶段 ${latestSnapshot.stage}` : '阶段未知'}` +
          ` · 均速 ${avgVelocity.toFixed(2)} · 最高 ${maxVelocity.toFixed(2)}`;

        // 4.6 构造 R2 Markdown (topic 标题 + trend_snapshots 摘要 + top-5 新闻)
        const r2Key = `knowledge/${topic.id}/${tsIso.replace(/[:.]/g, '-')}.md`;
        const newsList =
          news.length > 0
            ? news
                .map((n, i) => `${i + 1}. **${n.title || '(无标题)'}** — ${n.source || '未知来源'} (hot_score=${n.hot_score ?? '?'})`)
                .join('\n')
            : '_24h 无相关新闻_';

        const snapshotTable =
          snapshots.length > 0
            ? `| 时间 | 评分 | 速度 | 加速度 | 阶段 |\n|------|------|------|--------|------|\n` +
              snapshots
                .map(
                  (s) =>
                    `| ${new Date(s.created_at).toLocaleString('zh-CN')} | ${s.score ?? '?'} | ${s.velocity?.toFixed(2) ?? '?'} | ${s.acceleration?.toFixed(2) ?? '?'} | ${s.stage ?? '?'} |`
                )
                .join('\n')
            : '_暂无趋势快照_';

        const markdown =
          `# ${topic.topic_key}\n\n` +
          `> **Insight 摘要**: ${insight}\n` +
          `> **触发来源**: warning=${w.warning_type} (severity=${w.severity})\n` +
          `> **生成时间**: ${tsIso}\n` +
          `> **置信度**: ${(confidence * 100).toFixed(0)}%\n\n` +
          `---\n\n` +
          `## 基础信息\n\n` +
          `- **话题 ID**: ${topic.id}\n` +
          `- **等级**: ${topic.level}\n` +
          `- **评分**: ${topic.score}\n` +
          `- **最后活跃**: ${topic.last_active_at || '未知'}\n` +
          `- **Warning 原因**: ${w.reason || '无'}\n\n` +
          `## Top-5 新闻标题 (24h)\n\n` +
          `${newsList}\n\n` +
          `## 趋势快照 (24h)\n\n` +
          `${snapshotTable}\n\n` +
          `---\n\n` +
          `_由 CSNEWS Knowledge Engine 自动生成于 ${tsIso}_\n`;

        // 4.7 写 R2
        await env.csnews_raw.put(r2Key, markdown, {
          httpMetadata: { contentType: 'text/markdown' },
        });

        // 4.8 写 Supabase knowledge 表 (幂等)
        const insertRes = await supabaseFetch(env, '/rest/v1/knowledge', {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: JSON.stringify([
            {
              topic_id: topic.id,
              warning_id: w.id,
              insight,
              confidence,
              r2_key: r2Key,
              created_at: tsIso,
            },
          ]),
        });
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          // 23505 = unique violation (并发幂等), 忽略不报错
          if (!errText.includes('23505')) {
            throw new Error(`knowledge insert failed HTTP ${insertRes.status}: ${errText.slice(0, 200)}`);
          }
          await logEvent(env, 'info', `[knowledge-gen] warning ${w.id} already inserted (idempotent skip)`, undefined, 'trend');
          skipped++;
          continue;
        }
        const inserted: Array<{ id: string }> = await safeJson(insertRes);
        await logEvent(env, 'info', `[knowledge-gen] wrote knowledge id=${inserted[0]?.id} r2=${r2Key} warning=${w.id}`, undefined, 'trend');
        written++;
      } catch (e: any) {
        errors++;
        await logEvent(env, 'error', `[knowledge-gen] warning ${w.id} failed: ${e?.message || e}`, undefined, 'trend');
      }
    }

    return { written, skipped, errors };
  } catch (e: any) {
    await logEvent(env, 'error', `[knowledge-gen] job failed: ${e?.message || e}`, undefined, 'trend');
    return { written, skipped: 0, errors: errors + 1 };
  }
}
