// ============================================================
// R2 storage health checks
// ============================================================
// v0.37.16 (board decision): R2 is a cold archive (not the primary store).
//  - Process writes primary data to Supabase (news_hotspots table).
//  - R2 only stores new-angle snapshots (similarity < 0.95) by design.
//  - 14 days of no new R2 writes is NORMAL when the news cycle is dominated
//    by same-topic duplicates, NOT a sign of a broken pipeline.
//  - The health endpoint now reports R2 as a `cold_archive` with status `info`
//    (not `ok` and not `down`) and points consumers to `supabase_latest_write`
//    for the real process health signal.

import { Env } from './shared';

type CheckEntry = { status: 'ok' | 'info' | 'down'; detail: string };

// ============================================================
// 1. r2_latest_write — news/zaker/ latest write (informational / cold archive)
// ============================================================
// Backward-compatible response: `r2_latest_write` keeps its old shape so
// existing consumers (dashboard viewer, downstream callers) don't break.
// New fields added:
//   - r2_role: 'cold_archive' (was implicit before; now explicit)
//   - cold_archive_age_hours: number | null
//   - cold_archive_status_explanation: string (one-line "why is this ok / info")
//   - primary_store_field: 'supabase_latest_write' (route readers to truth)
// Alias: r2_cold_archive_latest_write points at the same object.
// ============================================================
export async function checkR2LatestWrite(
  env: Env,
  ts: number
): Promise<{
  r2_latest_write:
    | {
        key: string;
        uploaded: string | null;
        source: string;
        r2_role: 'cold_archive';
        cold_archive_age_hours: number | null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | {
        r2_role: 'cold_archive';
        empty: true;
        cold_archive_age_hours: null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | { error: string; r2_role: 'cold_archive'; cold_archive_age_hours: null };
  r2_cold_archive_latest_write:
    | {
        key: string;
        uploaded: string | null;
        source: string;
        r2_role: 'cold_archive';
        cold_archive_age_hours: number | null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | {
        r2_role: 'cold_archive';
        empty: true;
        cold_archive_age_hours: null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | { error: string; r2_role: 'cold_archive'; cold_archive_age_hours: null }; // alias
  checks: {
    r2_latest_write: CheckEntry;
  };
}> {
  const checks: Record<string, CheckEntry> = {};
  type R2LatestWriteResult =
    | {
        key: string;
        uploaded: string | null;
        source: string;
        r2_role: 'cold_archive';
        cold_archive_age_hours: number | null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | {
        r2_role: 'cold_archive';
        empty: true;
        cold_archive_age_hours: null;
        cold_archive_status_explanation: string;
        primary_store_field: 'supabase_latest_write';
      }
    | { error: string; r2_role: 'cold_archive'; cold_archive_age_hours: null };
  let r2LatestWrite: R2LatestWriteResult | null = null;
  let ageHours: number | null = null;

  // Compute the one-line explanation based on the R2 age, so consumers
  // (dashboard, scripts, future alerts) can show a clear, human-readable
  // message instead of a raw timestamp.
  const explain = (h: number | null): string => {
    if (h === null) {
      return 'R2 cold archive · no objects in news/zaker/ yet. Primary store is Supabase (see supabase_latest_write).';
    }
    if (h < 24) {
      return `R2 cold archive · last write ${h}h ago (active). Primary store: Supabase.`;
    }
    if (h < 24 * 7) {
      return `R2 cold archive · last write ${h}h ago. Process only writes R2 for new angles (similarity < 0.95); repeats and lightweight items skip R2 by design. Primary store (Supabase) is the truth — see supabase_latest_write.`;
    }
    const days = Math.round(h / 24);
    return `R2 cold archive · last write ${days}d ago. Same design rule: 0 new-angle writes because news cycle has been repeats. This is normal, not broken. Primary store (Supabase) is the truth — see supabase_latest_write.`;
  };

  // Map R2 age → status (cold archive never escalates above 'info')
  const statusFor = (h: number | null): 'ok' | 'info' | 'down' => {
    if (h === null) return 'info'; // empty archive is not "down"
    if (h < 24) return 'ok';
    return 'info'; // cold archive is never "down" for being quiet
  };

  // v0.37.78: Phase 1 — read latest R2 write from PROCESS_STATE KV
  // (populated by saveToR2 on each successful R2 put). O(1), no pagination,
  // avoids the false alarm when news/zaker/ has 1000+ objects.
  try {
    if (env.PROCESS_STATE) {
      const raw = await env.PROCESS_STATE.get('r2_latest_write');
      if (raw) {
        const p = JSON.parse(raw);
        if (p?.key && p?.ts) {
          const writeTs = Date.parse(p.ts);
          if (!isNaN(writeTs)) {
            ageHours = Math.round((ts - writeTs) / 3600_000);
            r2LatestWrite = {
              key: p.key,
              uploaded: p.ts,
              source: 'process_state_kv',
              r2_role: 'cold_archive' as const,
              cold_archive_age_hours: ageHours,
              cold_archive_status_explanation: explain(ageHours),
              primary_store_field: 'supabase_latest_write' as const,
            };
            checks.r2_latest_write = {
              status: statusFor(ageHours),
              detail:
                ageHours !== null
                  ? `cold_archive · ${ageHours}h since last write (KV) · ${explain(ageHours)}`
                  : `cold_archive · historical (KV) · ${explain(null)}`,
            };
            return {
              r2_latest_write: r2LatestWrite,
              r2_cold_archive_latest_write: r2LatestWrite,
              checks: { r2_latest_write: checks.r2_latest_write },
            };
          }
        }
      }
    }
  } catch {
    // KV read failed — fall through to R2 list (Phase 2)
  }

  // Phase 2: Fallback — R2 list (bootstrapping when KV is cold / fresh deploy)
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
      if (lastWriteTs) {
        ageHours = Math.round((ts - lastWriteTs) / 3600_000);
      }
      r2LatestWrite = {
        key: latestObj.key,
        uploaded: latestObj.uploaded ? latestObj.uploaded.toISOString() : null,
        source: lastWriteSource,
        r2_role: 'cold_archive' as const,
        cold_archive_age_hours: ageHours,
        cold_archive_status_explanation: explain(ageHours),
        primary_store_field: 'supabase_latest_write' as const,
      };
      const ageLabel =
        ageHours !== null
          ? `cold_archive · ${ageHours}h since last new-angle write · ${explain(ageHours)}`
          : `cold_archive · historical (no parsed timestamp) · ${explain(null)}`;
      checks.r2_latest_write = { status: statusFor(ageHours), detail: ageLabel };
    } else {
      r2LatestWrite = {
        r2_role: 'cold_archive' as const,
        empty: true,
        cold_archive_age_hours: null,
        cold_archive_status_explanation: explain(null),
        primary_store_field: 'supabase_latest_write' as const,
      };
      checks.r2_latest_write = {
        status: 'info',
        detail: explain(null),
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    r2LatestWrite = {
      error: msg || 'r2 unavailable',
      r2_role: 'cold_archive' as const,
      cold_archive_age_hours: null,
    };
    // R2 list failure: still 'info' (cold archive, doesn't block process)
    checks.r2_latest_write = {
      status: 'info',
      detail: `r2 list failed: ${msg} · cold archive, does not block process. Primary store: Supabase (see supabase_latest_write).`,
    };
  }

  return {
    r2_latest_write: r2LatestWrite,
    r2_cold_archive_latest_write: r2LatestWrite, // alias
    checks: { r2_latest_write: checks.r2_latest_write },
  };
}

// ============================================================
// 2. r2_prefix_counts — object counts per prefix
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
