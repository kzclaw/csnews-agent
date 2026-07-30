/**
 * CSNEWS Agent · MCP Server (Stateless HTTP) — Entry Point
 *
 * Cloudflare Workers 实现 MCP Server 必须用 Stateless HTTP 模式（SSE 在 Free Plan
 * 10ms CPU 限制下不可靠）。用户可通过 Claude Desktop / Cursor 等 MCP 客户端直接查询
 * CSNEWS 数据。
 *
 * Endpoint: GET/POST /?action=mcp
 * 认证: Bearer Token（复用 auth.ts 现有中间件）
 * 协议: JSON-RPC 2.0（不含 SSE）
 *
 * 文件拆分说明（从原有 ~795 行拆分）:
 * - mcp-types.ts    → 共享类型 + MCP_ERROR_CODES 常量
 * - mcp-tools.ts    → MCP_TOOLS 定义 + formatters + toolGet* 处理器
 * - mcp-execute.ts  → TOOL_HANDLERS + executeTool + handleToolsCall
 * - mcp-validate.ts → handleMCPProtocolMethod + parseJSONRPCRequest + validateRequest
 * - mcp-handler.ts  → 入口逻辑（handleMCPAction + handleMCPListAction）
 */

import { Env, jsonResponse } from './shared';
import { MCP_ERROR_CODES, type JSONRPCRequest, type JSONRPCResponse } from './mcp-types';
import { MCP_TOOLS } from './mcp-tools';
import {
  executeTool,
  buildSuccessResponse,
  buildErrorResponse,
  handleToolsCall,
} from './mcp-execute';
import { handleMCPProtocolMethod, parseJSONRPCRequest, validateRequest } from './mcp-validate';

// ============================================================
// Re-export for backward compatibility
// ============================================================

export { MCP_ERROR_CODES } from './mcp-types';
export { MCP_TOOLS } from './mcp-tools';
export type { MCPToolInputSchema, MCPTool } from './mcp-types';

// ============================================================
// Main Handler
// ============================================================

export async function handleMCPAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // Only accept POST (MCP tools write operations)
  if (request.method !== 'POST') {
    return jsonResponse(
      buildErrorResponse(
        null,
        MCP_ERROR_CODES.INVALID_REQUEST,
        'MCP endpoint requires POST method'
      ),
      cors,
      { status: 405, headers: { Allow: 'POST' } }
    );
  }

  // Parse body
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse(
      buildErrorResponse(null, MCP_ERROR_CODES.PARSE_ERROR, 'Failed to read request body'),
      cors,
      { status: 400 }
    );
  }

  if (!bodyText || !bodyText.trim()) {
    return jsonResponse(
      buildErrorResponse(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Request body is empty'),
      cors,
      { status: 400 }
    );
  }

  const parsed = parseJSONRPCRequest(bodyText);
  if (!parsed) {
    return jsonResponse(
      buildErrorResponse(null, MCP_ERROR_CODES.PARSE_ERROR, 'Invalid JSON-RPC 2.0 request'),
      cors,
      { status: 400 }
    );
  }

  const params = (req: JSONRPCRequest) => req.params || {};
  const isBatch = Array.isArray(parsed);

  // Process single or batch requests
  let responses: JSONRPCResponse[];

  if (isBatch) {
    const batch = parsed as JSONRPCRequest[];
    if (batch.length === 0) {
      return jsonResponse(
        buildErrorResponse(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Batch request cannot be empty'),
        cors,
        { status: 400 }
      );
    }
    if (batch.length > 50) {
      return jsonResponse(
        buildErrorResponse(
          null,
          MCP_ERROR_CODES.INVALID_REQUEST,
          'Batch request exceeds maximum of 50 items'
        ),
        cors,
        { status: 400 }
      );
    }

    responses = await Promise.all(
      batch.map(async (req) => {
        const validationError = validateRequest(req);
        if (validationError) {
          return buildErrorResponse(
            req.id,
            MCP_ERROR_CODES.INVALID_REQUEST,
            `Invalid request: ${validationError}`
          );
        }

        // Protocol methods
        const proto = handleMCPProtocolMethod(req);
        if (proto.isProtocol && proto.response) {
          return proto.response as unknown as JSONRPCResponse;
        }

        // Standard MCP tools/call
        if (req.method === 'tools/call') {
          return handleToolsCall(req, env, ctx);
        }

        try {
          const text = await executeTool(req.method, env, ctx, params(req));
          return buildSuccessResponse(req.id, text);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return buildErrorResponse(
            req.id,
            MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
            msg || 'Tool execution failed',
            { method: req.method }
          );
        }
      })
    );
  } else {
    const req = parsed as JSONRPCRequest;

    // Protocol methods
    const proto = handleMCPProtocolMethod(req);
    if (proto.isProtocol && proto.response) {
      return jsonResponse(proto.response, cors);
    }

    // Standard MCP tools/call
    if (req.method === 'tools/call') {
      const response = await handleToolsCall(req, env, ctx);
      return jsonResponse(response, cors);
    }

    const validationError = validateRequest(req);
    if (validationError) {
      return jsonResponse(
        buildErrorResponse(
          null,
          MCP_ERROR_CODES.INVALID_REQUEST,
          `Invalid request: ${validationError}`
        ),
        cors,
        { status: 400 }
      );
    }

    try {
      const text = await executeTool(req.method, env, ctx, params(req));
      return jsonResponse(buildSuccessResponse(req.id, text), cors);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse(
        buildErrorResponse(
          req.id,
          MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
          msg || 'Tool execution failed',
          { method: req.method }
        ),
        cors
      );
    }
  }

  // Return batch response
  return jsonResponse(isBatch ? responses : responses[0], cors, { status: 200 });
}

// ============================================================
// Tool Discovery Handler
// ============================================================

export function handleMCPListAction(_request: Request, cors: Record<string, string>): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: null,
      result: {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    },
    cors
  );
}
