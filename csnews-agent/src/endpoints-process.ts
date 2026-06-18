// ============================================================
// endpoints-process.ts · v0.36.20 · csnews-audit 修复
// 3 个 action handler: process / health / logs
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - process: News Self Growth 主流程, cron 整点跑
//   - health: 11 维度 worker 可观测性检查
//   - logs: 读 R2 logs 端点
// ============================================================

import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { scoreRule, hashStr } from './score';
import { classify } from './classify';
import {
  cleanupStaleTopics, findSimilarNews, updateTopicScore,
  createTopic, insertNewsHotspotsBatch, recordTrendWithMember, saveToR2,
} from './news-process';
import { logEvent } from './log';
import { countAnomalySignals } from './zscore';
import { getBudgetStatus } from './ai-budget';
import { checkEntityCronHealth } from './utils';

// ===================== process (News Self Growth 主流程) =====================
export async function handleProcessAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // try/finally 包裹整个函数体, finally 写 KV last_process_at
  // 即使 throw (subrequest 超限 / 网络失败 / SQL 错) 也能记录 cron 最后运行时间, cron_health 派生真实状态
  try {
    // Step 0: 清理过期话题簇 (1 subrequest)
    const cleaned = await cleanupStaleTopics(env) as any;

    // Step 1: 拉 ZAKER 热点 (1 subrequest)
    const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3', {
      signal: AbortSignal.timeout(10_000), // 10s 超时
    });
    const json = await r.json() as any;
    const list: any[] = json?.data?.list || [];
    if (list.length === 0) {
      return new Response(JSON.stringify({ error: 'no news' }), { headers: { 'Content-Type': 'application/json', ...cors } });
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

      // 仅前 FULL_COUNT 条做 embedding + 向量查重 (Workers AI CPU 限制)
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
          const similar = await findSimilarNews(env, embedding, 0.85, 3);
          if (similar.length > 0 && similar[0].topic_id) {
            const top = similar[0];
            topicId = top.topic_id;
            const updated = await updateTopicScore(env, top.topic_id, 1) as any;
            newsScore = updated.new_score || 0;
            newsLevel = updated.new_level || 'follow';
            fission = updated.fission_triggered || false;

            const simScore = top.similarity || 0;
            matchedSimilarity = simScore;
            if (simScore < 0.95) {
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
          // topic_key 只是「topic 标识」, 相似新闻不依赖它撞同 key
          // (findSimilarNews 已基于 bge-m3 向量聚类, 相似新闻走 update_topic_score 不走这里)
          // 改为纯 hashStr, 兼容中文; 加 't-' 前缀便于辨识
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

      // Step 4-5: 收集新闻对象, 循环结束批量插入 + record_trend_with_member 合并 RPC
      pendingNews.push({
        item, topicId, isNewTopic, newsLevel, newsScore, fission,
        matchedSimilarity, isStoredR2, storedReason, r2Key, embedding, title, category, rule,
      });
      if (fission) console.log(`[FISSION] ${title}`);
    }

    // batch insert: 10 条新闻 1 个 subrequest
    const batchNewsArray = pendingNews.map(p => ({
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
          trend: trendSnapshot ? {
            snapshot_id: trendSnapshot.snapshot_id,
            warning_id: trendSnapshot.warning_id,
            velocity: trendSnapshot.out_velocity,
            acceleration: trendSnapshot.out_acceleration,
            stage: trendSnapshot.out_stage,
            warning_created: trendSnapshot.out_warning_created,
          } : null,
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

    return new Response(JSON.stringify({
      processed: results.length,
      cleaned: cleaned?.deleted_topic_count || 0,
      items: results,
    }), { headers: { 'Content-Type': 'application/json', ...cors } });
  } finally {
    // finally 写 KV last_process_at
    // 不管 try 块成功/失败都跑, 任何 throw 都不会丢 cron 健康指标
    if (env.PROCESS_STATE) {
      await env.PROCESS_STATE.put("last_process_at", new Date().toISOString(), { expirationTtl: 86400 * 7 });
    }
  }
}

// ===================== health =====================
// 13 大维度检查
//  1. last_process_at              - 最近 process 跑时间 (KV 持久化)
//  2. cron_health                  - 派生: last_process_at > 1.5h 前 = degraded / > 3h = down
//  3. secret_resolved              - WORKER_SELF_URL secret 是不是占位符
//  4. supabase_counts              - 6 张表精确行数
//  5. supabase_reachable           - Supabase 6 张表是否全部可查
//  6. r2_latest_write              - R2 news/zaker/ 最新写入 (informational only)
//  7. r2_latest_supabase_write     - Supabase news_hotspots 最新 created_at
//  8. r2_prefix_counts             - R2 各 prefix 行数
//  9. cron_history                 - R2 logs/ 上一小时 [scheduler] log 数量
// 10. zscore_signals_today         - 7d z-score 异常数
// 11. ai_budget_today              - 当日 AI 配额用量
// 12. entity_freshness             - entity cron 每日 1 次 跑后 freshness (ok<25h / degraded<50h)
// 13. event_freshness              - event cron 每日 1 次 跑后 freshness (ok<25h / degraded<50h)
export async function handleHealthAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const ts = Date.now();
  const checks: Record<string, { status: "ok" | "degraded" | "down" | "unknown"; detail: any }> = {};
  const result: any = {
    status: "ok",  // 整体 status: ok / degraded / down
    ts,
  };

  // ========== 2. last_process_at (KV 持久化) ==========
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

  // ========== 3. cron_health (派生) ==========
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
    cronHealth = "degraded";
  }
  result.cron_health = cronHealth;
  checks.cron_health = {
    status: cronHealth,
    detail: typeof result.last_process_at === "string"
      ? `${Math.round((ts - Date.parse(result.last_process_at)) / 60000)} min ago`
      : "no last_process_at recorded"
  };

  // ========== 4. secret_resolved (看 WORKER_SELF_URL 是不是占位符) ==========
  const selfUrl = env.WORKER_SELF_URL || "";
  const isPlaceholder = selfUrl === "DO_NOT_USE" ||
    selfUrl === "https://YOUR-WORKER.workers.dev" ||
    selfUrl.includes("YOUR-WORKER") ||
    selfUrl === "";
  checks.secret_resolved = {
    status: isPlaceholder ? "down" : "ok",
    detail: isPlaceholder ? `placeholder: "${selfUrl}"` : `set to non-placeholder URL`
  };

  // ========== 5+6. supabase_counts + supabase_reachable (6 张表 parallel fetch) ==========
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

  // ========== 7. r2_latest_write (informational only) ==========
  try {
    const list = await env.csnews_raw.list({ prefix: "news/zaker/", limit: 1000 });
    if (list.objects && list.objects.length > 0) {
      const sorted = [...list.objects].sort((a, b) => b.key.localeCompare(a.key));
      const latestObj = sorted[0];
      let lastWriteTs: number | null = null;
      let lastWriteSource: "r2_uploaded" | "content_created_at" = "r2_uploaded";
      if (latestObj.uploaded) {
        lastWriteTs = latestObj.uploaded.getTime();
      } else {
        const body = await env.csnews_raw.get(latestObj.key);
        if (body) {
          const text = await body.text();
          try {
            const parsed = JSON.parse(text);
            if (parsed.created_at) {
              lastWriteTs = Date.parse(parsed.created_at);
              lastWriteSource = "content_created_at";
            }
          } catch { }
        }
      }
      result.r2_latest_write = {
        key: latestObj.key,
        uploaded: latestObj.uploaded ? latestObj.uploaded.toISOString() : null,
        source: lastWriteSource,
      };
      const ageLabel = lastWriteTs
        ? `historical: last R2 news/zaker/ write ${Math.round((ts - lastWriteTs) / 3600_000)}h ago (process no longer writes R2 news/zaker/, see r2_latest_supabase_write for current process status)`
        : "no uploaded or content.created_at (historical data)";
      checks.r2_latest_write = { status: "ok", detail: ageLabel };
    } else {
      result.r2_latest_write = null;
      checks.r2_latest_write = { status: "ok", detail: "no objects in news/zaker/ (historical prefix, informational only)" };
    }
  } catch (e: any) {
    result.r2_latest_write = { error: e?.message || "r2 unavailable" };
    checks.r2_latest_write = { status: "ok", detail: `r2 list failed: ${e?.message} (informational, does not impact process status)` };
  }

  // ========== 7b. r2_latest_supabase_write (真实 process 状态) ==========
  try {
    const res = await fetch(`${getSupabaseHost(env)}/rest/v1/news_hotspots?select=created_at&order=created_at.desc&limit=1`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const arr = await res.json() as Array<{ created_at: string }>;
    if (arr && arr.length > 0 && arr[0].created_at) {
      const lastWriteMs = Date.parse(arr[0].created_at);
      if (Number.isFinite(lastWriteMs)) {
        const ageMs = ts - lastWriteMs;
        result.r2_latest_supabase_write = {
          last_write: arr[0].created_at,
          source: "supabase_news_hotspots",
        };
        if (ageMs < 1.5 * 3600_000) {
          checks.r2_latest_supabase_write = { status: "ok", detail: `last news_hotspots write ${Math.round(ageMs / 60000)} min ago` };
        } else if (ageMs < 3 * 3600_000) {
          checks.r2_latest_supabase_write = { status: "degraded", detail: `last news_hotspots write ${Math.round(ageMs / 60)} min ago (> 1.5h, expected every 1h)` };
        } else {
          checks.r2_latest_supabase_write = { status: "down", detail: `last news_hotspots write ${Math.round(ageMs / 3600_000)}h ago (> 3h, process stale)` };
        }
      } else {
        result.r2_latest_supabase_write = { last_write: arr[0].created_at, source: "supabase_news_hotspots" };
        checks.r2_latest_supabase_write = { status: "unknown", detail: "created_at unparseable" };
      }
    } else {
      result.r2_latest_supabase_write = null;
      checks.r2_latest_supabase_write = { status: "down", detail: "news_hotspots table empty (no data ever)" };
    }
  } catch (e: any) {
    result.r2_latest_supabase_write = { error: e?.message || "supabase query failed" };
    checks.r2_latest_supabase_write = { status: "down", detail: e?.message };
  }

  // ========== 8. r2_prefix_counts (各 prefix 行数) ==========
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

  // ========== 9. cron_history (看上一小时 R2 logs 是否有 [scheduler] log) ==========
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

  // ========== 10. zscore_signals_today (7d z-score 异常数) ==========
  try {
    const sevenDaysAgo = new Date(ts - 7 * 24 * 3600 * 1000).toISOString();
    const snapshotsRes = await supabaseFetch(env, `/rest/v1/trend_snapshots?select=id,topic_id,score,velocity,acceleration,created_at&created_at=gte.${sevenDaysAgo}&order=created_at.desc&limit=500`);
    const snapshots = (await safeJson(snapshotsRes) as any[]) || [];

    let totalAnomalies = 0;
    const anomaliesByField: Record<string, number> = { score: 0, velocity: 0, acceleration: 0 };
    if (snapshots.length >= 2) {
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
        : `0 anomalies in last 7d (algorithm ready, wakeup review pending)`,
    };
  } catch (e: any) {
    result.zscore_signals_today = { error: e?.message || "zscore calc failed" };
    checks.zscore_signals_today = { status: "unknown", detail: e?.message };
  }

  // ========== 11. ai_budget_today ==========
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

  // ========== 12. entity_freshness + 13. event_freshness ==========
  // 读 R2 entity-finalized.json + event-clusters.json 元数据, 按阈值分类
  // viewer dashboard 立即看到 entity/event cron 是否 stale (之前 viewer 不知道何时跑)
  // entity / event cron 每日 1 次 (03:00 / 03:30 UTC), 阈值 25h / 50h
  try {
    const { entity_freshness, event_freshness } = await checkEntityCronHealth(env);
    result.entity_freshness = entity_freshness;
    result.event_freshness = event_freshness;
    checks.entity_freshness = {
      status: entity_freshness.status,
      detail: entity_freshness.detail,
    };
    checks.event_freshness = {
      status: event_freshness.status,
      detail: event_freshness.detail,
    };
  } catch (e: any) {
    // 1 个失败不影响其他: entity_freshness + event_freshness 都返 unknown
    result.entity_freshness = { error: e?.message || "entity freshness check failed" };
    result.event_freshness = { error: e?.message || "event freshness check failed" };
    checks.entity_freshness = { status: "unknown", detail: e?.message };
    checks.event_freshness = { status: "unknown", detail: e?.message };
  }

  // ========== 整体 status 聚合 ==========
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes("down")) result.status = "down";
  else if (statuses.includes("degraded")) result.status = "degraded";
  else if (statuses.every((s) => s === "ok" || s === "unknown")) result.status = "ok";
  else result.status = "degraded";

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
  // log 颗粒度做细 (新格式: key=logs/YYYY-MM-DD/HH/MM-SS-fff-{source}.log)
  // 兼容: 旧格式 logs/YYYY-MM-DD/HH.log (单条 line 在 file 内)
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

// ===================== db-schema (TEMPORARY DEBUG, 5min 用完删) =====================
// entity_hot 表 Supabase 真创建检查 (临时 debug endpoint, 5min 用完删)
// 业务契约:
//   - 200 + entity_hot_exists: true → 表真存在 + 列 OK 数 / 总数
//   - 404 → 表不存在 (GitHub 同步没触发)
//   - 401 → SUPABASE_SERVICE_KEY 无效
//   - 500 → 网络错
export async function handleDbSchemaAction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  try {
    const probeRes = await fetch(`${getSupabaseHost(env)}/rest/v1/entity_hot?select=*&limit=0`, {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });

    if (probeRes.status === 404) {
      return new Response(JSON.stringify({
        entity_hot_exists: false,
        status: 404,
        error: 'entity_hot table not found in Supabase (GitHub sync may not have triggered)',
        checked_at: new Date().toISOString(),
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    if (!probeRes.ok) {
      return new Response(JSON.stringify({
        entity_hot_exists: 'unknown',
        status: probeRes.status,
        error: `HTTP ${probeRes.status}: ${(await probeRes.text()).slice(0, 200)}`,
        checked_at: new Date().toISOString(),
      }, null, 2), {
        status: probeRes.status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // 200 = entity_hot 表存在, 验 10 列 + 4 indexes
    const expectedColumns = [
      'id', 'name', 'type', 'confidence', 'source',
      'first_seen', 'last_seen', 'mention_count',
      'created_at', 'archived_at', 'status',
    ];
    const columnCheck: Record<string, boolean> = {};
    for (const col of expectedColumns) {
      const cr = await fetch(`${getSupabaseHost(env)}/rest/v1/entity_hot?select=${col}&limit=0`, {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      });
      columnCheck[col] = cr.ok;
    }

    return new Response(JSON.stringify({
      entity_hot_exists: true,
      status: 200,
      columns: columnCheck,
      columns_ok: Object.values(columnCheck).filter(Boolean).length,
      columns_total: expectedColumns.length,
      note: 'indexes (4) verified separately via migrations file (idx_entity_hot_type / name_trgm / status / created_at)',
      checked_at: new Date().toISOString(),
    }, null, 2), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      entity_hot_exists: 'unknown',
      error: e?.message || String(e),
      checked_at: new Date().toISOString(),
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}
