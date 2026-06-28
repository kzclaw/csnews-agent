// ============================================================
// Workers AI 工具函数
// ============================================================
//用途：抽离 index.ts 的 Workers AI 响应解析 + 裂变报告生成函数
// 让 endpoints.ts 不依赖 index.ts（避免循环依赖）
import { Env } from './shared';
import { shouldTriggerAiCall } from './ai-budget';

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
  // Phase 2: 预算检查 L2（AI 评分）
  if (!(await shouldTriggerAiCall(env, 'L2'))) {
    return '(AI跳过-预算不足-L2)';
  }
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

// ============================================================
// R2 JSON 读取 helpers
// ============================================================

// R2 JSON 读取 + parse + fallback (已存在)
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

// ============================================================
// entity/event handler 专用 R2 read helpers
// 消除 entity + event handler 内 4+1 处重复的 try/catch + R2 read + not-found 模式
// ============================================================

/**
 * 读 R2 JSON 并返回 null if not found (不 throw)。
 * JSON parse 失败仍 throw，供 caller try/catch 处理。
 * 用于 entity/event handler 的只读 R2 操作。
 */
export async function readR2JsonOrNull<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.csnews_raw.get(key);
  if (!obj) return null;
  return obj.json<T>();
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
// v0.36.21 endpoint hit counter (content/trend/knowledge)
// ============================================================

// 替代 3 个 handler 中完全相同的监控计数代码 (endpoints-trend.ts)
// 业务契约:
//   - env.PROCESS_STATE 不存在 → 静默跳过 (不阻塞)
//   - KV put 失败 → 静默跳过 (不阻塞)
export async function incrementHitCounter(
  env: Env,
  ctx: ExecutionContext,
  counterKeyFn: () => string,
  limitBytes: number
): Promise<void> {
  if (!env.PROCESS_STATE) return;
  try {
    const counterKey = counterKeyFn();
    const cur = parseInt((await env.PROCESS_STATE.get(counterKey)) || '0', 10);
    ctx.waitUntil(env.PROCESS_STATE.put(counterKey, String(cur + 1), { expirationTtl: 86400 }));
  } catch {
    // 监控失败不阻塞
  }
}

// ============================================================
// entity-review 公共 mutation helpers
// 消除 approve / reject / noise-add / noise-remove 4 个 handler 的主体重复
// ============================================================

/**
 * 读 entity-candidates.json (含 candidates + noise 数组)
 * 失败 throw，供 caller 的 try/catch 处理
 */
export async function readCandidatesJson(env: Env): Promise<{
  candidates: any[];
  noise: any[];
  generated_at: string;
}> {
  const obj = await env.csnews_raw.get('entity/entity-candidates.json');
  if (!obj) throw new Error('entity-candidates.json not found');
  return obj.json<{ candidates: any[]; noise: any[]; generated_at: string }>();
}

/**
 * 统一写回 entity-candidates.json (R2 put + trigger re-clustering fire-and-forget)
 */
export async function writeCandidatesJson(
  env: Env,
  json: { candidates: any[]; noise: any[]; generated_at: string }
): Promise<void> {
  await env.csnews_raw.put(
    'entity/entity-candidates.json',
    JSON.stringify({ ...json, generated_at: new Date().toISOString() }, null, 2)
  );
}

// ============================================================
// v0.36.21 entity / event cron freshness helper
// ============================================================
// viewer dashboard 加 entity_freshness / event_freshness 2 字段
// 立刻看到 entity cron + event cron 是不是 stale (vs 之前 viewer 不知道 entity/event 何时跑)
// entity / event cron 每日 1 次 (03:00 / 03:30 UTC), 阈值 = 25h (起床 ~26h 时看到 degraded) / 50h (cron 真 stale)

// entity/event cron freshness thresholds: 25h (degraded) / 50h (down)
// entity/event cron 间隔 24h, 起床 ~26h 时看到 degraded 是健康警告, 50h+ 是 cron stale
const OK_HOURS = 25;
const DOWN_HOURS = 50;

/**
 * 实体 / 事件 cron freshness (viewer dashboard 立即可见 2 字段)
 * 业务契约:
 *   - R2 obj 不存在 / parse 失败 → status='unknown'
 *   - generated_at 不可解析 → status='unknown'
 *   - 正常 → 'ok' (起床 ~26h 时看到 degraded 健康警告, 50h+ 是 cron stale)
 *   - 失败 → 抛错由 caller 处理 (不会 catch, 让 handleHealthAction 5 字段都有, 1 个失败不影响其他)
 */
export async function checkEntityCronHealth(env: Env): Promise<{
  entity_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
  event_freshness: { status: 'ok' | 'degraded' | 'down' | 'unknown'; detail: string };
}> {
  const now = Date.now();

  async function classify(
    env: Env,
    key: string
  ): Promise<{
    status: 'ok' | 'degraded' | 'down' | 'unknown';
    detail: string;
  }> {
    let body: { generated_at?: string; entities?: any[]; clusters?: any[] } | null = null;
    try {
      const obj = await env.csnews_raw.get(key);
      if (obj) body = await obj.json();
    } catch {
      return { status: 'unknown', detail: 'R2 read failed' };
    }
    if (!body?.generated_at) {
      return { status: 'unknown', detail: 'R2 未找到 (cron 尚未跑过)' };
    }
    const lastMs = Date.parse(body.generated_at);
    if (!Number.isFinite(lastMs)) {
      return { status: 'unknown', detail: `generated_at 不可解析: ${body.generated_at}` };
    }
    const count = Array.isArray(body.entities)
      ? body.entities.length
      : Array.isArray(body.clusters)
        ? body.clusters.length
        : 0;
    const ageHours = (now - lastMs) / 3600_000;
    const ageH = Math.round(ageHours);
    if (ageHours < OK_HOURS) {
      return { status: 'ok', detail: `${ageH} 小时前 (${count} 条)` };
    } else if (ageHours < DOWN_HOURS) {
      return { status: 'degraded', detail: `${ageH} 小时前 (> ${OK_HOURS}h, 需要 cron 跑)` };
    } else {
      return { status: 'down', detail: `${ageH} 小时前 (> ${DOWN_HOURS}h, cron stale)` };
    }
  }

  return {
    entity_freshness: await classify(env, ENTITY_FINALIZED_R2_KEY),
    event_freshness: await classify(env, EVENT_CLUSTERS_R2_KEY),
  };
}
