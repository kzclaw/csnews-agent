// ============================================================
// 鉴权 + CORS（v0.33+sweep·FT-KR0 · Foundation 0 第 1 步 · T000）
// ============================================================
// 用途：入口看门（每请求先验证身份）+ 跨域头
// 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
//       specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}

import { Env } from './shared';

/**
 * 鉴权中间件：验证 Bearer Token
 * @returns null = 通过 · Response = 拒绝（401）
 */
export function authRequest(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (token !== env.BEARER_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
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
