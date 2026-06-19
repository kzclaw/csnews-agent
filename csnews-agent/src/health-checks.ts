// ============================================================
// health-checks.ts · v0.36.x
// handleHealthAction 子函数拆分
//
// 每个函数职责单一: 检查一个维度, 返回 result 片段 + check 状态
// ============================================================

import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { countAnomalySignals } from './zscore';
import { getBudgetStatus } from './ai-budget';
import { checkEntityCronHealth } from './utils';
import { getCacheMetrics } from './cache';
import type { TrendSnapshotRow } from './types';

// ============================================================
// 1. last_process_at + cron_health 派生
// ============================================================
export async function checkLastProcessAt(
  env: Env,
  ts: number,
): Promise<{
  last_process_at: string | null | { error: string };
  cron_health: "ok" | "degraded" | "down";
  checks: {
    last_process_at: { status: "ok" | "degraded" | "down"; detail: string };
    cron_health: { status: "ok" | "degraded" | "down"; detail: string };
  };
}> {
  const checks: any = {};
  let lastProcessAt: string | null | { error: string } = null;

  // last_process_at
  try {
    if (env.PROCESS_STATE) {
      const last = await env.PROCESS_STATE.get("last_process_at");
      lastProcessAt = last;
      checks.last_process_at = { status: last ? "ok" : "degraded", detail: last || "KV empty" };
    } else {
      lastProcessAt = null;
      checks.last_process_at = { status: "down", detail: "PROCESS_STATE KV binding missing" };
    }
  } catch (e: any) {
    lastProcessAt = { error: e?.message || "kv unavailable" };
    checks.last_process_at = { status: "down", detail: e?.message };
  }

  // cron_health (派生)
  let cronHealth: "ok" | "degraded" | "down" = "ok";
  if (typeof lastProcessAt === "string") {
    const lastMs = Date.parse(lastProcessAt);
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

  checks.cron_health = {
    status: cronHealth,
    detail:
      typeof lastProcessAt === "string"
        ? `${Math.round((ts - Date.parse(lastProcessAt)) / 60000)} min ago`
        : "no last_process_at recorded",
  };

  return {
    last_process_at: lastProcessAt,
    cron_health: cronHealth,
    checks: {
      last_process_at: checks.last_process_at,
      cron_health: checks.cron_health,
    },
  };
}

// ============================================================
// 2. secret_resolved — WORKER_SELF_URL 占位符检查
// ============================================================
export function checkSecretResolved(
  env: Env,
): {
  checks: {
    secret_resolved: { status: "ok" | "down"; detail: string };
  };
} {
  const selfUrl = env.WORKER_SELF_URL || "";
  const isPlaceholder =
    selfUrl === "DO_NOT_USE" ||
    selfUrl === "https://YOUR-WORKER.workers.dev" ||
    selfUrl.includes("YOUR-WORKER") ||
    selfUrl === "";

  return {
    checks: {
      secret_resolved: {
        status: isPlaceholder ? "down" : "ok",
        detail: isPlaceholder ? `placeholder: "${selfUrl}"` : "set to non-placeholder URL",
      },
    },
  };
}

// ============================================================
// 3. supabase_counts + supabase_reachable — 6 表并行计数
// ============================================================
export async function checkSupabaseCounts(
  env: Env,
): Promise<{
  supabase_counts: Record<string, number | { error: string }>;
  checks: {
    supabase_reachable: { status: "ok" | "degraded" | "down"; detail: string };
  };
}> {
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
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          Prefer: "count=exact",
        },
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`${tbl.name}: HTTP ${r.status} ${errText.slice(0, 200)}`);
      }
      const cr = r.headers.get("Content-Range") || "";
      const total = cr.split("/").pop();
      return { name: tbl.name, total: total && total !== "*" ? parseInt(total, 10) : 0 };
    }),
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

  return {
    supabase_counts: supabaseCounts,
    checks: {
      supabase_reachable: {
        status:
          supabaseOkCount === supabaseTables.length
            ? "ok"
            : supabaseOkCount === 0
              ? "down"
              : "degraded",
        detail: `${supabaseOkCount}/${supabaseTables.length} tables OK`,
      },
    },
  };
}

// ============================================================
// 4. r2_latest_write — news/zaker/ 最新写入 (informational)
// ============================================================
export async function checkR2LatestWrite(
  env: Env,
  ts: number,
): Promise<{
  r2_latest_write: { key: string; uploaded: string | null; source: string } | null | { error: string };
  checks: {
    r2_latest_write: { status: "ok"; detail: string };
  };
}> {
  const checks: any = {};
  let r2LatestWrite: { key: string; uploaded: string | null; source: string } | null | { error: string } = null;

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
          } catch { /* ignore parse errors */ }
        }
      }
      r2LatestWrite = {
        key: latestObj.key,
        uploaded: latestObj.uploaded ? latestObj.uploaded.toISOString() : null,
        source: lastWriteSource,
      };
      const ageLabel = lastWriteTs
        ? `historical: last R2 news/zaker/ write ${Math.round((ts - lastWriteTs) / 3600_000)}h ago (process no longer writes R2 news/zaker/, see r2_latest_supabase_write for current process status)`
        : "no uploaded or content.created_at (historical data)";
      checks.r2_latest_write = { status: "ok", detail: ageLabel };
    } else {
      r2LatestWrite = null;
      checks.r2_latest_write = {
        status: "ok",
        detail: "no objects in news/zaker/ (historical prefix, informational only)",
      };
    }
  } catch (e: any) {
    r2LatestWrite = { error: e?.message || "r2 unavailable" };
    checks.r2_latest_write = {
      status: "ok",
      detail: `r2 list failed: ${e?.message} (informational, does not impact process status)`,
    };
  }

  return {
    r2_latest_write: r2LatestWrite,
    checks: { r2_latest_write: checks.r2_latest_write },
  };
}

// ============================================================
// 5. r2_latest_supabase_write — news_hotspots 最新写入 (真实状态)
// ============================================================
export async function checkR2LatestSupabaseWrite(
  env: Env,
  ts: number,
): Promise<{
  r2_latest_supabase_write: { last_write: string; source: string } | null | { error: string };
  checks: {
    r2_latest_supabase_write: { status: "ok" | "degraded" | "down" | "unknown"; detail: string };
  };
}> {
  let r2LatestSupabaseWrite: { last_write: string; source: string } | null | { error: string } = null;
  const checks: any = {};

  try {
    const res = await fetch(
      `${getSupabaseHost(env)}/rest/v1/news_hotspots?select=created_at&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
    }
    const arr = (await res.json()) as Array<{ created_at: string }>;
    if (arr && arr.length > 0 && arr[0].created_at) {
      const lastWriteMs = Date.parse(arr[0].created_at);
      if (Number.isFinite(lastWriteMs)) {
        const ageMs = ts - lastWriteMs;
        r2LatestSupabaseWrite = { last_write: arr[0].created_at, source: "supabase_news_hotspots" };
        if (ageMs < 1.5 * 3600_000) {
          checks.r2_latest_supabase_write = {
            status: "ok",
            detail: `last news_hotspots write ${Math.round(ageMs / 60000)} min ago`,
          };
        } else if (ageMs < 3 * 3600_000) {
          checks.r2_latest_supabase_write = {
            status: "degraded",
            detail: `last news_hotspots write ${Math.round(ageMs / 60)} min ago (> 1.5h, expected every 1h)`,
          };
        } else {
          checks.r2_latest_supabase_write = {
            status: "down",
            detail: `last news_hotspots write ${Math.round(ageMs / 3600_000)}h ago (> 3h, process stale)`,
          };
        }
      } else {
        r2LatestSupabaseWrite = { last_write: arr[0].created_at, source: "supabase_news_hotspots" };
        checks.r2_latest_supabase_write = { status: "unknown", detail: "created_at unparseable" };
      }
    } else {
      r2LatestSupabaseWrite = null;
      checks.r2_latest_supabase_write = {
        status: "down",
        detail: "news_hotspots table empty (no data ever)",
      };
    }
  } catch (e: any) {
    r2LatestSupabaseWrite = { error: e?.message || "supabase query failed" };
    checks.r2_latest_supabase_write = { status: "down", detail: e?.message };
  }

  return {
    r2_latest_supabase_write: r2LatestSupabaseWrite,
    checks: { r2_latest_supabase_write: checks.r2_latest_supabase_write },
  };
}

// ============================================================
// 6. r2_prefix_counts — 各 prefix 行数
// ============================================================
export async function checkR2PrefixCounts(
  env: Env,
): Promise<{
  r2_prefix_counts: Record<string, number | { error: string }>;
}> {
  const r2Prefixes = [
    "news/zaker/",
    "news/",
    "embeddings/",
    "fission/",
    "trends/",
    "warnings/",
    "logs/",
  ];
  const r2PrefixCounts: Record<string, number | { error: string }> = {};

  const r2Results = await Promise.allSettled(
    r2Prefixes.map(async (prefix) => {
      const list = await env.csnews_raw.list({ prefix, limit: 1000 });
      return { prefix, count: list.objects?.length || 0 };
    }),
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

  return { r2_prefix_counts: r2PrefixCounts };
}

// ============================================================
// 7. cron_history — 本小时 scheduler logs
// ============================================================
export async function checkCronHistory(
  env: Env,
  ts: number,
): Promise<{
  cron_history: { this_hour: { hour: string; scheduler_log_count: number } } | { error: string };
  checks: {
    cron_history: { status: "ok" | "degraded" | "unknown"; detail: string };
  };
}> {
  let cronHistory: { this_hour: { hour: string; scheduler_log_count: number } } | { error: string } = {
    this_hour: { hour: "", scheduler_log_count: 0 },
  };
  const checks: any = {};

  try {
    const now = new Date(ts);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const list = await env.csnews_raw.list({ prefix: `logs/${yyyy}-${mm}-${dd}/${hh}/`, limit: 100 });
    const thisHourSchedulerLogs = list.objects?.filter((o) => o.key.includes("-scheduler.log")) || [];
    cronHistory = {
      this_hour: {
        hour: `${yyyy}-${mm}-${dd}T${hh}`,
        scheduler_log_count: thisHourSchedulerLogs.length,
      },
    };
    checks.cron_history = {
      status: thisHourSchedulerLogs.length >= 1 ? "ok" : "degraded",
      detail:
        thisHourSchedulerLogs.length >= 1
          ? `${thisHourSchedulerLogs.length} scheduler logs this hour`
          : "no scheduler logs this hour (cron may not have run)",
    };
  } catch (e: any) {
    cronHistory = { error: e?.message };
    checks.cron_history = { status: "unknown", detail: e?.message };
  }

  return {
    cron_history: cronHistory,
    checks: { cron_history: checks.cron_history },
  };
}

// ============================================================
// 8. zscore_signals_today — 7d z-score 异常数
// ============================================================
export async function checkZscoreSignals(
  env: Env,
  ts: number,
): Promise<{
  zscore_signals_today: {
    total_7d: number;
    by_field_7d: Record<string, number>;
    snapshots_analyzed: number;
    window: string;
  } | { error: string };
  checks: {
    zscore_signals_today: { status: "ok" | "unknown"; detail: string };
  };
}> {
  let zscoreSignalsToday:
    | { total_7d: number; by_field_7d: Record<string, number>; snapshots_analyzed: number; window: string }
    | { error: string } = { total_7d: 0, by_field_7d: { score: 0, velocity: 0, acceleration: 0 }, snapshots_analyzed: 0, window: "7d" };
  const checks: any = {};

  try {
    const sevenDaysAgo = new Date(ts - 7 * 24 * 3600 * 1000).toISOString();
    const snapshotsRes = await supabaseFetch(
      env,
      `/rest/v1/trend_snapshots?select=id,topic_id,score,velocity,acceleration,created_at&created_at=gte.${sevenDaysAgo}&order=created_at.desc&limit=500`,
    );
    const snapshots = ((await safeJson(snapshotsRes)) as TrendSnapshotRow[]) || [];

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
        for (const field of ["score", "velocity", "acceleration"] as const) {
          const count = countAnomalySignals(topicSnapshots, field);
          anomaliesByField[field] += count;
          totalAnomalies += count;
        }
      }
    }

    zscoreSignalsToday = {
      total_7d: totalAnomalies,
      by_field_7d: anomaliesByField,
      snapshots_analyzed: snapshots.length,
      window: "7d",
    };
    checks.zscore_signals_today = {
      status: "ok",
      detail:
        totalAnomalies > 0
          ? `${totalAnomalies} z-score anomalies in last 7d (${JSON.stringify(anomaliesByField)})`
          : `0 anomalies in last 7d (algorithm ready, wakeup review pending)`,
    };
  } catch (e: any) {
    zscoreSignalsToday = { error: e?.message || "zscore calc failed" };
    checks.zscore_signals_today = { status: "unknown", detail: e?.message };
  }

  return {
    zscore_signals_today: zscoreSignalsToday,
    checks: { zscore_signals_today: checks.zscore_signals_today },
  };
}

// ============================================================
// 9. ai_budget_today
// ============================================================
export async function checkAiBudget(
  env: Env,
): Promise<{
  ai_budget_today: { used: number; tier: string; remaining: number; quota: number } | { error: string };
  checks: {
    ai_budget_today: { status: "ok" | "degraded" | "down" | "unknown"; detail: string };
  };
}> {
  let aiBudgetToday: { used: number; tier: string; remaining: number; quota: number } | { error: string } = {
    used: 0,
    tier: "ok",
    remaining: 0,
    quota: 0,
  };
  const checks: any = {};

  try {
    const budget = await getBudgetStatus(env);
    aiBudgetToday = { used: budget.used, tier: budget.tier, remaining: budget.remaining, quota: budget.quota };
    checks.ai_budget_today = {
      status: budget.tier === "shutdown" ? "down" : budget.tier === "critical" ? "degraded" : "ok",
      detail: `daily used: ${budget.used} / ${budget.quota} (${budget.tier})`,
    };
  } catch (e: any) {
    aiBudgetToday = { error: e?.message || "ai_budget calc failed" };
    checks.ai_budget_today = { status: "unknown", detail: e?.message };
  }

  return {
    ai_budget_today: aiBudgetToday,
    checks: { ai_budget_today: checks.ai_budget_today },
  };
}

// ============================================================
// 10. entity_freshness + event_freshness
// ============================================================
export async function checkEntityAndEventFreshness(
  env: Env,
): Promise<{
  entity_freshness: { status: string; detail: string } | { error: string };
  event_freshness: { status: string; detail: string } | { error: string };
  checks: {
    entity_freshness: { status: "ok" | "degraded" | "down" | "unknown"; detail: string };
    event_freshness: { status: "ok" | "degraded" | "down" | "unknown"; detail: string };
  };
}> {
  let entityFreshness: { status: string; detail: string } | { error: string } = { status: "unknown", detail: "" };
  let eventFreshness: { status: string; detail: string } | { error: string } = { status: "unknown", detail: "" };
  const checks: any = {};

  try {
    const { entity_freshness: ef, event_freshness: evf } = await checkEntityCronHealth(env);
    entityFreshness = ef;
    eventFreshness = evf;
    checks.entity_freshness = { status: ef.status, detail: ef.detail };
    checks.event_freshness = { status: evf.status, detail: evf.detail };
  } catch (e: any) {
    entityFreshness = { error: e?.message || "entity freshness check failed" };
    eventFreshness = { error: e?.message || "event freshness check failed" };
    checks.entity_freshness = { status: "unknown", detail: e?.message };
    checks.event_freshness = { status: "unknown", detail: e?.message };
  }

  return {
    entity_freshness: entityFreshness,
    event_freshness: eventFreshness,
    checks: {
      entity_freshness: checks.entity_freshness,
      event_freshness: checks.event_freshness,
    },
  };
}

// ============================================================
// 11. cache_metrics — pull KV 缓存 hit rate
// ============================================================
export function checkCacheMetrics(): {
  cache_metrics: {
    hits: number;
    misses: number;
    stores: number;
    store_failures: number;
    total_requests: number;
    hit_rate: number;
  } | { error: string };
  checks: {
    cache_metrics: { status: "ok" | "degraded" | "unknown"; detail: string };
  };
} {
  let cacheMetrics: {
    hits: number;
    misses: number;
    stores: number;
    store_failures: number;
    total_requests: number;
    hit_rate: number;
  } | { error: string } = { hits: 0, misses: 0, stores: 0, store_failures: 0, total_requests: 0, hit_rate: 0 };
  const checks: any = {};

  try {
    const m = getCacheMetrics();
    cacheMetrics = {
      hits: m.hits,
      misses: m.misses,
      stores: m.stores,
      store_failures: m.store_failures,
      total_requests: m.total_requests,
      hit_rate: Number(m.hit_rate.toFixed(4)),
    };
    if (m.total_requests === 0) {
      checks.cache_metrics = {
        status: "unknown",
        detail: "no cache requests yet (cold start or no pull traffic this isolate)",
      };
    } else if (m.hit_rate >= 0.5) {
      checks.cache_metrics = {
        status: "ok",
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests)`,
      };
    } else {
      checks.cache_metrics = {
        status: "degraded",
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests, < 50%)`,
      };
    }
  } catch (e: any) {
    cacheMetrics = { error: e?.message || "cache metrics read failed" };
    checks.cache_metrics = { status: "unknown", detail: e?.message };
  }

  return {
    cache_metrics: cacheMetrics,
    checks: { cache_metrics: checks.cache_metrics },
  };
}
