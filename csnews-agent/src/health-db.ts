// ============================================================
// Database health checks
// ============================================================
// v0.37.16 (board decision): Supabase is the primary store. The historical
// field name `r2_latest_supabase_write` is kept for backward compatibility,
// but the canonical name is now `supabase_latest_write`. Dashboard + scripts
// should read `supabase_latest_write` going forward.

import { Env, getSupabaseHost, supabaseFetch, safeJson } from './shared';
import { checkEntityCronHealth, supabaseHeaders } from './utils';
import type { TrendSnapshotRow } from './types';

// ============================================================
// data_store_architecture — explains which store is primary vs cold archive
// ============================================================
// Surfaced as a top-level field in the health response so consumers don't
// have to reverse-engineer the storage layout from field names.
export const DATA_STORE_ARCHITECTURE = {
  primary_store: 'supabase' as const,
  primary_store_health_field: 'supabase_latest_write' as const,
  cold_archive: 'r2' as const,
  cold_archive_health_field: 'r2_latest_write' as const,
  primary_store_table: 'news_hotspots' as const,
  cold_archive_prefix: 'news/zaker/' as const,
  cold_archive_write_rule:
    'R2 news/zaker/ is only written when a news item is a new angle (embedding similarity < 0.95). Same-topic duplicates and lightweight items skip R2 by design.' as const,
  explanation:
    'Process writes primary data to Supabase (news_hotspots table). R2 stores historical snapshots of new angles only. 14 days of no new R2 writes is NORMAL when news is dominated by repeats — not a sign of a broken pipeline.' as const,
} as const;

// ============================================================
// 1. supabase_counts + supabase_reachable — 6 table parallel count
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
// 2. supabase_latest_write (alias: r2_latest_supabase_write)
//    — latest news_hotspots write (real process state, PRIMARY store)
// ============================================================
// v0.37.16: field renamed for clarity. Supabase is the primary store; the
// historical `r2_latest_supabase_write` field is preserved as an alias so
// existing consumers keep working. New `supabase_latest_write` field is the
// canonical one going forward. Both point at the same object.
export async function checkR2LatestSupabaseWrite(
  env: Env,
  ts: number
): Promise<{
  r2_latest_supabase_write:
    | { last_write: string; source: string; role: 'primary_store' }
    | { last_write: string; source: string; role: 'primary_store' }
    | { error: string };
  supabase_latest_write: any; // alias
  checks: {
    r2_latest_supabase_write: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
    supabase_latest_write: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  let r2LatestSupabaseWrite:
    | { last_write: string; source: string; role: 'primary_store' }
    | { error: string } = null as any;
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
        r2LatestSupabaseWrite = {
          last_write: arr[0].created_at,
          source: 'supabase_news_hotspots',
          role: 'primary_store' as const,
        };
        let status: 'ok' | 'degraded' | 'down';
        let detail: string;
        if (ageMs < 1.5 * 3600_000) {
          status = 'ok';
          detail = `last news_hotspots write ${Math.round(ageMs / 60000)} min ago · primary store (Supabase) is active`;
        } else if (ageMs < 3 * 3600_000) {
          status = 'degraded';
          detail = `last news_hotspots write ${Math.round(ageMs / 60000)} min ago (> 1.5h, expected every 1h) · primary store getting stale`;
        } else {
          status = 'down';
          detail = `last news_hotspots write ${Math.round(ageMs / 3600_000)}h ago (> 3h, process stale) · primary store NOT being written`;
        }
        checks.r2_latest_supabase_write = { status, detail };
        checks.supabase_latest_write = { status, detail };
      } else {
        r2LatestSupabaseWrite = {
          last_write: arr[0].created_at,
          source: 'supabase_news_hotspots',
          role: 'primary_store' as const,
        };
        checks.r2_latest_supabase_write = { status: 'unknown', detail: 'created_at unparseable' };
        checks.supabase_latest_write = { status: 'unknown', detail: 'created_at unparseable' };
      }
    } else {
      r2LatestSupabaseWrite = null as any;
      checks.r2_latest_supabase_write = {
        status: 'down',
        detail: 'news_hotspots table empty (no data ever) · primary store has nothing',
      };
      checks.supabase_latest_write = checks.r2_latest_supabase_write;
    }
  } catch (e: any) {
    r2LatestSupabaseWrite = { error: e?.message || 'supabase query failed' };
    checks.r2_latest_supabase_write = { status: 'down', detail: e?.message };
    checks.supabase_latest_write = checks.r2_latest_supabase_write;
  }

  return {
    r2_latest_supabase_write: r2LatestSupabaseWrite,
    supabase_latest_write: r2LatestSupabaseWrite, // alias
    checks: {
      r2_latest_supabase_write: checks.r2_latest_supabase_write,
      supabase_latest_write: checks.supabase_latest_write,
    },
  };
}

// ============================================================
// 3. entity_freshness + event_freshness
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
// 4. zscore_signals_today — 7d z-score anomaly count
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
    const { countAnomalySignals } = await import('./zscore');
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
