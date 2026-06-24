// ============================================================
// R2 storage health checks
// ============================================================

import { Env } from './shared';

// ============================================================
// 1. r2_latest_write — news/zaker/ latest write (informational)
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
