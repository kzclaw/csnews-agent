/**
 * CSNEWS Fission Worker · 工具函数
 */
export function supabaseHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}
