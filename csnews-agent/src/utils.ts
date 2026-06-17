// ============================================================
// Worker AI工具函数（v0.33+sweep·FT-KR0 · Phase0 · T000 helper）
// ============================================================
//用途：抽离 index.ts 的 Workers AI响应解析 +裂变报告生成函数
// 让 endpoints.ts 不依赖 index.ts（避免循环依赖）
// v0.36.20 · csnews-audit 修复：抽 readR2Json + checkRateLimit 通用 helper
//  （audit 4.3.2 / 4.3.3 · 5 处 rate limit + 4 处 R2 JSON 读复用）
//详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
// specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}
import { Env } from './shared';
import { AI_ROUTE_R_THRESHOLD } from './score';

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
// KR0: only call AI when R >= AI_ROUTE_R_THRESHOLD
// NOTE: scoreRule max=7.6, threshold must be <=7.6 to be reachable
export async function maybeFissionReport(title: string, env: Env, rScore: number): Promise<string> {
 if (rScore < AI_ROUTE_R_THRESHOLD) return `(AI跳过-R<${AI_ROUTE_R_THRESHOLD})`;
 try {
 const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
 messages: [
 { role: 'user', content: `根据以下新闻，生成一段50字左右的裂变分析报告：\n\n${title}` }
 ],
 max_tokens:200,
 temperature:0.3,
 }) as any;
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
  limit: number,
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
  return new Response(JSON.stringify({
    error: 'rate_limited',
    reason: `单 IP ${limit} req/min 上限, 请稍后重试`,
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', ...cors, 'Retry-After': '60' },
  });
}
