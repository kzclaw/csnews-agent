// ============================================================
// Workers AI 工具函数
// ============================================================
//用途：抽离 index.ts 的 Workers AI 响应解析 + 裂变报告生成函数
// 让 endpoints.ts 不依赖 index.ts（避免循环依赖）
import { Env } from './shared';

// ============================================================
// Supabase auth headers helper
// ============================================================
// 替代 7 处 (scheduled×2, endpoints-core×2, entity-process×1, health-checks×2) 重复拼装
export function supabaseHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
}
import { AI_ROUTE_R_THRESHOLD } from './score';
import { ENTITY_FINALIZED_R2_KEY } from './entity-process';
import { EVENT_CLUSTERS_R2_KEY } from './event-process';
import type { LlamaAIResponse } from './types';

//Workers AI响应解析
// env.AI.run() 返回格式:{ response: string, usage: {...} }
export function extractText(resp: any): string {
  if (typeof resp === 'string') return resp.trim();
  if (resp && typeof resp === 'object') {
    const text = (resp.response || '').trim();
    if (text) return text;
  }
  return '';
}

//Workers AI裂变报告生成
// only call AI when R >= AI_ROUTE_R_THRESHOLD
// NOTE: scoreRule max=7.6, threshold must be <=7.6 to be reachable
export async function maybeFissionReport(title: string, env: Env, rScore: number): Promise<string> {
  if (rScore < AI_ROUTE_R_THRESHOLD) return `(AI跳过-R<${AI_ROUTE_R_THRESHOLD})`;
  try {
    // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
    const resp = (await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'user', content: `根据以下新闻，生成一段50字左右的裂变分析报告：\n\n${title}` },
      ],
      max_tokens: 200,
      temperature: 0.3,
    })) as LlamaAIResponse;
    return extractText(resp) || '(无AI输出)';
  } catch (e: any) {
    return `(AI错误: ${e.message})`;
  }
}

// ============================================================
// v0.36.20 通用 helper · csnews-audit 修复
// ============================================================

// R2 JSON 读取 + parse + fallback
// 替代 3 处 knowledge index read + 1 处 content 全文 read 的重复代码
// 业务契约:
//   - R2 obj 不存在 → 返回 fallback
//   - JSON parse 失败 → 返回 fallback
//   - fallback 是数组时, R2 存了非数组的脏数据 → 返回 fallback (类型保护)
//   - 任何 throw → 返回 fallback (KV/R2 临时不可用降级)
export async function readR2Json<T>(env: Env, key: string, fallback: T): Promise<T> {
  try {
    const obj = await env.csnews_raw.get(key);
    if (!obj) return fallback;
    const data = await obj.json<T>();
    if (Array.isArray(fallback) && !Array.isArray(data)) return fallback;
    return data;
  } catch {
    return fallback;
  }
}

// Rate limit 消费 (单 IP 60 req/min 滚动窗口)
// 替代 5 处 (content/trend/knowledge/entity/event) rate limit 重复代码
// 业务契约:
//   - env.PROCESS_STATE 不存在 → 降级为不限流
//   - 计数已达 limit → 返回 { exceeded: true, count }
//   - 计数 +1 (TTL 60s) + ctx.waitUntil 异步持久化 → 返回 { exceeded: false, count }
//   - KV get/put throw → 降级为不限流 (不阻塞主流程)
export async function checkRateLimit(
  env: Env,
  ctx: ExecutionContext,
  rateKey: string,
  limit: number
): Promise<{ exceeded: boolean; count: number }> {
  if (!env.PROCESS_STATE) return { exceeded: false, count: 0 };
  try {
    const cur = parseInt((await env.PROCESS_STATE.get(rateKey)) || '0', 10);
    if (cur >= limit) {
      return { exceeded: true, count: cur };
    }
    ctx.waitUntil(env.PROCESS_STATE.put(rateKey, String(cur + 1), { expirationTtl: 60 }));
    return { exceeded: false, count: cur + 1 };
  } catch {
    // 限流检查失败不阻塞主流程 (KV 临时不可用降级为不限流)
    return { exceeded: false, count: 0 };
  }
}

// Rate limit 429 响应 (跟 5 处原 code 完全一致, 含 Retry-After 头)
export function rateLimitResponse(cors: Record<string, string>, limit: number): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      reason: `单 IP ${limit} req/min 上限, 请稍后重试`,
    }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
    }
  );
}

// ============================================================
// v0.36.21 entity / event cron freshness helper
// ============================================================
// viewer dashboard 加 entity_freshness / event_freshness 2 字段
// 立刻看到 entity cron + event cron 是不是 stale (vs 之前 viewer 不知道 entity/event 何时跑)
// entity / event cron 每日 1 次 (03:00 / 03:30 UTC), 阈值 = 25h (起床 ~26h 时看到 degraded) / 50h (cron 真 stale)
// R2 永远 source of truth (跟 schema migration 撤回前一致), freshness 从 R2 读 generated_at
export interface FreshnessResult {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  age_ms: number | null;
  last_write: string | null;
  count: number | null;
  detail: string;
}

// 默认阈值: 25h / 50h (entity/event cron 间隔 24h, 起床 ~26h 时看到 degraded 是健康警告, 50h+ 是 cron stale)
const DEFAULT_OK_HOURS = 25;
const DEFAULT_DOWN_HOURS = 50;

/**
 * 读 R2 freshness 元数据 (entity-finalized.json 或 event-clusters.json)
 * 业务契约:
 *   - R2 obj 不存在 → 返 { last_write: null, count: null } (status='unknown')
 *   - JSON parse 失败 → 同上 (status='unknown')
 *   - generated_at 缺失或不可解析 → status='unknown'
 *   - generated_at 可解析 → 计算 age_ms + 按阈值分类 status
 */
async function readR2Freshness(
  env: Env,
  key: string
): Promise<{ last_write: string | null; count: number | null }> {
  try {
    const obj = await env.csnews_raw.get(key);
    if (!obj) return { last_write: null, count: null };
    const body = await obj.json<{ generated_at?: string; entities?: any[]; clusters?: any[] }>();
    const lastWrite = body.generated_at || null;
    const count = Array.isArray(body.entities)
      ? body.entities.length
      : Array.isArray(body.clusters)
        ? body.clusters.length
        : null;
    return { last_write: lastWrite, count };
  } catch {
    return { last_write: null, count: null };
  }
}

/**
 * 按 age 阈值分类 freshness status
 * 业务契约:
 *   - 缺失 last_write 或不可解析 → 'unknown'
 *   - age < okHours → 'ok'
 *   - okHours <= age < downHours → 'degraded'
 *   - age >= downHours → 'down'
 */
function classifyFreshness(
  data: { last_write: string | null; count: number | null },
  now: number,
  okHours: number,
  downHours: number
): FreshnessResult {
  if (!data.last_write) {
    return {
      status: 'unknown',
      age_ms: null,
      last_write: null,
      count: data.count,
      detail: 'R2 未找到 (cron 尚未跑过)',
    };
  }
  const lastMs = Date.parse(data.last_write);
  if (!Number.isFinite(lastMs)) {
    return {
      status: 'unknown',
      age_ms: null,
      last_write: data.last_write,
      count: data.count,
      detail: `generated_at 不可解析: ${data.last_write}`,
    };
  }
  const ageMs = now - lastMs;
  const ageHours = ageMs / 3600_000;
  if (ageHours < okHours) {
    return {
      status: 'ok',
      age_ms: ageMs,
      last_write: data.last_write,
      count: data.count,
      detail: `${Math.round(ageHours)} 小时前 (${data.count ?? 0} 条)`,
    };
  } else if (ageHours < downHours) {
    return {
      status: 'degraded',
      age_ms: ageMs,
      last_write: data.last_write,
      count: data.count,
      detail: `${Math.round(ageHours)} 小时前 (> ${okHours}h, 需要 cron 跑)`,
    };
  } else {
    return {
      status: 'down',
      age_ms: ageMs,
      last_write: data.last_write,
      count: data.count,
      detail: `${Math.round(ageHours)} 小时前 (> ${downHours}h, cron stale)`,
    };
  }
}

/**
 * 实体 / 事件 cron freshness (viewer dashboard 立即可见 2 字段)
 * 业务契约:
 *   - 0 R2 obj (cron 尚未跑) → entity_freshness.status='unknown'
 *   - 正常 → 'ok' (起床 ~26h 时看到 degraded 健康警告, 50h+ 是 cron stale)
 *   - 失败 → 抛错由 caller 处理 (不会 catch, 让 handleHealthAction 5 字段都有, 1 个失败不影响其他)
 */
export async function checkEntityCronHealth(env: Env): Promise<{
  entity_freshness: FreshnessResult;
  event_freshness: FreshnessResult;
}> {
  const now = Date.now();
  const entityData = await readR2Freshness(env, ENTITY_FINALIZED_R2_KEY);
  const eventData = await readR2Freshness(env, EVENT_CLUSTERS_R2_KEY);
  return {
    entity_freshness: classifyFreshness(entityData, now, DEFAULT_OK_HOURS, DEFAULT_DOWN_HOURS),
    event_freshness: classifyFreshness(eventData, now, DEFAULT_OK_HOURS, DEFAULT_DOWN_HOURS),
  };
}
