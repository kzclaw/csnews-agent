/**
 * CSNEWS Agent · MCP Tool Registry (Definitions + Formatters + Handlers)
 *
 * 从原有 mcp-handler.ts 拆分。包含:
 * - MCP_TOOLS 工具定义数组
 * - 所有 format*AsMarkdown 格式化函数
 * - 所有 toolGet* 异步处理器
 */

import { Env } from './shared';
import { handlePull } from './pull';
import type { MCPTool } from './mcp-types';

// ============================================================
// MCP Tool Definitions
// ============================================================

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
// Markdown Formatters
// ============================================================

export function formatNewsAsMarkdown(items: any[]): string {
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

export function formatTopicsAsMarkdown(items: any[]): string {
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

export function formatWarningsAsMarkdown(items: any[]): string {
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

export function formatTrendsAsMarkdown(items: any[]): string {
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

export function formatTopicAccelerationAsMarkdown(items: any[], topicId: string): string {
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

export function formatDailyReportAsMarkdown(data: any): string {
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

export async function toolGetLatestNews(
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

export async function toolGetExplosiveTopics(
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

export async function toolGetWarnings(
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

export async function toolGetTrendingVelocity(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  const stages = ['hot', 'mature'];
  const allItems: any[] = [];

  for (const stage of stages) {
    const url = new URL('https://placeholder/?action=pull');
    url.searchParams.set('type', 'trends');
    url.searchParams.set('stage', stage);
    url.searchParams.set('order_by', 'velocity');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('limit', String(Math.min(limit, 50)));
    try {
      const result = await handlePull(env, url, ctx);
      allItems.push(...result.items);
    } catch {
      /* skip on error */
    }
  }

  const seen = new Set<string>();
  const unique = allItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  unique.sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  return formatTrendsAsMarkdown(unique.slice(0, limit));
}

export async function toolGetTopicAcceleration(
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

export async function toolGetDailyReport(
  _env: Env,
  _ctx: ExecutionContext,
  _params: Record<string, unknown>
): Promise<string> {
  const report = {
    summary: 'CSNEWS 每日摘要 — 数据来源: CSNEWS Agent',
    note: '详细 stats 类型数据请关注后续版本更新',
  };
  return formatDailyReportAsMarkdown(report);
}
