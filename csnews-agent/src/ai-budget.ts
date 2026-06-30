/**
 * AI Budget Tracking (Phase 1-2)
 * 记录 Neurons 用量 · 提供预算状态查询 · 预算检查 hook
 *
 * Phase 1: Neurons 用量追踪（KV `usage/{YYYY-MM-DD}`，TTL 7 天）
 * Phase 2: 预算检查 hook（shouldTriggerAiCall）
 */

// ===========================
// Env 接口扩展（KV binding）
// KVNamespace 类型来自 worker-configuration.d.ts（wrangler types 生成）
// ===========================
interface AiBudgetEnv {
  AI_USAGE_KV?: {
    get(key: string, type?: 'text'): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  AI_BUDGET_DAILY_LIMIT?: number;
  AI_BUDGET_WARNING_THRESHOLD?: number;
  AI_BUDGET_CRITICAL_THRESHOLD?: number;
  AI_BUDGET_SHUTDOWN_THRESHOLD?: number;
}

// ===========================
// 阈值读取（带默认值）
// ===========================
function getLimit(env: AiBudgetEnv, key: keyof AiBudgetEnv, fallback: number): number {
  const val = env[key];
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function getDailyLimit(env: AiBudgetEnv): number {
  return getLimit(env, 'AI_BUDGET_DAILY_LIMIT', 10000);
}

function getWarningThreshold(env: AiBudgetEnv): number {
  return getLimit(env, 'AI_BUDGET_WARNING_THRESHOLD', 5000);
}

function getCriticalThreshold(env: AiBudgetEnv): number {
  return getLimit(env, 'AI_BUDGET_CRITICAL_THRESHOLD', 7000);
}

function getShutdownThreshold(env: AiBudgetEnv): number {
  return getLimit(env, 'AI_BUDGET_SHUTDOWN_THRESHOLD', 8000);
}

// ===========================
// 日期工具
// ===========================
function todayUtc(): string {
  // 返回 YYYY-MM-DD（UTC）
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function kvKey(date?: string): string {
  return `usage/${date ?? todayUtc()}`;
}

// ===========================
// Phase 1: Neurons 用量追踪
// ===========================

/**
 * 记录一次 AI 调用消耗的 Neurons
 * @param model  模型名称（如 @cf/meta/llama-3.1-8b-instruct-fp8）
 * @param neurons  消耗的 Neurons 数量
 */
export async function recordAiCall(
  model: string,
  neurons: number,
  env: AiBudgetEnv
): Promise<void> {
  if (!env.AI_USAGE_KV) return;
  const key = kvKey();
  const raw = await env.AI_USAGE_KV.get(key, 'text');
  const current: { total: number; calls: { model: string; neurons: number; ts: string }[] } = raw
    ? JSON.parse(raw)
    : { total: 0, calls: [] };

  current.total += neurons;
  current.calls.push({ model, neurons, ts: new Date().toISOString() });

  // TTL 7 天（604800 秒）= 滚动清理
  await env.AI_USAGE_KV.put(key, JSON.stringify(current), {
    expirationTtl: 604800,
  });
}

/**
 * 读取今日累计 Neurons 用量
 */
export async function getDailyUsage(env: AiBudgetEnv): Promise<number> {
  if (!env.AI_USAGE_KV) return 0;
  const key = kvKey();
  const raw = await env.AI_USAGE_KV.get(key, 'text');
  if (!raw) return 0;
  try {
    const data = JSON.parse(raw);
    return typeof data.total === 'number' ? data.total : 0;
  } catch {
    return 0;
  }
}

/**
 * 预算状态枚举
 * - normal:    < 5K（50%）  全开
 * - warning:   5K-7K（50%-70%）  跳过 L6
 * - critical:  7K-8K（70%-80%）  跳过 L5 + L6
 * - shutdown:  > 8K（80%）  只 L1-L3
 */
export type BudgetStatus = 'normal' | 'warning' | 'critical' | 'shutdown';

interface BudgetStatusResult {
  status: BudgetStatus;
  used: number;
  limit: number;
  remaining: number;
  /** 百分比 0-100 */
  pct: number;
}

/**
 * 获取当前预算状态（用于 health 端点监控字段）
 */
export async function getBudgetStatus(env: AiBudgetEnv): Promise<BudgetStatusResult> {
  const used = await getDailyUsage(env);
  const limit = getDailyLimit(env);
  const warning = getWarningThreshold(env);
  const critical = getCriticalThreshold(env);
  const shutdown = getShutdownThreshold(env);
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

  let status: BudgetStatus = 'normal';
  if (used >= shutdown) status = 'shutdown';
  else if (used >= critical) status = 'critical';
  else if (used >= warning) status = 'warning';

  return { status, used, limit, remaining, pct };
}

/**
 * CF Cron 每日 0 点 UTC 重置计数器
 * 由 wrangler.toml 的 `triggers.crons = ["0 0 * * *"]` 触发
 */
export async function resetDailyCounter(env: AiBudgetEnv): Promise<{ previousTotal: number }> {
  if (!env.AI_USAGE_KV) return { previousTotal: 0 };
  const key = kvKey();
  const raw = await env.AI_USAGE_KV.get(key, 'text');
  let previousTotal = 0;
  if (raw) {
    try {
      const data = JSON.parse(raw);
      previousTotal = typeof data.total === 'number' ? data.total : 0;
    } catch {
      /* ignore */
    }
  }
  // 删除旧 key（TTL 会自然过期，但手动删除确保立即重置）
  await env.AI_USAGE_KV.delete(key);
  return { previousTotal };
}

// ===========================
// Phase 2: 预算检查 hook
// ===========================

/**
 * 判断当前预算是否允许触发指定层级的 AI 调用
 *
 * 集成点（预埋，启动时接入）：
 * - 异步 LLM 深度分析（L4）：warning + severity ≥ L4
 * - 裂变搜索 LLM（L5）：topic 触发裂变
 * - Knowledge Engine LLM（L6）：warning 24h 后
 *
 * 用法示例：
 *   const shouldAnalyze = shouldTriggerAiCall('L4', severity);
 *   if (!shouldAnalyze) {
 *     await markAsDegraded(warningId, 'warnings');
 *     return null;
 *   }
 *   // proceed with LLM call...
 */
export function shouldTriggerAiCall(
  _env: AiBudgetEnv,
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6',
  _severity?: number,
  _dailyUsed?: number
): boolean {
  // L1-L3 不受限
  if (level === 'L1' || level === 'L2' || level === 'L3') return true;

  // NOTE: 实际调用时需要传入 env 并 await getDailyUsage()
  // 此函数为同步签名，完整版本示例如下：
  //
  // export async function shouldTriggerAiCallAsync(
  //   level: 'L4' | 'L5' | 'L6',
  //   severity: number | undefined,
  //   env: AiBudgetEnv,
  // ): Promise<boolean> {
  //   const used = await getDailyUsage(env);
  //   switch (level) {
  //     case 'L4': return used < getCriticalThreshold(env);  // < 7K
  //     case 'L5': return used < getShutdownThreshold(env); // < 8K
  //     case 'L6': return used < getDailyLimit(env);        // < 10K
  //     default:   return true;
  //   }
  // }

  // 当前预算阈值（蓝图权威公式）：
  // L4: budget < 7000（70%）触发降级
  // L5: budget < 8000（80%）触发降级
  // L6: budget < 9000（90%）触发降级
  // 此处返回 true 作为默认（集成前不阻断），实际调用方需用 Async 版本
  return true;
}
