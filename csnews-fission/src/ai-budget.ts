/**
 * CSNEWS Fission Worker · AI 预算检查 (Phase 2)
 *
 * 预埋集成点：裂变流程 Workers AI 调用前的预算检查
 * - L5 裂变搜索词生成前调用 shouldTriggerAiCall('L5')
 * - L5 裂变报告生成前调用 shouldTriggerAiCall('L5')
 *
 * KV namespace: AI_USAGE_KV
 * Key format: usage/{YYYY-MM-DD}
 * TTL: 7 days (滚动清理)
 */
import type { Env } from './shared';

// ============================================================
// Types
// ============================================================

export interface DailyUsageRecord {
  total: number;
  calls: Array<{ model: string; neurons: number; ts: number }>;
}

// ============================================================
// Key helpers
// ============================================================

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
 * 获取指定日期的 Neurons 用量
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

// ============================================================
// 阈值常量
// ============================================================
const BUDGET_L4_THRESHOLD = 7_000;
const BUDGET_L5_THRESHOLD = 8_000;
const BUDGET_L6_THRESHOLD = 9_000;

// ============================================================
// Phase 2: 预算检查 hook
// ============================================================

/**
 * L 层 AI 调用预算检查 (Phase 2 核心函数 · 裂变 Worker 用)
 *
 * @param env       - Worker Env (含 AI_USAGE_KV binding)
 * @param level     - AI 调用层级 (L5 裂变搜索 / L6 Knowledge)
 * @param severity  - 可选，severity 影响阈值
 * @returns true = 允许调用 AI; false = 跳过此次调用
 *
 * 阈值规格 (Phase 2):
 *   L5: used < 8,000 Neurons
 *   L6: used < 9,000 Neurons
 */
export async function shouldTriggerAiCall(
  env: Env,
  level: 'L4' | 'L5' | 'L6',
  _severity?: number
): Promise<boolean> {
  const used = await getDailyUsage(env);

  if (level === 'L4') return used < BUDGET_L4_THRESHOLD;
  if (level === 'L5') return used < BUDGET_L5_THRESHOLD;
  if (level === 'L6') return used < BUDGET_L6_THRESHOLD;

  // Unknown level: allow by default
  return true;
}
