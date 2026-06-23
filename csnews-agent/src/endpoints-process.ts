// ============================================================
// endpoints-process.ts · v0.36.20 · csnews-audit 修复
// 4 个 action handler: process / health / logs / tavily
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - process: News Self Growth 主流程, cron 整点跑
//   - health: 15 维度 worker 可观测性检查
//   - logs: 读 R2 logs 端点
//   - tavily: Tavily News API ingestion, same cron slot as process
// ============================================================

import { Env } from './shared';
import { scoreRule, hashStr } from './score';
import { classify } from './classify';
import {
  cleanupStaleTopics,
  findSimilarNews,
  updateTopicScore,
  createTopic,
  insertNewsHotspotsBatch,
  recordTrendWithMember,
  saveToR2,
  dualWriteEmbeddingsToVectorize,
} from './news-process';
import { logEvent } from './log';
import { resetCacheMetrics } from './cache';
import { MCP_TOOLS_COUNT } from './mcp-handler';
import type {
  CleanupStaleTopicsResult,
  ZakerHotResponse,
  BgeEmbeddingResponse,
  UpdateTopicScoreResult,
  CreatedTopicRow,
} from './types';
import {
  checkLastProcessAt,
  checkSecretResolved,
  checkSupabaseCounts,
  checkR2LatestWrite,
  checkR2LatestSupabaseWrite,
  checkR2PrefixCounts,
  checkCronHistory,
  checkZscoreSignals,
  checkAiBudget,
  checkEntityAndEventFreshness,
  checkCacheMetrics,
  checkPullCacheFreshness,
  checkAiCallsBreakdown,
} from './health-checks';

// ===================== process (News Self Growth 主流程) =====================
export async function handleProcessAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // try/finally 包裹整个函数体, finally 写 KV last_process_at
  // 即使 throw (subrequest 超限 / 网络失败 / SQL 错) 也能记录 cron 最后运行时间, cron_health 派生真实状态
  try {
    // Step 0a: 重置 per-isolate cache metrics (小时窗口重置, 避免跨小时累加漂移)
    // cache metrics 是 module-level state, 跨 invoke 共享, 每小时 cron 起点清零
    // 让 health 端点 cache_metrics 反映"最近一小时"的 hit rate, 不是"历史累加"
    resetCacheMetrics();

    // Step 0: 清理过期话题簇 (1 subrequest)
    const cleaned = (await cleanupStaleTopics(env)) as CleanupStaleTopicsResult;

    // Step 1: 拉 ZAKER 热点 (1 subrequest)
    const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3', {
      signal: AbortSignal.timeout(10_000), // 10s 超时
    });
    const json = (await r.json()) as ZakerHotResponse;
    const list: any[] = json?.data?.list || [];
    if (list.length === 0) {
      return new Response(JSON.stringify({ error: 'no news' }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const results = [];
    const pendingNews: any[] = [];
    // 10 items max:
    //   - Full flow adds one TIE-lite snapshot RPC after topic join.
    //   - 6 full items + 2 global requests remain under the free Worker subrequest limit.
    //   - 后 4 条只写 Supabase (跳过向量查重) 节省 Neurons
    const FULL_COUNT = 6;

    for (let i = 0; i < list.slice(0, 10).length; i++) {
      const item = list[i];
      const title = item.title || '';
      if (!title) continue;

      // 规则引擎评分+分类
      // 传 item.summary 让 title+summary 混合 → 减少边界样本错位率
      const rule = scoreRule(title);
      const category = await classify(title, env, item.summary);

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

      // 仅前 FULL_COUNT 条做 embedding + 向量查重 (Workers AI CPU 限制)
      if (i < FULL_COUNT) {
        try {
          // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
          const embResp = (await env.AI.run('@cf/baai/bge-m3', {
            text: [title],
          })) as BgeEmbeddingResponse;
          const raw = embResp as BgeEmbeddingResponse;
          if (Array.isArray(raw?.data) && raw.data.length > 0) {
            const it = raw.data[0];
            embedding = Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
          }
        } catch {
          /* 向量化失败不影响 */
        }

        if (embedding.length > 0) {
          const similar = await findSimilarNews(env, embedding, 0.85, 3);
          if (similar.length > 0 && similar[0].topic_id) {
            const top = similar[0];
            topicId = top.topic_id;
            const updated = (await updateTopicScore(
              env,
              top.topic_id,
              1
            )) as UpdateTopicScoreResult;
            newsScore = updated.new_score || 0;
            newsLevel = updated.new_level || 'follow';
            fission = updated.fission_triggered || false;

            const simScore = top.similarity || 0;
            matchedSimilarity = simScore;
            if (simScore < 0.95) {
              r2Key = await saveToR2(env, 'news/zaker', {
                title,
                category,
                score: rule.score,
                source: 'zaker',
                topic_id: topicId,
                level: newsLevel,
                fission,
                similarity: simScore,
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
          // topic_key 只是「topic 标识」, 相似新闻不依赖它撞同 key
          // (findSimilarNews 已基于 bge-m3 向量聚类, 相似新闻走 update_topic_score 不走这里)
          // 改为纯 hashStr, 兼容中文; 加 't-' 前缀便于辨识
          const titleHash = Math.abs(hashStr(title)).toString(36);
          const topicKey = `t-${titleHash}`;
          const created = (await createTopic(env, topicKey, 'follow')) as CreatedTopicRow;
          if (created?.id) {
            topicId = created.id;
            newsScore = 0;
            newsLevel = 'follow';
            isNewTopic = true;
            r2Key = await saveToR2(env, 'news/zaker', {
              title,
              category,
              score: rule.score,
              source: 'zaker',
              topic_id: topicId,
              level: newsLevel,
              fission: false,
              created_at: new Date().toISOString(),
            });
            isStoredR2 = true;
            storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
          }
        }
      }

      // Step 4-5: 收集新闻对象, 循环结束批量插入 + record_trend_with_member 合并 RPC
      pendingNews.push({
        item,
        topicId,
        isNewTopic,
        newsLevel,
        newsScore,
        fission,
        matchedSimilarity,
        isStoredR2,
        storedReason,
        r2Key,
        embedding,
        title,
        category,
        rule,
      });
      if (fission) console.log(`[FISSION] ${title}`);
    }

    // batch insert: 10 条新闻 1 个 subrequest
    const batchNewsArray = pendingNews.map((p) => ({
      title: p.title,
      url: p.item.url || '',
      source: 'zaker',
      category: p.category,
      hot_score: p.rule.score,
      published_at: p.item.publish_time || new Date().toISOString(),
      summary: (p.item.summary || '').substring(0, 200),
      embedding: p.embedding.length > 0 ? p.embedding : null,
      r2_key: p.r2Key,
      topic_id: p.topicId,
      level: p.newsLevel,
      score: p.newsScore,
      is_stored_r2: p.isStoredR2,
    }));
    const batchIds = await insertNewsHotspotsBatch(env, batchNewsArray);

    // Dual-write embeddings to Vectorize
    // Fire-and-forget: Vectorize failure should not block process flow
    dualWriteEmbeddingsToVectorize(env, batchNewsArray, batchIds).catch((err) => {
      console.error('[Vectorize] dual-write failed:', err);
    });

    // record_trend_with_member: 合并 joinTopicMember + recordTrendSnapshot 为 1 RPC
    for (let i = 0; i < pendingNews.length; i++) {
      const p = pendingNews[i];
      const newsId = batchIds[i];
      if (newsId && p.topicId) {
        const trendSnapshot = await recordTrendWithMember(env, newsId, p.topicId, p.isNewTopic);
        results.push({
          title: p.title,
          category: p.category,
          score: p.rule.score,
          topic_id: p.topicId,
          similarity: p.matchedSimilarity,
          level: p.newsLevel,
          is_stored_r2: p.isStoredR2,
          stored_reason: p.storedReason,
          trend: trendSnapshot
            ? {
                snapshot_id: trendSnapshot.snapshot_id,
                warning_id: trendSnapshot.warning_id,
                velocity: trendSnapshot.out_velocity,
                acceleration: trendSnapshot.out_acceleration,
                stage: trendSnapshot.out_stage,
                warning_created: trendSnapshot.out_warning_created,
              }
            : null,
          fission: p.fission,
        });
      } else {
        // 无 newsId (batch 失败) 或无 topicId (skip trend) — 仍记录到 results
        results.push({
          title: p.title,
          category: p.category,
          score: p.rule.score,
          topic_id: p.topicId,
          similarity: p.matchedSimilarity,
          level: p.newsLevel,
          is_stored_r2: p.isStoredR2,
          stored_reason: p.storedReason,
          trend: null,
          fission: p.fission,
        });
      }
    }

    return new Response(
      JSON.stringify({
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
      }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  } finally {
    // finally 写 KV last_process_at
    // 不管 try 块成功/失败都跑, 任何 throw 都不会丢 cron 健康指标
    // 包装 SeedEnvelope, maxContentAgeMin = 0 (process 刚跑完, 最新鲜)
    if (env.PROCESS_STATE) {
      const ts = new Date().toISOString();
      const envelope = {
        _seed: {
          fetchedAt: ts,
          recordCount: 1,
          state: 'ok' as const,
          maxContentAgeMin: 0,
        },
        data: { last_process_at: ts },
      };
      await env.PROCESS_STATE.put('last_process_at', JSON.stringify(envelope), {
        expirationTtl: 86400 * 7,
      });
    }
  }
}

// ===================== health =====================
// 17 大维度检查 (拆分至 health-checks.ts)
//  1. last_process_at              - 最近 process 跑时间 (KV 持久化)
//  2. cron_health                  - 派生: last_process_at > 1.5h 前 = degraded / > 3h = down
//  3. secret_resolved              - WORKER_SELF_URL secret 是不是占位符
//  4. supabase_counts              - 6 张表精确行数
//  5. supabase_reachable           - Supabase 6 张表是否全部可查
//  6. r2_latest_write              - R2 news/zaker/ 最新写入 (informational only)
//  7. r2_latest_supabase_write     - Supabase news_hotspots 最新 created_at
//  8. r2_prefix_counts             - R2 各 prefix 行数
//  9. cron_history                 - R2 logs/ 上一小时 [scheduler] log 数量
// 10. zscore_signals_today        - 7d z-score 异常数
// 11. ai_budget_today             - 当日 AI 配额用量
// 12. entity_freshness             - entity cron 每日 1 次 跑后 freshness (ok<25h / degraded<50h)
// 13. event_freshness             - event cron 每日 1 次 跑后 freshness (ok<25h / degraded<50h)
// 14. cache_metrics                - pull KV 缓存 hit rate (per-isolate, hit_rate≥50%=ok)
// 15. pull_cache_freshness         - 按 news/entity/event 分组检查 pull 缓存新鲜度
// 16. neurons_used_today           - 当日 Neurons 总量 (Phase 4)
// 17. ai_budget_status             - 预算状态 tier (Phase 4)
// 18. ai_calls_breakdown           - 按 model 分当日调用次数 (Phase 4)
export async function handleHealthAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const ts = Date.now();
  const checks: Record<string, { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: any }> =
    {};
  const result: any = {
    status: 'ok',
    ts,
  };

  // 1+2. last_process_at + cron_health
  const lastProcessResult = await checkLastProcessAt(env, ts);
  result.last_process_at = lastProcessResult.last_process_at;
  result.cron_health = lastProcessResult.cron_health;
  checks.last_process_at = lastProcessResult.checks.last_process_at;
  checks.cron_health = lastProcessResult.checks.cron_health;

  // 3. secret_resolved
  const secretResult = checkSecretResolved(env);
  checks.secret_resolved = secretResult.checks.secret_resolved;

  // 4+5. supabase_counts + supabase_reachable
  const supabaseResult = await checkSupabaseCounts(env);
  result.supabase_counts = supabaseResult.supabase_counts;
  checks.supabase_reachable = supabaseResult.checks.supabase_reachable;

  // 6. r2_latest_write
  const r2LatestResult = await checkR2LatestWrite(env, ts);
  result.r2_latest_write = r2LatestResult.r2_latest_write;
  checks.r2_latest_write = r2LatestResult.checks.r2_latest_write;

  // 7. r2_latest_supabase_write
  const r2SupabaseResult = await checkR2LatestSupabaseWrite(env, ts);
  result.r2_latest_supabase_write = r2SupabaseResult.r2_latest_supabase_write;
  checks.r2_latest_supabase_write = r2SupabaseResult.checks.r2_latest_supabase_write;

  // 8. r2_prefix_counts
  const r2PrefixResult = await checkR2PrefixCounts(env);
  result.r2_prefix_counts = r2PrefixResult.r2_prefix_counts;

  // 9. cron_history
  const cronHistoryResult = await checkCronHistory(env, ts);
  result.cron_history = cronHistoryResult.cron_history;
  checks.cron_history = cronHistoryResult.checks.cron_history;

  // 10. zscore_signals_today
  const zscoreResult = await checkZscoreSignals(env, ts);
  result.zscore_signals_today = zscoreResult.zscore_signals_today;
  checks.zscore_signals_today = zscoreResult.checks.zscore_signals_today;

  // 11. ai_budget_today
  const aiBudgetResult = await checkAiBudget(env);
  result.ai_budget_today = aiBudgetResult.ai_budget_today;
  checks.ai_budget_today = aiBudgetResult.checks.ai_budget_today;

  // 12+13. entity_freshness + event_freshness
  const freshnessResult = await checkEntityAndEventFreshness(env);
  result.entity_freshness = freshnessResult.entity_freshness;
  result.event_freshness = freshnessResult.event_freshness;
  checks.entity_freshness = freshnessResult.checks.entity_freshness;
  checks.event_freshness = freshnessResult.checks.event_freshness;

  // 14. cache_metrics
  const cacheResult = checkCacheMetrics();
  result.cache_metrics = cacheResult.cache_metrics;
  checks.cache_metrics = cacheResult.checks.cache_metrics;

  // 15. pull_cache_freshness — 按 news/entity/event 分组检查 pull 缓存新鲜度
  const pullCacheFreshnessResult = await checkPullCacheFreshness(env, ts);
  result.pull_cache_freshness = pullCacheFreshnessResult.pull_cache_freshness;
  checks.pull_cache_freshness = pullCacheFreshnessResult.checks.pull_cache_freshness;

  // 16+17+18. Phase 4: neurons_used_today / ai_budget_status / ai_calls_breakdown
  const aiCallsResult = await checkAiCallsBreakdown(env);
  result.neurons_used_today = aiCallsResult.neurons_used_today;
  result.ai_budget_status = aiCallsResult.ai_budget_status;
  result.ai_calls_breakdown = aiCallsResult.ai_calls_breakdown;
  checks.ai_calls_breakdown = aiCallsResult.checks.ai_calls_breakdown;

  // 17. mcp_tools_count — MCP Server 工具数量（O13-MCP）
  result.mcp_tools_count = MCP_TOOLS_COUNT;

  // 整体 status 聚合
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes('down')) result.status = 'down';
  else if (statuses.includes('degraded')) result.status = 'degraded';
  else if (statuses.every((s) => s === 'ok' || s === 'unknown')) result.status = 'ok';
  else result.status = 'degraded';

  result.checks = checks;

  // health endpoint 永远返 HTTP 200
  // 原因: "API 健康" 跟 "业务健康" 是 2 件事
  //   - API 健康 = HTTP code 表达 (200 = 通, 5xx = 挂了)
  //   - 业务健康 = body.status 表达 (ok / degraded / down)
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== ai-usage =====================
// ?action=ai-usage 端点 (Phase 4)
// 读取 KV usage/{date} 聚合 7 天 history，按 model + day 聚合
export async function handleAiUsageAction(
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (!env.AI_USAGE_KV) {
    return new Response(JSON.stringify({ error: 'AI_USAGE_KV binding missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 生成过去 7 天 UTC 日期列表
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }

  // 并行读取 7 天 KV 数据
  const kvResults = await Promise.allSettled(
    dates.map((date) => env.AI_USAGE_KV!.get(`usage/${date}`))
  );

  // 按 model + day 聚合
  // 结构: { [date]: { [model]: { calls: number, neurons: number } } }
  type DayModelAgg = { calls: number; neurons: number };
  const aggregated: Record<string, Record<string, DayModelAgg>> = {};

  for (let i = 0; i < kvResults.length; i++) {
    const result = kvResults[i];
    const date = dates[i];
    aggregated[date] = {};

    if (result.status === 'fulfilled' && result.value) {
      try {
        const record = JSON.parse(result.value) as {
          total: number;
          calls: Array<{ model: string; neurons: number }>;
        };
        for (const call of record.calls ?? []) {
          const model = call.model || 'unknown';
          if (!aggregated[date][model]) {
            aggregated[date][model] = { calls: 0, neurons: 0 };
          }
          aggregated[date][model].calls++;
          aggregated[date][model].neurons += call.neurons;
        }
      } catch {
        // parse failed, skip
      }
    }
  }

  // 扁平化返回格式
  type UsageEntry = { date: string; model: string; calls: number; neurons: number };
  const entries: UsageEntry[] = [];
  for (const [date, models] of Object.entries(aggregated)) {
    for (const [model, agg] of Object.entries(models)) {
      entries.push({ date, model, calls: agg.calls, neurons: agg.neurons });
    }
  }

  // 按 date desc 排序
  entries.sort((a, b) => b.date.localeCompare(a.date));

  return new Response(
    JSON.stringify({ days: 7, entries, total_entries: entries.length }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}

// ===================== logs =====================
// ?action=logs&date=YYYY-MM-DD&hour=HH&limit=N 端点
// 读 R2 `logs/YYYY-MM-DD/HH.log` 按 ts 倒序返回
export async function handleLogsAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const params = url.searchParams;
  const now = new Date();
  const todayUtc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  // 1. 解析 + 校验
  const rawDate = params.get('date') || 'today';
  let date: string;
  if (rawDate === 'today') {
    date = todayUtc;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    date = rawDate;
  } else {
    return new Response(JSON.stringify({ error: "date must be YYYY-MM-DD or 'today'" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const hourParam = params.get('hour');
  let hour: number | null = null;
  if (hourParam !== null) {
    hour = parseInt(hourParam, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return new Response(JSON.stringify({ error: 'hour must be 0-23' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  const limit = Math.min(Math.max(parseInt(params.get('limit') || '100', 10), 1), 500);

  // 2. date range ≤ 7d 校验
  const requestedDate = new Date(date + 'T00:00:00Z');
  const todayDate = new Date(todayUtc + 'T00:00:00Z');
  const diffDays = (todayDate.getTime() - requestedDate.getTime()) / 86400_000;
  if (diffDays > 7 || diffDays < 0) {
    return new Response(JSON.stringify({ error: 'date range max 7 days (0-7 days back)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 3. R2 list + 读 log entries
  // log 颗粒度做细 (新格式: key=logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log)
  // 兼容: 旧格式 logs/YYYY-MM-DD/HH.log (单条 line 在 file 内)
  let entries: any[] = [];
  try {
    const prefix = `logs/${date}/`;
    const list = await env.csnews_raw.list({ prefix, limit: 1000 });
    for (const obj of list.objects) {
      // 旧格式兼容: HH.log (无子目录)
      if (/^\d{2}\.log$/.test(obj.key.split('/').pop() || '')) {
        if (hour !== null && !obj.key.endsWith(`/${String(hour).padStart(2, '0')}.log`)) continue;
      } else {
        // 新格式: HH/MM-SS-fff-source.log
        const parts = obj.key.split('/');
        if (parts.length < 3) continue;
        const hh = parts[parts.length - 2];
        if (hour !== null && hh !== String(hour).padStart(2, '0')) continue;
      }
      const body = await env.csnews_raw.get(obj.key);
      if (!body) continue;
      const text = await body.text();
      for (const line of text.split('\n')) {
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
    return new Response(
      JSON.stringify({ error: 'r2 unavailable', detail: e?.message || String(e) }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  // 4. 按 ts 倒序
  entries.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  // 5. 取 limit
  const items = entries.slice(0, limit);
  const truncated = entries.length > items.length;

  return new Response(
    JSON.stringify({
      date,
      hour: hour,
      count: items.length,
      total: entries.length,
      truncated,
      items,
    }),
    {
      headers: { 'Content-Type': 'application/json', ...cors },
    }
  );
}

// ===================== tavily (Tavily News API ingestion) =====================
// Scheduled cron every 2 hours (CF cron slot 6 of 5 — runs as HTTP action).
// Design: separate from ZAKER process to keep AI embedding budget predictable.
// - Fetches ~10 articles per run (2 queries × 5 results)
// - Cross-source dedup via Vectorize (> 0.88 similarity → skip)
// - Batch insert to news_hotspots with source='tavily'
// - Dual-write to Vectorize

/** Preset search queries for Tavily ingestion. Adjust as news coverage needs evolve. */
const TAVILY_QUERIES = [
  'top trending news today worldwide',
  'breaking technology business science news',
];

export async function handleTavilyAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const start = Date.now();
  const apiKey = env.TAVILY_API_KEY;
  const maxPerQuery = Math.max(1, Math.min(parseInt(url.searchParams.get('max') || '5', 10), 10));

  // Aggregate all fetched articles across queries
  const allArticles: import('./tavily').NormalizedArticle[] = [];
  const fetchErrors: string[] = [];

  for (const query of TAVILY_QUERIES) {
    const { fetchTavilyNews } = await import('./tavily');
    const articles = await fetchTavilyNews(apiKey, query, maxPerQuery);
    if (articles.length === 0 && apiKey && apiKey !== 'YOUR_KEY_HERE') {
      fetchErrors.push(`query="${query}" returned 0 results`);
    }
    allArticles.push(...articles);
  }

  if (allArticles.length === 0) {
    return new Response(
      JSON.stringify({
        source: 'tavily',
        fetched: 0,
        inserted: 0,
        skipped_duplicates: 0,
        errors: fetchErrors,
        elapsed_ms: Date.now() - start,
      }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }

  // Deduplicate by URL before processing
  const seen = new Set<string>();
  const uniqueArticles = allArticles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  const results: Array<{
    title: string;
    url: string;
    similarity: number | null;
    stored_reason: string;
  }> = [];
  const pendingNews: Array<{
    title: string;
    url: string;
    source: string;
    category: string | undefined;
    published_at: string;
    summary: string | undefined;
    embedding: number[];
    topicId: string | undefined;
    isNewTopic: boolean;
    newsLevel: string;
    newsScore: number;
    matchedSimilarity: number | null;
  }> = [];

  // Process all unique articles (Tavily articles ≤ ZAKER 10-item budget)
  // Embed top 6 to stay within AI embedding budget (same as ZAKER FULL_COUNT)
  const EMBED_COUNT = 6;

  for (let i = 0; i < uniqueArticles.length; i++) {
    const article = uniqueArticles[i];
    const title = article.title;

    let topicId: string | undefined;
    let embedding: number[] = [];
    let matchedSimilarity: number | null = null;
    let newsLevel = 'follow';
    let newsScore = 0;
    let isNewTopic = false;
    let storedReason = 'lightweight_no_embedding';

    if (i < EMBED_COUNT) {
      try {
        const embResp = (await env.AI.run('@cf/baai/bge-m3', {
          text: [title],
        })) as import('./types').BgeEmbeddingResponse;
        if (Array.isArray(embResp?.data) && embResp.data.length > 0) {
          const it = embResp.data[0];
          embedding = Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
        }
      } catch {
        /* embedding failure: skip dedup check for this article */
      }

      if (embedding.length > 0) {
        const similar = await findSimilarNews(env, embedding, 0.88, 3);
        if (similar.length > 0 && similar[0].topic_id) {
          const top = similar[0];
          topicId = top.topic_id;
          const updated = (await updateTopicScore(
            env,
            top.topic_id,
            1
          )) as import('./types').UpdateTopicScoreResult;
          newsScore = updated.new_score || 0;
          newsLevel = updated.new_level || 'follow';
          matchedSimilarity = top.similarity || null;
          const simScore = top.similarity || 0;
          if (simScore < 0.95) {
            storedReason = 'same_topic_new_angle';
          } else {
            storedReason = 'same_topic_duplicate';
          }
        }
      }

      if (!topicId) {
        const titleHash = Math.abs(hashStr(title)).toString(36);
        const topicKey = `t-${titleHash}`;
        const created = (await createTopic(
          env,
          topicKey,
          'follow'
        )) as import('./types').CreatedTopicRow;
        if (created?.id) {
          topicId = created.id;
          newsScore = 0;
          newsLevel = 'follow';
          isNewTopic = true;
          storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
        }
      }
    }

    pendingNews.push({
      title,
      url: article.url,
      source: 'tavily',
      category: article.category,
      published_at: article.published_at,
      summary: article.summary,
      embedding,
      topicId,
      isNewTopic,
      newsLevel,
      newsScore,
      matchedSimilarity,
    });

    results.push({
      title,
      url: article.url,
      similarity: matchedSimilarity,
      stored_reason: storedReason,
    });
  }

  // Batch insert all articles (Tavily articles + R2 stored metadata)
  const batchNewsArray = pendingNews.map((p) => ({
    title: p.title,
    url: p.url || '',
    source: p.source,
    category: p.category,
    hot_score: undefined as number | undefined,
    published_at: p.published_at,
    summary: (p.summary || '').substring(0, 200),
    embedding: p.embedding.length > 0 ? p.embedding : undefined,
    r2_key: undefined as string | undefined,
    topic_id: p.topicId,
    level: p.newsLevel,
    score: p.newsScore,
    is_stored_r2: false,
  }));

  const batchIds = await insertNewsHotspotsBatch(env, batchNewsArray);

  // Dual-write embeddings to Vectorize
  dualWriteEmbeddingsToVectorize(env, batchNewsArray, batchIds).catch((err) => {
    console.error('[Tavily] Vectorize dual-write failed:', err);
  });

  // Record trend membership for articles with topicId
  for (let i = 0; i < pendingNews.length; i++) {
    const p = pendingNews[i];
    const newsId = batchIds[i];
    if (newsId && p.topicId) {
      await recordTrendWithMember(env, newsId, p.topicId, p.isNewTopic);
    }
  }

  const inserted = batchIds.filter(Boolean).length;
  const skipped = results.filter((r) => r.stored_reason === 'same_topic_duplicate').length;

  return new Response(
    JSON.stringify({
      source: 'tavily',
      fetched: uniqueArticles.length,
      inserted,
      skipped_duplicates: skipped,
      errors: fetchErrors,
      elapsed_ms: Date.now() - start,
      items: results,
    }),
    { headers: { 'Content-Type': 'application/json', ...cors } }
  );
}
