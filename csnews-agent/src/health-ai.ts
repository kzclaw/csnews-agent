// ============================================================
// AI resource health checks
// ============================================================

import { Env } from './shared';
import { getBudgetStatus } from './ai-budget';

// Map CF Workers AI model names → L1-L6 tier levels
function modelToLevel(model: string): string {
  if (model === '@cf/meta/llama-3.1-8b-instruct-fp8') return 'L6';
  if (model === '@cf/baai/bge-m3') return 'L3';
  return 'L1'; // unknown/default
}

// ============================================================
// 1. ai_budget_today
// ============================================================
export async function checkAiBudget(env: Env): Promise<{
  ai_budget_today:
    | { used: number; tier: string; remaining: number; daily_limit: number }
    | { error: string };
  checks: {
    ai_budget_today: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  };
}> {
  let aiBudgetToday:
    | { used: number; tier: string; remaining: number; daily_limit: number }
    | { error: string } = {
    used: 0,
    tier: 'ok',
    remaining: 0,
    daily_limit: 10000,
  };
  const checks: any = {};

  try {
    const budget = await getBudgetStatus(env);
    const tierName = budget.status === 'normal' ? 'ok' : budget.status;
    aiBudgetToday = {
      used: budget.used,
      tier: tierName,
      remaining: budget.remaining,
      daily_limit: budget.limit,
    };
    checks.ai_budget_today = {
      status:
        budget.status === 'shutdown' ? 'down' : budget.status === 'critical' ? 'degraded' : 'ok',
      detail: `daily used: ${budget.used} / ${budget.limit} (${budget.status})`,
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
        const record = JSON.parse(raw) as {
          total: number;
          calls: Array<{ model: string; neurons: number }>;
        };
        totalNeurons = record.total ?? 0;
        for (const call of record.calls ?? []) {
          const model = call.model || 'unknown';
          // Aggregate by L1-L6 tier levels
          const level = modelToLevel(model);
          breakdown[level] = (breakdown[level] || 0) + 1;
          callCount++;
        }
      } catch {
        // parse failed, return empty breakdown
      }
    }

    const levels = Object.keys(breakdown);
    checks.ai_calls_breakdown = {
      status: 'ok',
      detail:
        levels.length > 0
          ? `${callCount} calls across ${levels.length} level(s): ${levels.join(', ')}`
          : 'no AI calls recorded today',
    };

    const budget = await getBudgetStatus(env);
    const statusName = budget.status === 'normal' ? 'ok' : budget.status;

    return {
      ai_calls_breakdown: breakdown,
      neurons_used_today: totalNeurons,
      ai_budget_status: statusName,
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
