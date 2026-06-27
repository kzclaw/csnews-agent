// ============================================================
// 鉴权 + CORS
// ============================================================
// 用途：入口看门（每请求先验证身份）+ 跨域头

import { Env, jsonResponse } from './shared';

/**
 * 鉴权中间件：验证 Bearer Token
 * @returns null = 通过 · Response = 拒绝（401）
 */
export function authRequest(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  const encoder = new TextEncoder();
  const expected = encoder.encode(env.BEARER_TOKEN);
  const provided = encoder.encode(token);

  // Length check first to prevent timing leak on length mismatch
  if (expected.length !== provided.length) {
    return jsonResponse({ error: 'Unauthorized' }, {}, { status: 401 });
  }

  // Constant-time comparison to prevent timing attacks
  // timingSafeEqual is part of Web Crypto API (available in CF Workers runtime)
  // TypeScript lib may not include it; cast to bypass incomplete type definition
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  if (!subtle.timingSafeEqual(expected, provided)) {
    return jsonResponse({ error: 'Unauthorized' }, {}, { status: 401 });
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
