/**
 * CSNEWS Agent · AI 预算追踪 (Phase 1)
 *
 * Phase 1: Neurons 用量追踪基础模块
 * - 记录每次 AI 调用的 Neurons 消耗
 * - 提供当日/指定日期用量查询
 * - 提供 4 档预算状态 (normal/warning/critical/shutdown)
 * - 提供每日 UTC 0 点重置 (供 cron 调用)
 *
 * KV namespace: AI_USAGE_KV
 * Key format:  usage/{YYYY-MM-DD}
 * TTL: 7 days (滚动清理)
 */
import type { Env } from './shared';

// ============================================================
// Types
// ============================================================

export type BudgetStatus = 'normal' | 'warning' | 'critical' | 'shutdown';
export type BudgetTier = BudgetStatus;

export interface BudgetInfo {
  used: number;
  tier: BudgetStatus;
  remaining: number;
  quota: number;
}

export interface DailyUsageRecord {
  total: number;
  calls: AiCallRecord[];
}

export interface AiCallRecord {
  model: string;
  neurons: number;
  ts: number; // Unix ms
}

// ============================================================
// Constants (exported for test backward compatibility)
// ============================================================

export const BUDGET_TIERS = {
  NORMAL: 5_000,
  WARNING: 7_000,
  CRITICAL: 8_000,
} as const;

// ============================================================
// Key helpers
// ============================================================

/**
 * 生成 KV key: usage/YYYY-MM-DD
 */
function usageKey(date?: string): string {
  if (date) return `usage/${date}`;
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `usage/${y}-${m}-${day}`;
}

// ============================================================
// Core functions
// ============================================================

/**
 * 记录一次 AI 调用 (Phase 1 核心函数)
 *
 * @param env    - Worker Env (含 AI_USAGE_KV binding)
 * @param model  - 模型名称，如 "kimi-k2.5"
 * @param neurons - 此次调用消耗的 Neurons 数量
 */
export async function recordAiCall(
  env: Env,
  model: string,
  neurons: number
): Promise<void> {
  if (!env.AI_USAGE_KV) return;
  if (neurons < 0) return;

  const key = usageKey();
  try {
    const raw = await env.AI_USAGE_KV.get(key);
    let record: DailyUsageRecord = { total: 0, calls: [] };

    if (raw) {
      try {
        record = JSON.parse(raw) as DailyUsageRecord;
      } catch {
        record = { total: 0, calls: [] };
      }
    }

    record.total += neurons;
    record.calls.push({ model, neurons, ts: Date.now() });

    // TTL 7 days = 604800 seconds
    await env.AI_USAGE_KV.put(key, JSON.stringify(record), {
      expirationTtl: 604_800,
    });
  } catch {
    // KV 写入失败静默，不影响主流程
  }
}

/**
 * 记录 Neurons 消耗 (Phase 1 核心函数)
 * 注意: 推荐使用 recordAiCall(env, model, neurons) 以便追踪 model 维度
 * @deprecated use recordAiCall instead
 */
export async function recordUsage(env: Env, neurons: number): Promise<void> {
  if (!env.AI_USAGE_KV) return;
  if (neurons < 0) return;

  const key = usageKey();
  try {
    const raw = await env.AI_USAGE_KV.get(key);
    let record: DailyUsageRecord = { total: 0, calls: [] };

    if (raw) {
      try {
        record = JSON.parse(raw) as DailyUsageRecord;
      } catch {
        record = { total: 0, calls: [] };
      }
    }

    record.total += neurons;
    record.calls.push({ model: 'unknown', neurons, ts: Date.now() });

    await env.AI_USAGE_KV.put(key, JSON.stringify(record), {
      expirationTtl: 604_800,
    });
  } catch {
    // KV 写入失败静默
  }
}

/**
 * 获取指定日期的 Neurons 用量 (Phase 1 核心函数)
 *
 * @param env  - Worker Env
 * @param date - 可选，YYYY-MM-DD 格式。省略则取今日 UTC
 * @returns 当日总 Neurons 消耗
 */
export async function getDailyUsage(env: Env, date?: string): Promise<number> {
  if (!env.AI_USAGE_KV) return 0;

  const key = usageKey(date);
  try {
    const raw = await env.AI_USAGE_KV.get(key);
    if (!raw) return 0;
    const record = JSON.parse(raw) as DailyUsageRecord;
    return record?.total ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 获取当前预算状态 (Phase 1 核心函数)
 *
 * @param env - Worker Env
 * @returns 预算状态信息
 *
 * 4 档阈值 (由 env vars 控制):
 *   normal:    used < AI_BUDGET_WARNING_THRESHOLD  (默认 5K)
 *   warning:   used >= 5K && used < AI_BUDGET_CRITICAL_THRESHOLD (默认 7K)
 *   critical:  used >= 7K && used < AI_BUDGET_SHUTDOWN_THRESHOLD (默认 8K)
 *   shutdown:  used >= AI_BUDGET_SHUTDOWN_THRESHOLD (默认 8K)
 */
export async function getBudgetStatus(env: Env): Promise<BudgetInfo> {
  const used = await getDailyUsage(env);

  const dailyLimit =
    typeof env.AI_BUDGET_DAILY_LIMIT === 'number' && env.AI_BUDGET_DAILY_LIMIT > 0
      ? env.AI_BUDGET_DAILY_LIMIT
      : 10_000;
  const warningThreshold =
    typeof env.AI_BUDGET_WARNING_THRESHOLD === 'number' && env.AI_BUDGET_WARNING_THRESHOLD > 0
      ? env.AI_BUDGET_WARNING_THRESHOLD
      : 5_000;
  const criticalThreshold =
    typeof env.AI_BUDGET_CRITICAL_THRESHOLD === 'number' && env.AI_BUDGET_CRITICAL_THRESHOLD > 0
      ? env.AI_BUDGET_CRITICAL_THRESHOLD
      : 7_000;
  const shutdownThreshold =
    typeof env.AI_BUDGET_SHUTDOWN_THRESHOLD === 'number' && env.AI_BUDGET_SHUTDOWN_THRESHOLD > 0
      ? env.AI_BUDGET_SHUTDOWN_THRESHOLD
      : 8_000;

  let tier: BudgetStatus;
  if (used >= shutdownThreshold) {
    tier = 'shutdown';
  } else if (used >= criticalThreshold) {
    tier = 'critical';
  } else if (used >= warningThreshold) {
    tier = 'warning';
  } else {
    tier = 'normal';
  }

  return {
    used,
    tier,
    remaining: Math.max(0, dailyLimit - used),
    quota: dailyLimit,
  };
}

/**
 * 重置当日计数器 (Phase 1 核心函数)
 *
 * 由每日 UTC 0 点 cron 调用。
 * 注意: KV key 有 TTL 7 天自动过期，此函数主动删除今日 key
 * 以确保跨天后 getDailyUsage 不读到旧数据。
 *
 * @param env - Worker Env
 */
export async function resetDailyCounter(env: Env): Promise<void> {
  if (!env.AI_USAGE_KV) return;

  const today = usageKey();
  try {
    await env.AI_USAGE_KV.delete(today);
  } catch {
    // 删除失败静默，TTL 会兜底
  }
}

/**
 * 判断某层 AI 是否可用 (Phase 2 路由规则)
 *
 * 蓝图 2.9: if ai_budget < threshold: only_process(L4, L5)
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

// ============================================================
// Phase 2: 预算检查 hook
// ============================================================

/**
 * L 层 AI 调用预算检查 (Phase 2 核心函数)
 *
 * @param env       - Worker Env (含 AI_USAGE_KV binding)
 * @param level     - AI 调用层级 L1-L6
 * @param severity  - 可选，severity 影响阈值 (severity越高阈值越严苛)
 * @returns true = 允许调用 AI; false = 跳过此次调用
 *
 * 阈值规格 (O12KR1 Phase 2):
 *   L1: 始终允许 (规则分类 0 Neurons)
 *   L2: 始终允许 (AI 评分免费路由)
 *   L4: used < 7,000 Neurons
 *   L5: used < 8,000 Neurons
 *   L6: used < 9,000 Neurons
 *
 * 使用场景:
 *   L2: 每条 news AI 评分前 shouldTriggerAiCall('L2')
 *   L5: fission-trigger Workers AI 调用前 shouldTriggerAiCall('L5')
 *   L6: knowledge generation 前 shouldTriggerAiCall('L6')
 */
export async function shouldTriggerAiCall(
  env: Env,
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6',
  _severity?: number
): Promise<boolean> {
  // L1 规则分类始终允许 (0 Neurons 消耗)
  if (level === 'L1') return true;

  // L2 AI 评分始终允许 (免费路由)
  if (level === 'L2') return true;

  const used = await getDailyUsage(env);

  if (level === 'L4') return used < 7_000;
  if (level === 'L5') return used < 8_000;
  if (level === 'L6') return used < 9_000;

  // L3: fallback to budget tier logic
  return canUseTier(env, level);
}
