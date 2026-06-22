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
