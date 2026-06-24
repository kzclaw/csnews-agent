/**
 * CSNEWS MCP Server — stdio 本地代理 (CommonJS)
 *
 * Claude Desktop / Cursor 通过 stdio 协议连接此服务，
 * 此服务再将请求转发到 CSNEWS Worker 的 HTTP JSON-RPC 端点。
 *
 * 环境变量:
 *   CSNEWS_URL    — Worker URL，如 https://csnews.kwokzit.info/api/v1
 *   CSNEWS_TOKEN  — Bearer Token
 *
 * 运行:
 *   node src/index.cjs
 */

const CSNEWS_URL = (process.env.CSNEWS_URL || 'https://csnews.kwokzit.info/api/v1').replace(/\/$/, '');
const CSNEWS_TOKEN = process.env.CSNEWS_TOKEN || '';

// ============================================================
// 工具列表
// ============================================================
const TOOLS = [
  {
    name: 'get_latest_news',
    description: '获取最新新闻列表，按创建时间倒序返回。包含标题、热度、分类、来源、级别、时间。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 200', minimum: 1, maximum: 200, default: 20 },
        max_hours: { type: 'number', description: '只返回最近 N 小时内创建的新闻', minimum: 1, maximum: 720, default: 24 },
      },
    },
  },
  {
    name: 'get_explosive_topics',
    description: '获取爆炸级（explosive level）话题列表，按分数倒序返回。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 200', minimum: 1, maximum: 200, default: 20 },
      },
    },
  },
  {
    name: 'get_warnings',
    description: '获取活跃警告列表，支持按严重程度和状态过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'critical / high / medium / low', enum: ['critical', 'high', 'medium', 'low'] },
        status: { type: 'string', description: 'open / acknowledged / validated / dismissed / closed', enum: ['open', 'acknowledged', 'validated', 'dismissed', 'closed'] },
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 200', minimum: 1, maximum: 200, default: 20 },
      },
    },
  },
  {
    name: 'get_trending_velocity',
    description: '获取趋势速度最快的话题列表（hot + mature 阶段），按速度指标排序。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 200', minimum: 1, maximum: 200, default: 20 },
      },
    },
  },
  {
    name: 'get_topic_acceleration',
    description: '获取指定话题的加速度历史快照，用于分析话题增长速度变化趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: '话题 ID（UUID 格式）' },
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 200', minimum: 1, maximum: 200, default: 20 },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'get_daily_report',
    description: '获取每日摘要报告，包含关键指标的日统计数据。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ============================================================
// MCP JSON-RPC 处理
// ============================================================

async function handleJSONRPC(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0' || !method) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  const handler = TOOL_HANDLERS[method];
  if (!handler) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  try {
    const text = await handler(params || {});
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }] },
    };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
  }
}

async function handleTool(name, params) {
  const url = `${CSNEWS_URL}/?action=mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: name, params });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CSNEWS_TOKEN}`,
    },
    body,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }

  if (data.error) {
    throw new Error(`[${data.error.code}] ${data.error.message}`);
  }

  return data.result?.content?.[0]?.text || JSON.stringify(data, null, 2);
}

const TOOL_HANDLERS = {
  get_latest_news: (params) => handleTool('get_latest_news', params),
  get_explosive_topics: (params) => handleTool('get_explosive_topics', params),
  get_warnings: (params) => handleTool('get_warnings', params),
  get_trending_velocity: (params) => handleTool('get_trending_velocity', params),
  get_topic_acceleration: (params) => handleTool('get_topic_acceleration', params),
  get_daily_report: (params) => handleTool('get_daily_report', params),
};

// ============================================================
// MCP Protocol — stdio 循环
// ============================================================

let requestId = 0;

process.stdin.setEncoding('utf8');

let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  // 尝试解析每行 JSON
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);

      // listTools
      if (request.method === 'initialize' || (request.method === 'tools/list' && request.jsonrpc === '2.0')) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: TOOLS },
        }) + '\n');
        continue;
      }

      // notifications/ping
      if (request.method === 'ping' || request.method === 'notifications/initialized') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\n');
        continue;
      }

      // tools/call
      if (request.method === 'tools/call') {
        const { name, arguments: args = {} } = request.params;

        if (!CSNEWS_TOKEN) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: { content: [{ type: 'text', text: '❌ 未设置 CSNEWS_TOKEN 环境变量' }], isError: true },
          }) + '\n');
          continue;
        }

        try {
          const text = await handleTool(name, args);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: { content: [{ type: 'text', text }] },
          }) + '\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true },
          }) + '\n');
        }
        continue;
      }

      // 其他 method → listTools 兼容
      const response = await handleJSONRPC(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e) {
      process.stderr.write(`[CSNEWS MCP] 解析错误: ${e.message}\n`);
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

// 启动提示
process.stderr.write(`📡 CSNEWS MCP Server 启动\n`);
process.stderr.write(`   URL: ${CSNEWS_URL}\n`);
process.stderr.write(`   Token: ${CSNEWS_TOKEN ? '✅ 已设置' : '❌ 未设置'}\n`);
if (!CSNEWS_TOKEN) {
  process.stderr.write(`\n⚠️  请先设置环境变量:\n`);
  process.stderr.write(`   export CSNEWS_TOKEN=你的token\n`);
}
process.stderr.write(`\n`);
