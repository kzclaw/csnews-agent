/**
 * CSNEWS Agent · MCP Types (Shared)
 *
 * 所有 MCP 子模块共享的类型定义和常量。
 * 从原有 mcp-handler.ts 拆分出来，独立维护。
 */

// ============================================================
// MCP Tool Definitions (Anthropic MCP Schema)
// ============================================================

export interface MCPToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  propertiesJsonSchema?: Record<string, unknown>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
}

// ============================================================
// JSON-RPC 2.0 Types
// ============================================================

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
}

export interface JSONRPCErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;

// ============================================================
// MCP Error Codes (JSON-RPC 2.0 Extension)
// ============================================================

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_EXECUTION_ERROR: -32000,
} as const;
