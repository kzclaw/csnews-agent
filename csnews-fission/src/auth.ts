// ============================================================
// 鉴权 + CORS
// ============================================================
// 用途：入口看门（每请求先验证身份）+ 跨域头

import { Env } from './shared';

/** 401 响应（fission 侧构造风格，不用主 Worker 的 jsonResponse） */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 鉴权中间件：验证 Bearer Token
 *
 * fail-closed：BEARER_TOKEN 未配置（undefined / 空串）时一律 401。
 * 缺配置时 expected 会退化成空 buffer，与「客户端也传了空 token」比较同样得 true，
 * 等于整个 Worker 无鉴权对外开放。配置缺失必须拒绝一切，而不是默认放行。
 *
 * 时序安全：两侧先各做一次 SHA-256 得到定长 32 字节，再交给 timingSafeEqual 比较。
 * 旧实现遇到长度不等就直接早退返回 401，连等长比较的耗时不走，响应时间的拐点
 * 恰落在真实 token 长度上，可被逐位试探反推。哈希后两侧定长，比较分支不再
 * 依赖任何一方（尤其是服务端）的输入长度。
 *
 * @returns null = 通过 · Response = 拒绝（401）
 */
export async function authRequest(request: Request, env: Env): Promise<Response | null> {
  // fail-closed：配置缺失时拒绝一切（放在最前面，NO_AUTH_ACTIONS 由调用方在此之前 return，不受影响）
  if (!env.BEARER_TOKEN) {
    return unauthorized();
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return unauthorized();
  }
  const encoder = new TextEncoder();

  // 两侧同时哈希：比较用的是定长 32 字节，不泄漏服务端 token 的长度
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(env.BEARER_TOKEN)),
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
  ]);

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  if (!subtle.timingSafeEqual(new Uint8Array(expectedHash), new Uint8Array(providedHash))) {
    return unauthorized();
  }
  return null;
}

/**
 * CORS 头（支持 preflight OPTIONS）
 */
export function corsHeaders(origin?: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
