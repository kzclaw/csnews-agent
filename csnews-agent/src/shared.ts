/**
 * CSNEWS Agent · 共享工具
 *
 * 从 index.ts 抽出,避免模块化失控(核心原则 #2 模块化)
 * 所有共享类型 / 工具函数在这里集中维护
 */

export interface Env {
  AI: Ai;
  csnews_raw: R2Bucket;
  BEARER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /**
   * Worker 自身的公开 URL。
   * 用于 Cron Trigger 自调 process action —— 走 CF 内部 routing 避免 Bot Fight Mode challenge。
   * 在 wrangler.toml 的 [vars] 里配置（占位符 YOUR-WORKER.workers.dev 部署时替换）。
   */
  WORKER_SELF_URL: string;
  /**
   * Worker 版本标识。
   * 用于 ?action=health 端点返回 worker_version 字段。
   * 部署新版本后手动改 wrangler.toml [vars].WORKER_VERSION (或接 GitHub Actions 自动化)。
   */
  WORKER_VERSION?: string;
  /**
   * KV namespace 存 process 最后状态 (last_process_at + last_process_result)。
   * 部署后跑 `npx wrangler kv namespace create PROCESS_STATE` + 把 id 填到 wrangler.toml。
   * 本次实施不绑 (handler 中 env.PROCESS_STATE 判空跳过, 后续 KR 启用)。
   */
  PROCESS_STATE?: KVNamespace;
  /**
   * Vectorize index for news_hotspots embedding vector storage.
   */
  VECTORIZE?: Vectorize;
  /**
   * Tavily Search API key (CF Secret: TAVILY_API_KEY).
   * Set via `wrangler secret put TAVILY_API_KEY`.
   * Placeholder "YOUR_KEY_HERE" activates mock test mode.
   */
  TAVILY_API_KEY?: string;

  /**
   * KV namespace 存 AI Neurons 用量 (Phase 1).
   * Key format: usage/{YYYY-MM-DD}, TTL 7 days.
   */
  AI_USAGE_KV?: KVNamespace;

  /**
   * AI 预算阈值 env vars (Phase 1).
   * 在 wrangler.toml [vars] 中配置 (非 Secret，明文安全)。
   */
  AI_BUDGET_DAILY_LIMIT?: number;
  AI_BUDGET_WARNING_THRESHOLD?: number;
  AI_BUDGET_CRITICAL_THRESHOLD?: number;
  AI_BUDGET_SHUTDOWN_THRESHOLD?: number;
}

export function getSupabaseHost(env: Env): string {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}

/**
 * Supabase fetch wrapper(带 apikey + Authorization)
 */
export async function supabaseFetch(
  env: Env,
  path: string,
  options?: RequestInit
): Promise<Response> {
  return fetch(`${getSupabaseHost(env)}${path}`, {
    ...options,
    // 用户 headers 先 spread, 硬编码 apikey/Authorization 后 fallback = 用户 Prefer 头不丢失
    headers: {
      ...options?.headers,
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * 安全的 JSON 解析:空响应返回 null,解析失败也返回 null
 */
export async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 统一 JSON 响应格式，消除重复的 Response 构造样板
 */
export function jsonResponse(
  data: unknown,
  cors: Record<string, string>,
  init?: ResponseInit
): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/**
 * 校验失败的统一 400 响应
 * 替代 endpoints-trend.ts 3 个 handler 中 12 处重复的 Response 构造
 */
export function validationError(
  result: { ok: boolean; error?: string; reason?: string | null },
  cors: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({ error: result.error ?? 'validation_failed', reason: result.reason ?? null }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}

/**
 * 从 Supabase HEAD count=exact 响应中解析总数
 * 替代 endpoints-trend.ts 中 5 处 parseInt(..., 10) 重复
 * 业务契约:
 *   - header 不存在 → 0
 *   - header 格式异常 → 0
 */
export function parseCountHeader(res: Response): number {
  return parseInt(res.headers.get('content-range')?.split('/')[1] ?? '0', 10);
}

/**
 * 载荷超限的统一 413 响应
 * 替代 endpoints-trend.ts 3 个 handler 中的重复 Response 构造
 */
export function payloadTooLargeResponse(
  reason: string,
  limitBytes: number,
  cors: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({ error: 'payload_too_large', reason }),
    { status: 413, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}
