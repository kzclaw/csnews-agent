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
  // RFC 7235: Bearer scheme is case-insensitive
  const token = authHeader?.replace(/^[Bb]earer\s+/i, '') || '';
  const encoder = new TextEncoder();
  const expected = encoder.encode(env.BEARER_TOKEN);
  const provided = encoder.encode(token || '');

  // Constant-time comparison using Web Crypto API (available in CF Workers runtime)
  // Pad both buffers to max length so timingSafeEqual doesn't throw on mismatch
  const maxLen = Math.max(expected.length, provided.length);
  const paddedExpected = new Uint8Array(maxLen);
  const paddedProvided = new Uint8Array(maxLen);
  paddedExpected.set(expected);
  paddedProvided.set(provided);

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  if (!subtle.timingSafeEqual(paddedExpected, paddedProvided)) {
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
