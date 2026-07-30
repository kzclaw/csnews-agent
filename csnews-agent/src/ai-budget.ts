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
  return getLimit(env, 'AI_BUDGET_DAILY_LIMIT', DEFAULT_DAILY_LIMIT);
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
// 常量定义
// ===========================
const SEVEN_DAYS_TTL = 604800; // 7 days in seconds (TTL 滚动清理)
export const DEFAULT_DAILY_LIMIT = 10000; // Workers AI Free Tier 10K Neurons/天
const MAX_CALLS_IN_KV = 1000; // calls 数组上限，防止单 KV 值膨胀超过 25 MiB

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
 *
 * NOTE: 存在 read-modify-write 竞态条件（KV get → modify → put）。
 * 两并发请求可导致一次增量丢失。KV 不提供原子 counter，
 * 此函数接受最终一致性（fail-open 设计：丢失计数只影响预算检查，
 * 不会漏调用）。
 */
export async function recordAiCall(
  model: string,
  neurons: number,
  env: AiBudgetEnv
): Promise<void> {
  if (!env.AI_USAGE_KV) return;
  try {
    const key = kvKey();
    const raw = await env.AI_USAGE_KV.get(key, 'text');
    const current: { total: number; calls: { model: string; neurons: number; ts: string }[] } = raw
      ? JSON.parse(raw)
      : { total: 0, calls: [] };

    current.total += neurons;
    current.calls.push({ model, neurons, ts: new Date().toISOString() });

    // calls 数组上限保护：超限时丢弃最旧记录
    if (current.calls.length > MAX_CALLS_IN_KV) {
      current.calls = current.calls.slice(-MAX_CALLS_IN_KV);
    }

    // TTL 7 天 = 滚动清理
    await env.AI_USAGE_KV.put(key, JSON.stringify(current), {
      expirationTtl: SEVEN_DAYS_TTL,
    });
  } catch (err) {
    // Fail-open: KV 写入失败不阻断调用方
    console.warn('[ai-budget] recordAiCall failed (non-fatal):', err);
  }
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
 *
 * 注意：此函数在 UTC 0 点被 cron 触发，此时"今天"刚开局，
 * 应读"昨天"的总计作为 previousTotal 返回，然后删除昨天的 key。
 * 删除是装饰性的（TTL 自然过期），但确保 KV namespace 不累积陈旧 key。
 */
export async function resetDailyCounter(env: AiBudgetEnv): Promise<{ previousTotal: number }> {
  if (!env.AI_USAGE_KV) return { previousTotal: 0 };
  // 计算昨天的日期（UTC 0 点触发，读前天-Yesterday 的数据）
  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayKey = kvKey(yesterday.toISOString().slice(0, 10));
  const raw = await env.AI_USAGE_KV.get(yesterdayKey, 'text');
  let previousTotal = 0;
  if (raw) {
    try {
      const data = JSON.parse(raw);
      previousTotal = typeof data.total === 'number' ? data.total : 0;
    } catch {
      /* ignore */
    }
  }
  // 删除昨天 key（TTL 会自然过期，但手动删除确保 namespace 干净）
  await env.AI_USAGE_KV.delete(yesterdayKey);
  return { previousTotal };
}

// ===========================
// Phase 2: 预算检查 hook
// ===========================

/**
 * 判断当前预算是否允许触发指定层级的 AI 调用（async · 真实 budget 检查）
 *
 * 集成点：
 * - 异步 LLM 深度分析（L4）：warning + severity ≥ L4
 * - 裂变搜索 LLM（L5）：topic 触发裂变
 * - Knowledge Engine LLM（L6）：warning 24h 后
 * - AI 评分（L2）· 同步分类（L3）· 已调用方 utils.ts / endpoints-trend.ts 预埋
 *
 * 阈值映射（蓝图 2.9 公式 · 文档 Phase 2 伪代码）：
 *   L1 / L2 / L3 → 永远 true（规则分类 + 轻量评分 + 同步分类 · 不计入预算）
 *   L4           → budget < critical (默认 7K, 70%)
 *   L5           → budget < shutdown (默认 8K, 80%)
 *   L6           → budget < daily limit (默认 10K, 100%)
 *
 * 注：文档"warning 跳过 L6 / critical 跳过 L5+L6 / shutdown 跳过 L4-L6"
 * 是总体预算策略描述 · 函数级阈值按 Phase 2 伪代码（per-AI-level 独立阈值）
 *
 * Fail-open 设计：
 *   - AI_USAGE_KV 未配置 → getDailyUsage() 返 0 → L4-L6 永远 allowed
 *   - 跟现有 getDailyUsage / getBudgetStatus 行为一致
 *
 * 用法示例：
 *   if (!(await shouldTriggerAiCall(env, 'L4', severity))) {
 *     await markAsDegraded(warningId, 'warnings');
 *     return null;
 *   }
 *   // proceed with LLM call...
 *
 * @param env  Worker env (含 AI_USAGE_KV + 阈值 vars)
 * @param level  AI 层级 (L1-L6)
 * @param _severity  可选 context (L4 warning 严重度) · 当前未使用 · 预留扩展
 * @param dailyUsed  可选 override（注入今日已用 Neurons · 主要给 contract test 用）
 *                   省略时调 getDailyUsage() 从 KV 读
 * @returns 是否允许调用
 */
export async function shouldTriggerAiCall(
  env: AiBudgetEnv,
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6',
  _severity?: number,
  dailyUsed?: number
): Promise<boolean> {
  // L1-L3 不受限（规则分类 + 轻量评分 + 同步分类 · 蓝图设计 L1-L3 永开）
  if (level === 'L1' || level === 'L2' || level === 'L3') return true;

  // L4-L6: 查今日累计 Neurons 用量 + 阈值比较
  // dailyUsed 提供时直接用（contract test mock 入口）
  // 否则从 KV 读真实用量
  const used = dailyUsed ?? (await getDailyUsage(env));

  switch (level) {
    case 'L4':
      return used < getCriticalThreshold(env); // 7K (70%) 触发降级
    case 'L5':
      return used < getShutdownThreshold(env); // 8K (80%) 触发降级
    case 'L6':
      return used < getDailyLimit(env); // 10K (100%) 触发降级
    default:
      // 未知 level 保守返回 true（fail-open · 不阻断未知调用）
      return true;
  }
}
