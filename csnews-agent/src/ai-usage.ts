// ============================================================
// AI usage aggregation endpoint handler
// ============================================================
// ?action=ai-usage — reads AI_USAGE_KV and returns 7-day aggregated
// usage broken down by date and model.
// ============================================================

import { Env } from './shared';

export async function handleAiUsageAction(env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.AI_USAGE_KV) {
    return new Response(JSON.stringify({ error: 'AI_USAGE_KV binding missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // ---- build last-7-days date list ----
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    );
  }

  const kvResults = await Promise.allSettled(
    dates.map((date) => env.AI_USAGE_KV!.get(`usage/${date}`))
  );

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
          if (!aggregated[date][model]) aggregated[date][model] = { calls: 0, neurons: 0 };
          aggregated[date][model].calls++;
          aggregated[date][model].neurons += call.neurons;
        }
      } catch {
        /* parse failed — skip */
      }
    }
  }

  type UsageEntry = { date: string; model: string; calls: number; neurons: number };
  const entries: UsageEntry[] = [];
  for (const [date, models] of Object.entries(aggregated)) {
    for (const [model, agg] of Object.entries(models)) {
      entries.push({ date, model, calls: agg.calls, neurons: agg.neurons });
    }
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  return new Response(
    JSON.stringify({ days: 7, entries, total_entries: entries.length }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}
