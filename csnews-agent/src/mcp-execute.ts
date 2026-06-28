/**
 * CSNEWS Agent · MCP Tool Execution
 *
 * 从原有 mcp-handler.ts 拆分。包含:
 * - TOOL_HANDLERS 注册表
 * - executeTool 执行函数
 * - handleToolsCall (tools/call 端点处理)
 */

import { Env } from './shared';
import { MCP_ERROR_CODES, type JSONRPCRequest, type JSONRPCResponse } from './mcp-types';
import {
  toolGetLatestNews,
  toolGetExplosiveTopics,
  toolGetWarnings,
  toolGetTrendingVelocity,
  toolGetTopicAcceleration,
  toolGetDailyReport,
} from './mcp-tools';

// ============================================================
// Tool Dispatcher
// ============================================================

export const TOOL_HANDLERS: Record<
  string,
  (env: Env, ctx: ExecutionContext, params: Record<string, unknown>) => Promise<string>
> = {
  get_latest_news: toolGetLatestNews,
  get_explosive_topics: toolGetExplosiveTopics,
  get_warnings: toolGetWarnings,
  get_trending_velocity: toolGetTrendingVelocity,
  get_topic_acceleration: toolGetTopicAcceleration,
  get_daily_report: toolGetDailyReport,
};

// ============================================================
// Tool Execution
// ============================================================

export async function executeTool(
  toolName: string,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return handler(env, ctx, params);
}

// ============================================================
// Response Builders
// ============================================================

export function buildSuccessResponse(id: string | number | null, text: string) {
  return {
    jsonrpc: '2.0' as const,
    id,
    result: {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    },
  };
}

export function buildErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

// ============================================================
// Standard MCP tools/call Handler
// ============================================================

export async function handleToolsCall(
  req: JSONRPCRequest,
  env: Env,
  ctx: ExecutionContext
): Promise<JSONRPCResponse> {
  const p = (req.params || {}) as Record<string, unknown>;
  const toolName = p.name as string;
  const toolArgs = (p.arguments || {}) as Record<string, unknown>;

  if (!toolName || typeof toolName !== 'string') {
    return buildErrorResponse(
      req.id,
      MCP_ERROR_CODES.INVALID_PARAMS,
      'Missing or invalid tool name in params.name'
    );
  }

  if (!TOOL_HANDLERS[toolName]) {
    return buildErrorResponse(
      req.id,
      MCP_ERROR_CODES.METHOD_NOT_FOUND,
      `Unknown tool: ${toolName}`
    );
  }

  try {
    const text = await executeTool(toolName, env, ctx, toolArgs);
    return buildSuccessResponse(req.id, text);
  } catch (e: any) {
    return buildErrorResponse(
      req.id,
      MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
      e.message || 'Tool execution failed',
      { tool: toolName }
    );
  }
}
