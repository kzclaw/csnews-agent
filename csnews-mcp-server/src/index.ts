/**
 * CSNEWS MCP Server — stdio 本地代理
 *
 * Claude Desktop / Cursor 通过 stdio 协议连接此服务，
 * 此服务再将请求转发到 CSNEWS Worker 的 HTTP JSON-RPC 端点。
 *
 * 环境变量:
 *   CSNEWS_URL    — Worker URL，如 https://csnews.kwokzit.info/api/v1
 *   CSNEWS_TOKEN  — Bearer Token
 *
 * 运行:
 *   npx tsx src/index.ts
 *   或 npm run build && npm start
 */

import { Server } from '@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/dist/esm/types.js';

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
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
          default: 20,
        },
        max_hours: {
          type: 'number',
          description: '只返回最近 N 小时内创建的新闻',
          minimum: 1,
          maximum: 720,
          default: 24,
        },
      },
    },
  },
  {
    name: 'get_explosive_topics',
    description: '获取爆炸级（explosive level）话题列表，按分数倒序返回。高分爆炸话题通常意味着大规模传播事件。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
          default: 20,
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
          default: 20,
        },
      },
    },
  },
  {
    name: 'get_trending_velocity',
    description: '获取趋势速度最快的话题列表（hot + mature 阶段），按速度指标排序。用于发现正在加速传播的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
          default: 20,
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
          default: 20,
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

// ============================================================
// MCP Server 初始化
// ============================================================
const server = new Server(
  {
    name: 'csnews',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出所有工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// 调用工具
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (!CSNEWS_TOKEN) {
    return {
      content: [
        {
          type: 'text',
          text: '❌ 错误: 未设置 CSNEWS_TOKEN 环境变量。\n\n请先设置: export CSNEWS_TOKEN=你的token',
        },
      ],
      isError: true,
    };
  }

  try {
    const url = `${CSNEWS_URL}/?action=mcp`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: name,
      params: args,
    });

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
      return {
        content: [
          {
            type: 'text',
            text: `❌ HTTP 错误 ${res.status}: ${JSON.stringify(data)}`,
          },
        ],
        isError: true,
      };
    }

    // JSON-RPC 错误
    if (data.error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ MCP 错误 [${data.error.code}]: ${data.error.message}`,
          },
        ],
        isError: true,
      };
    }

    // 成功
    const text = data.result?.content?.[0]?.text || JSON.stringify(data, null, 2);
    return {
      content: [{ type: 'text', text }],
    };
  } catch (e: any) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 网络错误: ${e.message}\n\n请检查:\n1. CSNEWS Worker 是否在线\n2. CSNEWS_TOKEN 是否正确\n3. CSNEWS_URL 是否正确 (当前: ${CSNEWS_URL})`,
        },
      ],
      isError: true,
    };
  }
});

// ============================================================
// 启动
// ============================================================
async function main() {
  if (!CSNEWS_TOKEN) {
    console.warn('⚠️  警告: 未设置 CSNEWS_TOKEN 环境变量');
    console.warn('    运行命令: export CSNEWS_TOKEN=你的token');
    console.warn('');
  }
  console.warn(`📡 CSNEWS MCP Server 启动中...`);
  console.warn(`   URL: ${CSNEWS_URL}`);
  console.warn(`   Token: ${CSNEWS_TOKEN ? '✅ 已设置' : '❌ 未设置'}`);
  console.warn('');

  const transport = await server.connect();
  // 保持进程运行
  transport.onclose = () => {
    console.warn('MCP 连接已关闭');
    process.exit(0);
  };
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
