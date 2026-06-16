/**
 * CSNEWS Agent · 主 Worker 入口分派 (v0.36.10 · KR0 · Foundation 0 第 1 步)
 *
 * 唯一目标：守住"16 action dispatch 路由表就是这样"（业务契约）
 *
 * v0.33 确定 Foundation 0 第 1 步: index.ts 拆模块化
 *   - 16 个 handler 已抽到 src/endpoints.ts (v0.33+sweep)
 *   - 调度逻辑 (CORS + auth + dispatch) 抽到本文件
 *   - scheduled handler 抽到 src/scheduled.ts
 *
 * 业务红线:
 *   - action 默认 'ping' (空 action = 健康检查, 不返 400)
 *   - unknown action 返 400 + { error: "unknown action" }
 *   - dispatcher log 用 ctx.waitUntil 异步持久化 (fire-and-forget, R2 失败不阻塞)
 *   - CORS 头复用 auth.ts corsHeaders() (跟 endpoints.ts 模式一致)
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */

import { Env } from './shared';
import { corsHeaders } from './auth';
import { logEvent } from './log';
import {
  handlePullAction, handleDiagAction, handlePingAction,
  handleModelTestAction, handleAiTestAction,
  handleScoreAction, handleClassifyAction, handleBatchScoreAction,
  handleFissionAction, handleSaveAction, handleListAction,
  handleEmbedAction, handleZakerHotAction,
  handleProcessAction, handleHealthAction, handleLogsAction,
  handleContentAction, handleTrendAction, handleKnowledgeAction,
  handleEntityAction, handleEventAction,
} from './endpoints';

/**
 * 16 个支持 action（白名单）
 * 加新 action 时: ALLOWED_ACTIONS 加 + 此文件 describe 块补 1 个 it
 * 详见：tasks/csnews-agent-okr.md KR0
 */
export const ALLOWED_ACTIONS = [
  'pull', 'diag', 'ping', 'model-test', 'ai-test',
  'score', 'classify', 'batch-score',
  'fission', 'save', 'list', 'embed', 'zaker-hot',
  'process', 'health', 'logs',
  'content', 'trend', 'knowledge',
  'entity', 'event',
] as const;
export type Action = typeof ALLOWED_ACTIONS[number];

/**
 * 默认 action (空 action 时的 fallback, v0.33 确定 'ping' = 健康检查)
 */
export const DEFAULT_ACTION: Action = 'ping';

/**
 * CORS preflight (OPTIONS) 响应
 * v0.33 确定: 所有 endpoint 统一 OPTIONS 处理
 */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin');
    return new Response(null, { headers: corsHeaders(origin) });
  }
  return null;
}

/**
 * 调度 16 action 到对应 handler
 *
 * @returns handler 返回的 Response (unknown action 返 400)
 */
export async function dispatchAction(
  env: Env,
  ctx: ExecutionContext,
  action: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);

  // 写一条 endpoint-level log (fire-and-forget with ctx.waitUntil so R2 put completes)
  ctx.waitUntil(logEvent(env, "info", "endpoint called", { endpoint: action, method: request.method }, "dispatcher").catch(() => {}));

  // 16 action dispatch
  if (action === 'pull') return await handlePullAction(request, env, url, cors);
  if (action === 'diag') return await handleDiagAction(request, env, url, cors);
  if (action === 'ping') return await handlePingAction(request, env, url, cors);
  if (action === 'model-test') return await handleModelTestAction(request, env, url, cors);
  if (action === 'ai-test') return await handleAiTestAction(request, env, url, cors);
  if (action === 'score') return await handleScoreAction(request, env, url, cors);
  if (action === 'classify') return await handleClassifyAction(request, env, url, cors);
  if (action === 'batch-score') return await handleBatchScoreAction(request, env, url, cors);
  if (action === 'fission') return await handleFissionAction(request, env, url, cors);
  if (action === 'save') return await handleSaveAction(request, env, url, cors);
  if (action === 'list') return await handleListAction(request, env, url, cors);
  if (action === 'embed') return await handleEmbedAction(request, env, url, cors);
  if (action === 'zaker-hot') return await handleZakerHotAction(request, env, url, cors);
  if (action === 'process') return await handleProcessAction(request, env, url, cors, ctx);
  if (action === 'health') return await handleHealthAction(request, env, url, cors);
  if (action === 'logs') return await handleLogsAction(request, env, url, cors);
  if (action === 'content') return await handleContentAction(request, env, url, cors, ctx);
  if (action === 'trend') return await handleTrendAction(request, env, url, cors, ctx);
  if (action === 'knowledge') return await handleKnowledgeAction(request, env, url, cors, ctx);
  if (action === 'entity') return await handleEntityAction(request, env, url, cors, ctx);
  if (action === 'event') return await handleEventAction(request, env, url, cors, ctx);

  // unknown action
  return new Response(JSON.stringify({ error: 'unknown action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
