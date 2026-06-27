/**
 * CSNEWS Agent · MCP Server (Stateless HTTP)
 *
 * Cloudflare Workers 实现 MCP Server 必须用 Stateless HTTP 模式（SSE 在 Free Plan
 * 10ms CPU 限制下不可靠）。用户可通过 Claude Desktop / Cursor 等 MCP 客户端直接查询
 * CSNEWS 数据。
 *
 * Endpoint: GET/POST /?action=mcp
 * 认证: Bearer Token（复用 auth.ts 现有中间件）
 * 协议: JSON-RPC 2.0（不含 SSE）
 */

import { Env, jsonResponse } from './shared';
import { handlePull } from './pull';

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

export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'get_latest_news',
    description:
      '获取最新新闻列表，按创建时间倒序返回。可选 limit 限制条数，max_hours 限制时间范围。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
        max_hours: {
          type: 'number',
          description: '只返回最近 N 小时内创建的新闻',
          minimum: 1,
          maximum: 720,
        },
      },
      propertiesJsonSchema: {
        limit: { default: 20 },
        max_hours: { default: 24 },
      },
    },
  },
  {
    name: 'get_explosive_topics',
    description:
      '获取爆炸级（explosive level）话题列表，按分数倒序返回。高分爆炸话题通常意味着大规模传播事件。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: 'get_warnings',
    description: '获取活跃警告列表，支持按严重程度和状态过滤。用于监控系统告警和异常事件。',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          description: '严重程度过滤：critical / high / medium / low',
          enum: ['critical', 'high', 'medium', 'low'],
        },
        status: {
          type: 'string',
          description: '状态过滤：open / acknowledged / validated / dismissed / closed',
          enum: ['open', 'acknowledged', 'validated', 'dismissed', 'closed'],
        },
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: 'get_trending_velocity',
    description:
      '获取趋势速度最快的话题列表（hot + mature 阶段），按速度指标排序。用于发现正在加速传播的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: 'get_topic_acceleration',
    description: '获取指定话题的加速度历史快照，用于分析话题增长速度变化趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: '话题 ID（UUID 格式）',
        },
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'get_daily_report',
    description: '获取每日摘要报告，包含关键指标的日统计数据。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const MCP_TOOLS_COUNT = MCP_TOOLS.length;

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

// ============================================================
// Markdown Formatters
// ============================================================

function formatNewsAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无新闻数据';
  }
  const lines = items.map((item, i) => {
    const title = item.title || '(无标题)';
    const score = item.hot_score ?? item.score ?? '-';
    const category = item.category || '-';
    const source = item.source || '-';
    const time = item.published_at ? new Date(item.published_at).toLocaleString('zh-CN') : '-';
    const level = item.level || '-';
    return `${i + 1}. **${title}**\n   - 热度: ${score} | 分类: ${category} | 来源: ${source} | 级别: ${level} | 时间: ${time}`;
  });
  return `## 最新新闻（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

function formatTopicsAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无话题数据';
  }
  const lines = items.map((item, i) => {
    const key = item.topic_key || '(无标识)';
    const score = item.score ?? '-';
    const level = item.level || '-';
    const lastActive = item.last_active_at
      ? new Date(item.last_active_at).toLocaleString('zh-CN')
      : '-';
    return `${i + 1}. **${key}**\n   - 分数: ${score} | 级别: ${level} | 最后活跃: ${lastActive}`;
  });
  return `## 爆炸级话题（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

function formatWarningsAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无警告数据';
  }
  const lines = items.map((item, i) => {
    const type = item.warning_type || '-';
    const severity = item.severity || '-';
    const status = item.status || '-';
    const reason = item.reason || '-';
    const time = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
    return `${i + 1}. **[${severity.toUpperCase()}] ${type}** (${status})\n   - 原因: ${reason}\n   - 时间: ${time}`;
  });
  return `## 活跃警告（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

function formatTrendsAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无趋势数据';
  }
  const lines = items.map((item, i) => {
    const topicKey = item.topic_key || item.topic_id || '-';
    const score = item.score ?? '-';
    const velocity = item.velocity ?? '-';
    const acceleration = item.acceleration ?? '-';
    const stage = item.stage || '-';
    const time = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
    return `${i + 1}. **${topicKey}**\n   - 分数: ${score} | 速度: ${velocity} | 加速度: ${acceleration} | 阶段: ${stage} | 时间: ${time}`;
  });
  return `## 趋势速度排名（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

function formatTopicAccelerationAsMarkdown(items: any[], topicId: string): string {
  if (!items || items.length === 0) {
    return `暂无话题 ${topicId} 的加速度历史数据`;
  }
  const lines = items.map((item, i) => {
    const score = item.score ?? '-';
    const velocity = item.velocity ?? '-';
    const acceleration = item.acceleration ?? '-';
    const stage = item.stage || '-';
    const time = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '-';
    const arrow = acceleration > 0 ? '📈' : acceleration < 0 ? '📉' : '➖';
    return `${i + 1}. ${arrow} 时间: ${time} | 分数: ${score} | 速度: ${velocity} | 加速度: ${acceleration} | 阶段: ${stage}`;
  });
  return `## 话题加速度分析（${topicId}）（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

function formatDailyReportAsMarkdown(data: any): string {
  const sections: string[] = ['## CSNEWS 每日摘要报告'];

  if (data.summary) {
    sections.push(`\n### 概要\n${data.summary}`);
  }

  if (data.counts) {
    const countsLines = Object.entries(data.counts)
      .map(([k, v]) => `- ${k}: **${v}**`)
      .join('\n');
    sections.push(`\n### 数据统计\n${countsLines}`);
  }

  if (data.topics) {
    sections.push(`\n### 热门话题\n${formatTopicsAsMarkdown(data.topics)}`);
  }

  if (data.news) {
    sections.push(`\n### 最新新闻\n${formatNewsAsMarkdown(data.news)}`);
  }

  return sections.join('\n');
}

// ============================================================
// Tool Handlers
// ============================================================

async function toolGetLatestNews(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'news');
  url.searchParams.set('order_by', 'created_at');
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  if (params.max_hours) {
    const hours = Math.min(Math.max(Number(params.max_hours), 1), 720);
    url.searchParams.set('since', `${hours}h`);
  }

  const result = await handlePull(env, url, ctx);
  return formatNewsAsMarkdown(result.items);
}

async function toolGetExplosiveTopics(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'topics');
  url.searchParams.set('level', 'explosive');
  url.searchParams.set('order_by', 'score');
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  const result = await handlePull(env, url, ctx);
  return formatTopicsAsMarkdown(result.items);
}

async function toolGetWarnings(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'warnings');
  url.searchParams.set('order_by', 'severity');
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  if (params.severity) {
    url.searchParams.set('severity', String(params.severity));
  }
  if (params.status) {
    url.searchParams.set('status', String(params.status));
  }

  const result = await handlePull(env, url, ctx);
  return formatWarningsAsMarkdown(result.items);
}

async function toolGetTrendingVelocity(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  // trends type 查询 trend_snapshots 表，按 velocity 降序
  // stage=hot,mature 是 OR 过滤，PostgREST 不支持 OR，拼两次请求再合并
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  const stages = ['hot', 'mature'];
  const allItems: any[] = [];

  for (const stage of stages) {
    const url = new URL('https://placeholder/?action=pull');
    url.searchParams.set('type', 'trends');
    url.searchParams.set('stage', stage);
    url.searchParams.set('order_by', 'velocity');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('limit', String(Math.min(limit, 50))); // 每次最多 50 条
    try {
      const result = await handlePull(env, url, ctx);
      allItems.push(...result.items);
    } catch {
      /* skip on error */
    }
  }

  // 去重 + 按 velocity 降序重排
  const seen = new Set<string>();
  const unique = allItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  unique.sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  return formatTrendsAsMarkdown(unique.slice(0, limit));
}

async function toolGetTopicAcceleration(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const topicId = params.topic_id as string;
  if (!topicId) {
    throw new Error('topic_id is required');
  }

  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'trends');
  url.searchParams.set('topic_id', topicId);
  url.searchParams.set('order_by', 'created_at');
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  const result = await handlePull(env, url, ctx);
  return formatTopicAccelerationAsMarkdown(result.items, topicId);
}

async function toolGetDailyReport(
  env: Env,
  _ctx: ExecutionContext,
  _params: Record<string, unknown>
): Promise<string> {
  // stats type: 汇总今日关键指标
  // 目前 pull.ts 未定义 stats type，返汇总信息
  const report = {
    summary: 'CSNEWS 每日摘要 — 数据来源: CSNEWS Agent',
    note: '详细 stats 类型数据请关注后续版本更新',
  };
  return formatDailyReportAsMarkdown(report);
}

// ============================================================
// Tool Dispatcher
// ============================================================

const TOOL_HANDLERS: Record<
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

// MCP Protocol methods
async function executeTool(
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

// Standard MCP tools/call handler
async function handleToolsCall(
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

function handleMCPProtocolMethod(req: JSONRPCRequest): {
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
          tools: MCP_TOOLS.map((tool) => ({
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
// JSON-RPC 2.0 Request Parser
// ============================================================

function parseJSONRPCRequest(body: string): JSONRPCRequest | JSONRPCRequest[] | null {
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

function buildSuccessResponse(id: string | number | null, text: string): JSONRPCSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  };
}

function buildErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JSONRPCErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function validateRequest(req: JSONRPCRequest): string | null {
  if (!req.method || typeof req.method !== 'string') {
    return 'method is required and must be a string';
  }
  if (req.params !== undefined && typeof req.params !== 'object') {
    return 'params must be an object if provided';
  }
  return null;
}

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
    // Limit batch size to prevent abuse
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
        } catch (e: any) {
          return buildErrorResponse(
            req.id,
            MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
            e.message || 'Tool execution failed',
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
        buildErrorResponse(null, MCP_ERROR_CODES.INVALID_REQUEST, `Invalid request: ${validationError}`),
        cors,
        { status: 400 }
      );
    }

    try {
      const text = await executeTool(req.method, env, ctx, params(req));
      return jsonResponse(buildSuccessResponse(req.id, text), cors);
    } catch (e: any) {
      return jsonResponse(
        buildErrorResponse(req.id, MCP_ERROR_CODES.TOOL_EXECUTION_ERROR, e.message || 'Tool execution failed', {
          method: req.method,
        }),
        cors
      );
    }
  }

  // Return batch response (always array)
  const statusCode = responses.some((r) => 'error' in r) ? 200 : 200;
  return jsonResponse(isBatch ? responses : responses[0], cors, { status: statusCode });
}

// ============================================================
// Tool Discovery Handler
// ============================================================

export function handleMCPListAction(_request: Request, cors: Record<string, string>): Response {
  return jsonResponse({
    jsonrpc: '2.0',
    id: null,
    result: {
      tools: MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
  }, cors);
}
