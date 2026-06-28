// ============================================================
// AI usage aggregation endpoint handler
// ============================================================
// ?action=ai-usage — reads AI_USAGE_KV and returns 7-day aggregated
// usage broken down by date, model, and L1-L6 category.
// ============================================================

import { Env, jsonResponse } from './shared';

// Map CF Workers AI model names → L1-L6 tier levels
function modelToLevel(model: string): string {
  if (model === '@cf/meta/llama-3-8b-instruct') return 'L6';
  if (model === '@cf/baai/bge-m3') return 'L3';
  return 'L1'; // unknown/default
}

export async function handleAiUsageAction(
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (!env.AI_USAGE_KV) {
    return jsonResponse({ error: 'AI_USAGE_KV binding missing' }, cors, { status: 503 });
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
  // L1-L6 category totals
  const levelTotals: Record<string, { calls: number; neurons: number }> = {};

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
          const level = modelToLevel(model);

          // by model
          if (!aggregated[date][model]) aggregated[date][model] = { calls: 0, neurons: 0 };
          aggregated[date][model].calls++;
          aggregated[date][model].neurons += call.neurons;

          // by L1-L6 level
          if (!levelTotals[level]) levelTotals[level] = { calls: 0, neurons: 0 };
          levelTotals[level].calls++;
          levelTotals[level].neurons += call.neurons;
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

  // Build L1-L6 category summary
  const levels = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const callsByLevel: Record<string, number> = {};
  for (const l of levels) {
    callsByLevel[l] = levelTotals[l]?.calls ?? 0;
  }

  return jsonResponse(
    {
      days: 7,
      entries,
      total_entries: entries.length,
      // L1-L6 category breakdown
      ai_calls_breakdown: callsByLevel,
    },
    cors,
    { status: 200 }
  );
}
