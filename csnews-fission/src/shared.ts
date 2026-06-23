/**
 * CSNEWS Fission Worker · 共享工具
 *
 * 从主 Worker 移植的共享类型 / 工具函数
 */
export interface Env {
  AI: Ai;
  csnews_raw: R2Bucket;
  BEARER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TAVILY_API_KEY?: string;
  /**
   * KV namespace 存 AI Neurons 用量 (Phase 1 · O12KR1)
   * 复用主 Worker AI_USAGE_KV，同一账户级别资源
   */
  AI_USAGE_KV?: KVNamespace;
}

export function getSupabaseHost(env: Env): string {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}
