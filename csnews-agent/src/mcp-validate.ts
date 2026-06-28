/**
 * CSNEWS Agent · MCP Validation & Protocol
 *
 * 从原有 mcp-handler.ts 拆分。包含:
 * - handleMCPProtocolMethod (initialize / ping / tools/list 等协议方法)
 * - parseJSONRPCRequest (JSON-RPC 请求解析)
 * - validateRequest (请求格式校验)
 */

import { MCP_TOOLS } from './mcp-tools';
import { type MCPTool, type JSONRPCRequest } from './mcp-types';

// ============================================================
// MCP Protocol Methods Handler
// ============================================================

export function handleMCPProtocolMethod(req: JSONRPCRequest): {
  isProtocol: boolean;
  response?: Record<string, unknown>;
} {
  const { method, params, id } = req;
  if (method === 'initialize') {
    const p = (params || {}) as Record<string, unknown>;
    return {
      isProtocol: true,
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (p.protocolVersion as string) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'csnews', version: '1.0.0' },
        },
      },
    };
  }
  if (method === 'ping' || method === 'notifications/initialized') {
    return { isProtocol: true, response: { jsonrpc: '2.0', id, result: null } };
  }
  if (method === 'tools/list') {
    return {
      isProtocol: true,
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS.map((tool: MCPTool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      },
    };
  }
  return { isProtocol: false };
}

// ============================================================
// JSON-RPC Request Parser
// ============================================================

export function parseJSONRPCRequest(body: string): JSONRPCRequest | JSONRPCRequest[] | null {
  try {
    const parsed = JSON.parse(body);
    // Batch request
    if (Array.isArray(parsed)) {
      return parsed as JSONRPCRequest[];
    }
    // Single request
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.jsonrpc === '2.0' &&
      typeof parsed.method === 'string'
    ) {
      return parsed as JSONRPCRequest;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Request Validation
// ============================================================

export function validateRequest(req: JSONRPCRequest): string | null {
  if (!req.method || typeof req.method !== 'string') {
    return 'method is required and must be a string';
  }
  if (req.params !== undefined && typeof req.params !== 'object') {
    return 'params must be an object if provided';
  }
  return null;
}
