// ============================================================
// AI resource health checks
// ============================================================

import { Env } from './shared';
import { getBudgetStatus } from './ai-budget';

// ============================================================
// 1. ai_budget_today
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
// 2. ai_calls_breakdown — daily AI call count by model
// ============================================================
export async function checkAiCallsBreakdown(env: Env): Promise<{
  ai_calls_breakdown: Record<string, number>;
  neurons_used_today: number;
  ai_budget_status: string;
  checks: {
    ai_calls_breakdown: { status: 'ok' | 'unknown'; detail: string };
  };
}> {
  const checks: any = {};
  const breakdown: Record<string, number> = {};

  try {
    if (!env.AI_USAGE_KV) {
      checks.ai_calls_breakdown = { status: 'unknown', detail: 'AI_USAGE_KV binding missing' };
      return {
        ai_calls_breakdown: {},
        neurons_used_today: 0,
        ai_budget_status: 'unknown',
        checks: { ai_calls_breakdown: checks.ai_calls_breakdown },
      };
    }

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const todayKey = `usage/${y}-${m}-${d}`;

    const raw = await env.AI_USAGE_KV.get(todayKey);
    let totalNeurons = 0;
    let callCount = 0;

    if (raw) {
      try {
        const record = JSON.parse(raw) as { total: number; calls: Array<{ model: string; neurons: number }> };
        totalNeurons = record.total ?? 0;
        for (const call of record.calls ?? []) {
          const model = call.model || 'unknown';
          breakdown[model] = (breakdown[model] || 0) + 1;
          callCount++;
        }
      } catch {
        // parse failed, return empty breakdown
      }
    }

    const models = Object.keys(breakdown);
    checks.ai_calls_breakdown = {
      status: 'ok',
      detail:
        models.length > 0
          ? `${callCount} calls across ${models.length} model(s): ${models.join(', ')}`
          : 'no AI calls recorded today',
    };

    const budget = await getBudgetStatus(env);

    return {
      ai_calls_breakdown: breakdown,
      neurons_used_today: totalNeurons,
      ai_budget_status: budget.tier,
      checks: { ai_calls_breakdown: checks.ai_calls_breakdown },
    };
  } catch (e: any) {
    checks.ai_calls_breakdown = { status: 'unknown', detail: e?.message };
    return {
      ai_calls_breakdown: {},
      neurons_used_today: 0,
      ai_budget_status: 'unknown',
      checks: { ai_calls_breakdown: checks.ai_calls_breakdown },
    };
  }
}
