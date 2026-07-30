// ============================================================
// R2 log retrieval endpoint handler
// ============================================================
// ?action=logs&date=YYYY-MM-DD&hour=HH&limit=N
// Reads .log files under logs/<date>/ in the csnews_raw R2 bucket,
// parses JSON lines, and returns newest-first with optional hour filter.
// ============================================================

import { Env, jsonResponse } from './shared';

export async function handleLogsAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const params = url.searchParams;
  const now = new Date();
  const todayUtc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  // ---- date validation ----
  const rawDate = params.get('date') || 'today';
  let date: string;
  if (rawDate === 'today') {
    date = todayUtc;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    date = rawDate;
  } else {
    return jsonResponse({ error: "date must be YYYY-MM-DD or 'today'" }, cors, { status: 400 });
  }

  // ---- hour validation ----
  const hourParam = params.get('hour');
  let hour: number | null = null;
  if (hourParam !== null) {
    hour = parseInt(hourParam, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return jsonResponse({ error: 'hour must be 0-23' }, cors, { status: 400 });
    }
  }

  // ---- limit clamp ----
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '100', 10), 1), 500);

  // ---- date range guard: max 7 days back ----
  const requestedDate = new Date(date + 'T00:00:00Z');
  const todayDate = new Date(todayUtc + 'T00:00:00Z');
  const diffDays = (todayDate.getTime() - requestedDate.getTime()) / 86400_000;
  if (diffDays > 7 || diffDays < 0) {
    return jsonResponse({ error: 'date range max 7 days (0-7 days back)' }, cors, { status: 400 });
  }

  // ---- fetch and parse R2 log files ----
  let entries: any[] = [];
  try {
    const prefix = `logs/${date}/`;
        // cap list at 50 to stay under CF Free Plan 50 subrequest/request budget
    // (each obj below also calls .get(), so 50 list items = up to 51 subrequests per request)
    // dashboard ?action=logs&date=today 真 是 在 738 log objects 上 hang
    // (list 1000 + per-obj get > 50 subrequest limit → 'Too many subrequests' → server timeout / hang)
    // 50 list items × 1 get each = 51 subrequest, 紧 在 budget 上, 经 测 试 可 跑 通
    const list = await env.csnews_raw.list({ prefix, limit: 50 });

    for (const obj of list.objects) {
      // Filter by hour when specified
      if (/^\d{2}\.log$/.test(obj.key.split('/').pop() || '')) {
        if (hour !== null && !obj.key.endsWith(`/${String(hour).padStart(2, '0')}.log`)) continue;
      } else {
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
          /* skip corrupted lines */
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: 'r2 unavailable', detail: msg }, cors, {
      status: 503,
    });
  }

  entries.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const items = entries.slice(0, limit);
  const truncated = entries.length > items.length;

  return jsonResponse(
    { date, hour, count: items.length, total: entries.length, truncated, items },
    cors
  );
}
