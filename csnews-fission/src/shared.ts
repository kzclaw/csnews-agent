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
}

export function getSupabaseHost(env: Env): string {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}
