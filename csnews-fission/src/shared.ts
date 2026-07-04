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
   * KV namespace 存 AI Neurons 用量 (Phase 1)
   * 复用主 Worker AI_USAGE_KV，同一账户级别资源
   */
  AI_USAGE_KV?: KVNamespace;
  /**
   * v0.37.51: 复用主 Worker 的 PROCESS_STATE KV, 读 tavily_pending flag
   * (主 worker ?action=process 写, csnews-fission 6H cron 读 + 删除)
   */
  PROCESS_STATE?: KVNamespace;
  /**
   * v0.37.51: 双向 Service Binding -> 主 worker (csnews-agent)
   * 让 csnews-fission 6H cron 触发 env.CSNEWS_AGENT.fetch('?action=tavily&max=1')
   * 异 步 Tavily pipeline · 不 受 主 worker 50 subrequest limit 限 制
   */
  CSNEWS_AGENT?: Fetcher;
}

export function getSupabaseHost(env: Env): string {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}
