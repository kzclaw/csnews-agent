// ============================================================
// health-checks.ts · v0.36.x
// handleHealthAction 子函数拆分
//
// 每个函数职责单一: 检查一个维度, 返回 result 片段 + check 状态
// ============================================================

import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { countAnomalySignals } from './zscore';
import { getBudgetStatus } from './ai-budget';
import { checkEntityCronHealth, supabaseHeaders } from './utils';
import {
  getCacheMetrics,
  CACHE_PREFIX,
  NEG_SENTINEL_PREFIX,
  getSeedMeta,
  countNegativeSentinels,
} from './cache';
import type { TrendSnapshotRow } from './types';

// ============================================================
// 1. last_process_at + cron_health 派生
// ============================================================
export async function checkLastProcessAt(
  env: Env,
  ts: number
): Promise<{
  last_process_at: string | null | { error: string };
  cron_health: 'ok' | 'degraded' | 'down';
  checks: {
    last_process_at: { status: 'ok' | 'degraded' | 'down'; detail: string };
    cron_health: { status: 'ok' | 'degraded' | 'down'; detail: string };
  };
}> {
  const checks: any = {};
  let lastProcessAt: string | null | { error: string } = null;

  // last_process_at — 支持 SeedEnvelope 和旧版裸字符串
  try {
    if (env.PROCESS_STATE) {
      const raw = await env.PROCESS_STATE.get('last_process_at');
      if (!raw) {
        lastProcessAt = null;
        checks.last_process_at = { status: 'degraded', detail: 'KV empty' };
      } else {
        // 尝试解析 SeedEnvelope
        try {
          const parsed = JSON.parse(raw);
          const seed = getSeedMeta(parsed);
          if (seed && seed.state !== 'error') {
            // SeedEnvelope 格式: 从 data.last_process_at 取时间戳
            const inner = parsed.data as { last_process_at?: string } | undefined;
            lastProcessAt = inner?.last_process_at ?? null;
            checks.last_process_at = {
              status: 'ok',
              detail: `envelope: state=${seed.state} age=${Math.round((ts - Date.parse(seed.fetchedAt)) / 60000)}min`,
            };
          } else {
            // 旧版裸字符串
            lastProcessAt = raw;
            checks.last_process_at = { status: 'ok', detail: raw };
          }
        } catch {
          // JSON parse 失败, 当作旧版裸字符串
          lastProcessAt = raw;
          checks.last_process_at = { status: 'ok', detail: raw };
        }
      }
    } else {
      lastProcessAt = null;
      checks.last_process_at = { status: 'down', detail: 'PROCESS_STATE KV binding missing' };
    }
  } catch (e: any) {
    lastProcessAt = { error: e?.message || 'kv unavailable' };
    checks.last_process_at = { status: 'down', detail: e?.message };
  }

  // cron_health (派生) — 优先用 SeedEnvelope.fetchedAt
  let cronHealth: 'ok' | 'degraded' | 'down' = 'ok';
  if (typeof lastProcessAt === 'string') {
    const lastMs = Date.parse(lastProcessAt);
    if (Number.isFinite(lastMs)) {
      const ageMs = ts - lastMs;
      if (ageMs > 3 * 3600_000) cronHealth = 'down';
      else if (ageMs > 1.5 * 3600_000) cronHealth = 'degraded';
    }
  } else if (checks.last_process_at.status === 'down') {
    cronHealth = 'down';
  } else {
    cronHealth = 'degraded';
  }

  checks.cron_health = {
    status: cronHealth,
    detail:
      typeof lastProcessAt === 'string'
        ? `${Math.round((ts - Date.parse(lastProcessAt)) / 60000)} min ago`
        : 'no last_process_at recorded',
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
export function checkSecretResolved(env: Env): {
  checks: {
    secret_resolved: { status: 'ok' | 'down'; detail: string };
  };
} {
  const selfUrl = env.WORKER_SELF_URL || '';
  const isPlaceholder =
    selfUrl === 'DO_NOT_USE' ||
    selfUrl === 'https://YOUR-WORKER.workers.dev' ||
    selfUrl.includes('YOUR-WORKER') ||
    selfUrl === '';

  return {
    checks: {
      secret_resolved: {
        status: isPlaceholder ? 'down' : 'ok',
        detail: isPlaceholder ? `placeholder: "${selfUrl}"` : 'set to non-placeholder URL',
      },
    },
  };
}

// ============================================================
// 3. supabase_counts + supabase_reachable — 6 表并行计数
// ============================================================
export async function checkSupabaseCounts(env: Env): Promise<{
  supabase_counts: Record<string, number | { error: string }>;
  checks: {
    supabase_reachable: { status: 'ok' | 'degraded' | 'down'; detail: string };
  };
}> {
  const supabaseTables: { name: string; column: string }[] = [
    { name: 'news_hotspots', column: 'id' },
    { name: 'topics', column: 'id' },
    { name: 'news_topic_members', column: 'news_id' },
    { name: 'trend_snapshots', column: 'id' },
    { name: 'warnings', column: 'id' },
    { name: 'fission_searches', column: 'id' },
  ];

  const supabaseCounts: Record<string, number | { error: string }> = {};
  const supabaseResults = await Promise.allSettled(
    supabaseTables.map(async (tbl) => {
      const r = await fetch(
        `${getSupabaseHost(env)}/rest/v1/${tbl.name}?select=${tbl.column}&limit=0`,
        {
          headers: {
            ...supabaseHeaders(env),
            Prefer: 'count=exact',
          },
        }
      );
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`${tbl.name}: HTTP ${r.status} ${errText.slice(0, 200)}`);
      }
      const cr = r.headers.get('Content-Range') || '';
      const total = cr.split('/').pop();
      return { name: tbl.name, total: total && total !== '*' ? parseInt(total, 10) : 0 };
    })
  );

  let supabaseOkCount = 0;
  for (let i = 0; i < supabaseResults.length; i++) {
    const r = supabaseResults[i];
    const tblName = supabaseTables[i].name;
    if (r.status === 'fulfilled') {
      supabaseCounts[tblName] = r.value.total;
      supabaseOkCount++;
    } else {
      supabaseCounts[tblName] = { error: r.reason?.message || 'fetch failed' };
    }
  }

  return {
    supabase_counts: supabaseCounts,
    checks: {
      supabase_reachable: {
        status:
          supabaseOkCount === supabaseTables.length
            ? 'ok'
            : supabaseOkCount === 0
              ? 'down'
              : 'degraded',
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
  ts: number
): Promise<{
  r2_latest_write:
    | { key: string; uploaded: string | null; source: string }
    | null
    | { error: string };
  checks: {
    r2_latest_write: { status: 'ok'; detail: string };
  };
}> {
  const checks: any = {};
  let r2LatestWrite:
    | { key: string; uploaded: string | null; source: string }
    | null
    | { error: string } = null;

  try {
    const list = await env.csnews_raw.list({ prefix: 'news/zaker/', limit: 1000 });
    if (list.objects && list.objects.length > 0) {
      const sorted = [...list.objects].sort((a, b) => b.key.localeCompare(a.key));
      const latestObj = sorted[0];
      let lastWriteTs: number | null = null;
      let lastWriteSource: 'r2_uploaded' | 'content_created_at' = 'r2_uploaded';
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
              lastWriteSource = 'content_created_at';
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
      r2LatestWrite = {
        key: latestObj.key,
        uploaded: latestObj.uploaded ? latestObj.uploaded.toISOString() : null,
        source: lastWriteSource,
      };
      const ageLabel = lastWriteTs
        ? `historical: last R2 news/zaker/ write ${Math.round((ts - lastWriteTs) / 3600_000)}h ago (process no longer writes R2 news/zaker/, see r2_latest_supabase_write for current process status)`
        : 'no uploaded or content.created_at (historical data)';
      checks.r2_latest_write = { status: 'ok', detail: ageLabel };
    } else {
      r2LatestWrite = null;
      checks.r2_latest_write = {
        status: 'ok',
        detail: 'no objects in news/zaker/ (historical prefix, informational only)',
      };
    }
  } catch (e: any) {
    r2LatestWrite = { error: e?.message || 'r2 unavailable' };
    checks.r2_latest_write = {
      status: 'ok',
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
  ts: number
): Promise<{
  r2_latest_supabase_write: { last_write: string; source: string } | null | { error: string };
  checks: {
    r2_latest_supabase_write: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  let r2LatestSupabaseWrite: { last_write: string; source: string } | null | { error: string } =
    null;
  const checks: any = {};

  try {
    const res = await fetch(
      `${getSupabaseHost(env)}/rest/v1/news_hotspots?select=created_at&order=created_at.desc&limit=1`,
      {
        headers: supabaseHeaders(env),
      }
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
        r2LatestSupabaseWrite = { last_write: arr[0].created_at, source: 'supabase_news_hotspots' };
        if (ageMs < 1.5 * 3600_000) {
          checks.r2_latest_supabase_write = {
            status: 'ok',
            detail: `last news_hotspots write ${Math.round(ageMs / 60000)} min ago`,
          };
        } else if (ageMs < 3 * 3600_000) {
          checks.r2_latest_supabase_write = {
            status: 'degraded',
            detail: `last news_hotspots write ${Math.round(ageMs / 60)} min ago (> 1.5h, expected every 1h)`,
          };
        } else {
          checks.r2_latest_supabase_write = {
            status: 'down',
            detail: `last news_hotspots write ${Math.round(ageMs / 3600_000)}h ago (> 3h, process stale)`,
          };
        }
      } else {
        r2LatestSupabaseWrite = { last_write: arr[0].created_at, source: 'supabase_news_hotspots' };
        checks.r2_latest_supabase_write = { status: 'unknown', detail: 'created_at unparseable' };
      }
    } else {
      r2LatestSupabaseWrite = null;
      checks.r2_latest_supabase_write = {
        status: 'down',
        detail: 'news_hotspots table empty (no data ever)',
      };
    }
  } catch (e: any) {
    r2LatestSupabaseWrite = { error: e?.message || 'supabase query failed' };
    checks.r2_latest_supabase_write = { status: 'down', detail: e?.message };
  }

  return {
    r2_latest_supabase_write: r2LatestSupabaseWrite,
    checks: { r2_latest_supabase_write: checks.r2_latest_supabase_write },
  };
}

// ============================================================
// 6. r2_prefix_counts — 各 prefix 行数
// ============================================================
export async function checkR2PrefixCounts(env: Env): Promise<{
  r2_prefix_counts: Record<string, number | { error: string }>;
}> {
  const r2Prefixes = [
    'news/zaker/',
    'news/',
    'embeddings/',
    'fission/',
    'trends/',
    'warnings/',
    'logs/',
  ];
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
    if (r.status === 'fulfilled') {
      r2PrefixCounts[prefix] = r.value.count;
    } else {
      r2PrefixCounts[prefix] = { error: r.reason?.message || 'list failed' };
    }
  }

  return { r2_prefix_counts: r2PrefixCounts };
}

// ============================================================
// 7. cron_history — 本小时 scheduler logs
// ============================================================
export async function checkCronHistory(
  env: Env,
  ts: number
): Promise<{
  cron_history: { this_hour: { hour: string; scheduler_log_count: number } } | { error: string };
  checks: {
    cron_history: { status: 'ok' | 'degraded' | 'unknown'; detail: string };
  };
}> {
  let cronHistory:
    | { this_hour: { hour: string; scheduler_log_count: number } }
    | { error: string } = {
    this_hour: { hour: '', scheduler_log_count: 0 },
  };
  const checks: any = {};

  try {
    const now = new Date(ts);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const list = await env.csnews_raw.list({
      prefix: `logs/${yyyy}-${mm}-${dd}/${hh}/`,
      limit: 100,
    });
    const thisHourSchedulerLogs =
      list.objects?.filter((o) => o.key.includes('-scheduler.log')) || [];
    cronHistory = {
      this_hour: {
        hour: `${yyyy}-${mm}-${dd}T${hh}`,
        scheduler_log_count: thisHourSchedulerLogs.length,
      },
    };
    checks.cron_history = {
      status: thisHourSchedulerLogs.length >= 1 ? 'ok' : 'degraded',
      detail:
        thisHourSchedulerLogs.length >= 1
          ? `${thisHourSchedulerLogs.length} scheduler logs this hour`
          : 'no scheduler logs this hour (cron may not have run)',
    };
  } catch (e: any) {
    cronHistory = { error: e?.message };
    checks.cron_history = { status: 'unknown', detail: e?.message };
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
  ts: number
): Promise<{
  zscore_signals_today:
    | {
        total_7d: number;
        by_field_7d: Record<string, number>;
        snapshots_analyzed: number;
        window: string;
      }
    | { error: string };
  checks: {
    zscore_signals_today: { status: 'ok' | 'unknown'; detail: string };
  };
}> {
  let zscoreSignalsToday:
    | {
        total_7d: number;
        by_field_7d: Record<string, number>;
        snapshots_analyzed: number;
        window: string;
      }
    | { error: string } = {
    total_7d: 0,
    by_field_7d: { score: 0, velocity: 0, acceleration: 0 },
    snapshots_analyzed: 0,
    window: '7d',
  };
  const checks: any = {};

  try {
    const sevenDaysAgo = new Date(ts - 7 * 24 * 3600 * 1000).toISOString();
    const snapshotsRes = await supabaseFetch(
      env,
      `/rest/v1/trend_snapshots?select=id,topic_id,score,velocity,acceleration,created_at&created_at=gte.${sevenDaysAgo}&order=created_at.desc&limit=500`
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
        for (const field of ['score', 'velocity', 'acceleration'] as const) {
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
      window: '7d',
    };
    checks.zscore_signals_today = {
      status: 'ok',
      detail:
        totalAnomalies > 0
          ? `${totalAnomalies} z-score anomalies in last 7d (${JSON.stringify(anomaliesByField)})`
          : `0 anomalies in last 7d (algorithm ready, wakeup review pending)`,
    };
  } catch (e: any) {
    zscoreSignalsToday = { error: e?.message || 'zscore calc failed' };
    checks.zscore_signals_today = { status: 'unknown', detail: e?.message };
  }

  return {
    zscore_signals_today: zscoreSignalsToday,
    checks: { zscore_signals_today: checks.zscore_signals_today },
  };
}

// ============================================================
// 9. ai_budget_today
// ============================================================
export async function checkAiBudget(env: Env): Promise<{
  ai_budget_today:
    | { used: number; tier: string; remaining: number; quota: number }
    | { error: string };
  checks: {
    ai_budget_today: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  let aiBudgetToday:
    | { used: number; tier: string; remaining: number; quota: number }
    | { error: string } = {
    used: 0,
    tier: 'ok',
    remaining: 0,
    quota: 0,
  };
  const checks: any = {};

  try {
    const budget = await getBudgetStatus(env);
    aiBudgetToday = {
      used: budget.used,
      tier: budget.tier,
      remaining: budget.remaining,
      quota: budget.quota,
    };
    checks.ai_budget_today = {
      status: budget.tier === 'shutdown' ? 'down' : budget.tier === 'critical' ? 'degraded' : 'ok',
      detail: `daily used: ${budget.used} / ${budget.quota} (${budget.tier})`,
    };
  } catch (e: any) {
    aiBudgetToday = { error: e?.message || 'ai_budget calc failed' };
    checks.ai_budget_today = { status: 'unknown', detail: e?.message };
  }

  return {
    ai_budget_today: aiBudgetToday,
    checks: { ai_budget_today: checks.ai_budget_today },
  };
}

// ============================================================
// 10. entity_freshness + event_freshness
// ============================================================
export async function checkEntityAndEventFreshness(env: Env): Promise<{
  entity_freshness: { status: string; detail: string } | { error: string };
  event_freshness: { status: string; detail: string } | { error: string };
  checks: {
    entity_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
    event_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  let entityFreshness: { status: string; detail: string } | { error: string } = {
    status: 'unknown',
    detail: '',
  };
  let eventFreshness: { status: string; detail: string } | { error: string } = {
    status: 'unknown',
    detail: '',
  };
  const checks: any = {};

  try {
    const { entity_freshness: ef, event_freshness: evf } = await checkEntityCronHealth(env);
    entityFreshness = ef;
    eventFreshness = evf;
    checks.entity_freshness = { status: ef.status, detail: ef.detail };
    checks.event_freshness = { status: evf.status, detail: evf.detail };
  } catch (e: any) {
    entityFreshness = { error: e?.message || 'entity freshness check failed' };
    eventFreshness = { error: e?.message || 'event freshness check failed' };
    checks.entity_freshness = { status: 'unknown', detail: e?.message };
    checks.event_freshness = { status: 'unknown', detail: e?.message };
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
  cache_metrics:
    | {
        hits: number;
        misses: number;
        stores: number;
        store_failures: number;
        total_requests: number;
        hit_rate: number;
      }
    | { error: string };
  checks: {
    cache_metrics: { status: 'ok' | 'degraded' | 'unknown'; detail: string };
  };
} {
  let cacheMetrics:
    | {
        hits: number;
        misses: number;
        stores: number;
        store_failures: number;
        total_requests: number;
        hit_rate: number;
      }
    | { error: string } = {
    hits: 0,
    misses: 0,
    stores: 0,
    store_failures: 0,
    total_requests: 0,
    hit_rate: 0,
  };
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
        status: 'unknown',
        detail: 'no cache requests yet (cold start or no pull traffic this isolate)',
      };
    } else if (m.hit_rate >= 0.5) {
      checks.cache_metrics = {
        status: 'ok',
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests)`,
      };
    } else {
      checks.cache_metrics = {
        status: 'degraded',
        detail: `hit_rate ${(m.hit_rate * 100).toFixed(1)}% (${m.hits}/${m.total_requests} requests, < 50%)`,
      };
    }
  } catch (e: any) {
    cacheMetrics = { error: e?.message || 'cache metrics read failed' };
    checks.cache_metrics = { status: 'unknown', detail: e?.message };
  }

  return {
    cache_metrics: cacheMetrics,
    checks: { cache_metrics: checks.cache_metrics },
  };
}

// ============================================================
// 12. pull_cache_freshness — 按 news / entity / event / trend / knowledge 分组检查 pull 缓存新鲜度
// 按数据源分组 + per-key 新鲜度
// ============================================================

/** 单个缓存 key 的健康信息 */
export interface CacheKeyHealth {
  key: string;
  recordCount: number;
  maxContentAgeMin: number;
  fetchedAt: string;
  state: 'ok' | 'error' | 'empty';
  /** 根据 maxContentAgeMin 计算的 key 级别状态 */
  keyStatus: 'ok' | 'stale' | 'down';
}

/** 单个分组的健康信息 */
export interface HealthGroup {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  keys: CacheKeyHealth[];
  cascadedFrom?: string; // 上游组名 (cascade 降级时填充)
}

/** 计算单个 key 的状态 */
function calcKeyStatus(maxContentAgeMin: number): 'ok' | 'stale' | 'down' {
  if (maxContentAgeMin < 0) return 'ok'; // 未知, 不降级
  if (maxContentAgeMin > 360) return 'down'; // > 6h = down
  if (maxContentAgeMin > 180) return 'stale'; // > 3h = stale (degraded)
  return 'ok';
}

/** 计算分组的综合状态 (基于所有 keys) */
function calcGroupStatus(keys: CacheKeyHealth[]): 'ok' | 'degraded' | 'down' | 'unknown' {
  if (keys.length === 0) return 'unknown';
  let hasDown = false;
  let hasStale = false;
  for (const k of keys) {
    if (k.keyStatus === 'down') hasDown = true;
    if (k.keyStatus === 'stale') hasStale = true;
  }
  if (hasDown) return 'down';
  if (hasStale) return 'degraded';
  return 'ok';
}

/**
 * 按 type 字段映射到数据源分组
 * - news: news_hotspots 相关缓存
 * - entity: entity 表缓存
 * - event: event 表缓存
 * - trend: trend_snapshots 相关缓存
 * - knowledge: knowledge 累积缓存
 */
function mapTypeToGroup(type: string): string {
  if (type === 'news' || type === 'topics' || type === 'warnings' || type === 'fission-pending') {
    return 'news';
  }
  if (type === 'entity') return 'entity';
  if (type === 'event') return 'event';
  if (type === 'trend') return 'trend';
  if (type === 'knowledge') return 'knowledge';
  return 'unknown';
}

export async function checkPullCacheFreshness(
  env: Env,
  ts: number
): Promise<{
  pull_cache_freshness: {
    groups: Record<string, HealthGroup>;
    /** 全局综合状态 */
    overallStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  };
  checks: {
    pull_cache_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  // 初始化所有组
  const groupKeys: Record<string, CacheKeyHealth[]> = {
    news: [],
    entity: [],
    event: [],
    trend: [],
    knowledge: [],
    unknown: [],
  };

  const checks: any = {};

  try {
    if (!env.PROCESS_STATE) {
      const emptyGroups = Object.fromEntries(
        Object.keys(groupKeys).map((k) => [k, { status: 'down' as const, keys: [] }])
      );
      return {
        pull_cache_freshness: { groups: emptyGroups, overallStatus: 'down' },
        checks: { pull_cache_freshness: { status: 'down', detail: 'PROCESS_STATE KV missing' } },
      };
    }

    // 列出所有 cache:pull:* keys
    const list = await env.PROCESS_STATE.list({ prefix: CACHE_PREFIX + 'pull:' });
    const kvKeys = list.keys || [];

    for (const kvKey of kvKeys) {
      try {
        const raw = await env.PROCESS_STATE.get(kvKey.name);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const seed = getSeedMeta(parsed);
        if (!seed || seed.state === 'error') {
          // 无 seed 元数据, 归入 unknown
          groupKeys.unknown.push({
            key: kvKey.name,
            recordCount: 0,
            maxContentAgeMin: -1,
            fetchedAt: '',
            state: 'error',
            keyStatus: 'ok',
          });
          continue;
        }
        const data = parsed.data as { type?: string } | undefined;
        const type = data?.type ?? 'unknown';
        const groupName = mapTypeToGroup(type);
        const maxContentAgeMin = seed.maxContentAgeMin >= 0 ? seed.maxContentAgeMin : -1;

        groupKeys[groupName].push({
          key: kvKey.name,
          recordCount: seed.recordCount,
          maxContentAgeMin,
          fetchedAt: seed.fetchedAt,
          state: seed.state,
          keyStatus: calcKeyStatus(maxContentAgeMin),
        });
      } catch {
        groupKeys.unknown.push({
          key: kvKey.name,
          recordCount: 0,
          maxContentAgeMin: -1,
          fetchedAt: '',
          state: 'error',
          keyStatus: 'ok',
        });
      }
    }

    // 构建带状态的 groups 对象
    const groups: Record<string, HealthGroup> = {};
    for (const [name, keys] of Object.entries(groupKeys)) {
      groups[name] = {
        status: calcGroupStatus(keys),
        keys,
      };
    }

    // 全局状态 = news 组状态 (核心数据源)
    const overallStatus = groups.news?.status ?? 'unknown';

    const newsCount = groups.news?.keys.length ?? 0;
    const newsMaxAge =
      groups.news?.keys.reduce((max, k) => Math.max(max, k.maxContentAgeMin), -1) ?? -1;
    checks.pull_cache_freshness = {
      status: overallStatus,
      detail:
        newsCount > 0 && newsMaxAge >= 0
          ? `news=${newsCount} entries, oldest content ${newsMaxAge}min old`
          : `${newsCount} entries, maxContentAgeMin unavailable (legacy)`,
    };

    return {
      pull_cache_freshness: { groups, overallStatus },
      checks: { pull_cache_freshness: checks.pull_cache_freshness },
    };
  } catch (e: any) {
    const emptyGroups = Object.fromEntries(
      Object.keys(groupKeys).map((k) => [k, { status: 'unknown' as const, keys: [] }])
    );
    return {
      pull_cache_freshness: { groups: emptyGroups, overallStatus: 'unknown' },
      checks: {
        pull_cache_freshness: { status: 'unknown', detail: `list failed: ${e?.message}` },
      },
    };
  }
}

// ============================================================
// 12b. cascade_dependency_chain — cascade 依赖降级
// ============================================================

/**
 * Cascade 依赖链定义
 * 上游 down → 下游自动降级为 degraded (即使自身 key 正常)
 *
 * 依赖链:
 *   news (core)
 *     ↓
 *   entity (依赖 news)
 *     ↓
 *   event (依赖 entity)
 *
 *   trend (依赖 entity)
 *     ↓
 *   knowledge (依赖 trend)
 */
export const CASCADE_DEPENDENCY_CHAIN: Record<string, string | undefined> = {
  news: undefined, // 顶层, 无上游
  entity: 'news',
  event: 'entity',
  trend: 'entity',
  knowledge: 'trend',
};

/**
 * 应用 cascade 依赖降级
 * - 上游组 down → 下游组降级为 degraded (保留 keys 信息, 标记 cascadedFrom)
 * - 上游组 degraded → 下游组不降级 (只影响自身)
 */
export function applyCascadeDependencies(
  groups: Record<string, HealthGroup>
): Record<string, HealthGroup> {
  const result: Record<string, HealthGroup> = {};

  // 按依赖顺序处理 (news → entity → event/trend → knowledge)
  const order = ['news', 'entity', 'event', 'trend', 'knowledge'];
  const processed = new Set<string>();

  for (const name of order) {
    if (!groups[name]) continue;
    const group = { ...groups[name] };
    const upstream = CASCADE_DEPENDENCY_CHAIN[name];

    if (upstream && groups[upstream] && groups[upstream].status === 'down') {
      // 上游 down, 当前组降级为 degraded
      group.status = 'degraded';
      group.cascadedFrom = upstream;
    }

    result[name] = group;
    processed.add(name);
  }

  // 复制未处理组 (unknown 等)
  for (const [name, group] of Object.entries(groups)) {
    if (!processed.has(name)) {
      result[name] = group;
    }
  }

  return result;
}

/**
 * 计算 cascade 后的全局状态
 * - 任意组 down → 全局 down
 * - 任意组 degraded (包括 cascade 降级) → 全局 degraded
 * - 全部 ok → ok
 */
export function calcOverallStatusWithCascade(
  groups: Record<string, HealthGroup>
): 'ok' | 'degraded' | 'down' {
  let hasDown = false;
  let hasDegraded = false;

  for (const group of Object.values(groups)) {
    if (group.status === 'down') hasDown = true;
    if (group.status === 'degraded') hasDegraded = true;
  }

  if (hasDown) return 'down';
  if (hasDegraded) return 'degraded';
  return 'ok';
}

// ============================================================
// 13. neg_sentinel_count — 当前生效的 Negative Sentinel 数量
// ============================================================
export async function checkNegativeSentinel(env: Env): Promise<{
  neg_sentinel_count: number;
  checks: {
    neg_sentinel: { status: 'ok' | 'degraded'; detail: string };
  };
}> {
  const count = await countNegativeSentinels(env);
  return {
    neg_sentinel_count: count,
    checks: {
      neg_sentinel: {
        status: count === 0 ? 'ok' : 'degraded',
        detail:
          count === 0
            ? 'no active sentinels (upstream healthy)'
            : `${count} sentinel${count > 1 ? 's' : ''} active (${count} endpoint${count > 1 ? 's' : ''} skipping upstream)`,
      },
    },
  };
}
