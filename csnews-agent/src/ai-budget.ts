/**
 * CSNEWS Agent · AI 预算追踪 (v0.36.9 · KR0+1)
 *
 * 蓝图 2.9: if ai_budget < threshold: only_process(L4, L5)
 *          threshold = 7K (70% 触发降级)
 *
 * 4 档阈值:
 *   - normal:    neurons_used < 5K  → 全部 L1-L6 开启
 *   - warning:   5K ≤ n < 7K     → L4-L6 受控
 *   - critical:  7K ≤ n < 8K    → 仅 L4-L5
 *   - shutdown:  n ≥ 8K          → 跳过所有 AI 调用
 *
 * 用 existing PROCESS_STATE KV，不新建 namespace。
 *
 * 详见：tasks/csnews-agent-okr.md KR0+1
 */
import type { Env } from './shared';

// ============================================================
// 常量
// ============================================================

export const BUDGET_TIERS = {
  NORMAL: 5_000,
  WARNING: 7_000,
  CRITICAL: 8_000,
} as const;

export type BudgetTier = 'normal' | 'warning' | 'critical' | 'shutdown';

// ============================================================
// Key helpers
// ============================================================

function todayKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `ai_daily_${y}${m}${day}`;
}

function yesterdayKey(): string {
  const d = new Date(Date.now() - 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `ai_daily_${y}${m}${day}`;
}

// ============================================================
// Core functions
// ============================================================

/**
 * 获取今日已用 Neurons（从 PROCESS_STATE KV）
 */
export async function getDailyUsage(env: Env): Promise<number> {
  try {
    if (!env.PROCESS_STATE) return 0;
    const val = await env.PROCESS_STATE.get(todayKey());
    if (!val) return 0;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

/**
 * 记录一次 Neurons 消耗（增量写入 PROCESS_STATE KV）
 */
export async function recordUsage(env: Env, neurons: number): Promise<void> {
  try {
    if (!env.PROCESS_STATE) return;
    const current = await getDailyUsage(env);
    await env.PROCESS_STATE.put(todayKey(), String(current + neurons), {
      expirationTtl: 172_800, // 48h TTL，跨天后旧 key 自动过期
    });
  } catch {
    // KV 写入失败不影响主流程，静默
  }
}

/**
 * 清理昨日 key（跨天后调用一次即可）
 */
export async function cleanupYesterday(env: Env): Promise<void> {
  try {
    if (!env.PROCESS_STATE) return;
    await env.PROCESS_STATE.delete(yesterdayKey());
  } catch {
    // ignore
  }
}

/**
 * 获取当前预算状态
 */
export async function getBudgetStatus(env: Env): Promise<{
  used: number;
  tier: BudgetTier;
  remaining: number;
  quota: number;
}> {
  const used = await getDailyUsage(env);
  let tier: BudgetTier;

  if (used >= BUDGET_TIERS.CRITICAL) {
    tier = 'shutdown';
  } else if (used >= BUDGET_TIERS.WARNING) {
    tier = 'critical';
  } else if (used >= BUDGET_TIERS.NORMAL) {
    tier = 'warning';
  } else {
    tier = 'normal';
  }

  return {
    used,
    tier,
    remaining: BUDGET_TIERS.CRITICAL - used,
    quota: BUDGET_TIERS.CRITICAL,
  };
}

/**
 * 判断某层 AI 是否可用（蓝图 2.9 路由规则）
 *
 * L1 规则分类: 始终允许 (0 Neurons)
 * L2 AI 评分:   始终允许 (免费路由)
 * L3 同步分类:   normal/warning → 允许; critical/shutdown → 跳过
 * L4 异步分析:   normal/warning/critical → 允许; shutdown → 跳过
 * L5 裂变搜索:  normal/warning/critical → 允许; shutdown → 跳过
 * L6 Knowledge: normal → 允许; warning/critical/shutdown → 跳过
 */
export async function canUseTier(
  env: Env,
  tier: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6'
): Promise<boolean> {
  const { tier: budgetTier } = await getBudgetStatus(env);

  if (tier === 'L1' || tier === 'L2') return true;
  if (tier === 'L3') return budgetTier === 'normal' || budgetTier === 'warning';
  if (tier === 'L4' || tier === 'L5') return budgetTier !== 'shutdown';
  if (tier === 'L6') return budgetTier === 'normal';
  return false;
}
