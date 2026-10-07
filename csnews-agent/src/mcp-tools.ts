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
import { checkSupabaseCounts } from './health-db';
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
  // ====== v0.37.97: 补齐 pull 的 fission-reports / entity / knowledge 三类覆盖 ======
  {
    name: 'get_explosive_fission_reports',
    description:
      '获取裂变子系统生成的衍生报告，按触发时间倒序。只有达到裂变阈值（explosive 级别且分数达标）的话题才会产生报告，因此本工具只覆盖「已触发裂变」的那批话题，不含普通新闻。每条返回关联话题标题、裂变类型、状态（completed / failed / pending）、R2 存储键与正文节选（截断至 500 字）。追问某话题被扩写成什么时用它；要看当日原始信号用 get_latest_news 或 get_warnings。',
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
          description: '只返回最近 N 小时内触发的裂变报告',
          minimum: 1,
          maximum: 720,
        },
        topic_id: {
          type: 'string',
          description: '只看指定话题的裂变报告（UUID 格式）',
        },
      },
    },
  },
  {
    name: 'get_entity_profile',
    description:
      '获取实体档案库，覆盖人物 / 机构 / 地点 / 时间 / 概念五类实体，数据来自每日 selflearn 抽取后写入 R2 的实体清单。返回每个实体的跨新闻出现次数、置信度与首次 / 最近出现时间。用于跨新闻聚合视角的问题（哪些机构被反复提及、某人物关联了哪些话题）；看单条新闻内容用 get_latest_news。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
        entity_type: {
          type: 'string',
          description: '实体类型过滤：person / org / place / time / concept',
          enum: ['person', 'org', 'place', 'time', 'concept'],
        },
        order_by: {
          type: 'string',
          description:
            '排序字段：last_seen 最近出现（默认）/ mention_count 出现次数 / confidence 置信度 / first_seen 首次出现',
          enum: ['last_seen', 'mention_count', 'confidence', 'first_seen'],
        },
      },
    },
  },
  {
    name: 'get_knowledge_articles',
    description:
      '获取知识引擎累积的洞察条目。每条由一次已核验的警告经 AI 归纳而成，含置信度、关联话题与警告 ID，洞察全文另存于返回的 R2 键。用于检索「历史上同类信号被总结出的规律」；要看未归纳的原始告警用 get_warnings。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '返回条数上限，默认 20，最大 200',
          minimum: 1,
          maximum: 200,
        },
        topic_id: {
          type: 'string',
          description: '只看指定话题的洞察（UUID 格式）',
        },
        order_by: {
          type: 'string',
          description: '排序字段：created_at 最新优先（默认）/ confidence 置信度优先',
          enum: ['created_at', 'confidence'],
        },
      },
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

/**
 * 长文本截断(报告正文 / 洞察全文可能上千字,MCP 单条响应塞不下)
 * 与 pull.projectFormat 的 summary 截断同风格
 */
function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

function formatLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN') : '-';
}

export function formatFissionReportsAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无裂变报告（fission_reports 表无记录，或过滤条件未命中）';
  }
  const lines = items.map((item, i) => {
    const title = item.title || '(无标题)';
    const excerpt =
      typeof item.report_content === 'string' && item.report_content.trim()
        ? truncateText(item.report_content, 500)
        : '(无正文)';
    return (
      `${i + 1}. **${title}**\n` +
      `   - 类型: ${item.fission_type || '-'} | 状态: ${item.status || '-'} | topic_id: ${item.topic_id || '-'}\n` +
      `   - 触发: ${formatLocalTime(item.triggered_at)} | 完成: ${formatLocalTime(item.completed_at)} | R2: ${item.r2_key || '-'}\n` +
      `   - 报告节选: ${excerpt}`
    );
  });
  return `## 裂变报告（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

export function formatEntitiesAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无实体档案（R2 entity-finalized.json 为空，或过滤条件未命中）';
  }
  const lines = items.map((item, i) => {
    const name = item.name || '(未命名)';
    return (
      `${i + 1}. **${name}** (${item.type || '-'})\n` +
      `   - 出现次数: ${item.news_count ?? '-'} | 置信度: ${item.confidence ?? '-'}\n` +
      `   - 首次出现: ${formatLocalTime(item.first_seen)} | 最近出现: ${formatLocalTime(item.last_seen)}`
    );
  });
  return `## 实体档案（共 ${items.length} 条）\n\n${lines.join('\n')}`;
}

export function formatKnowledgeAsMarkdown(items: any[]): string {
  if (!items || items.length === 0) {
    return '暂无知识条目（knowledge 表无记录，或过滤条件未命中）';
  }
  const lines = items.map((item, i) => {
    const insight =
      typeof item.insight === 'string' && item.insight.trim()
        ? truncateText(item.insight, 500)
        : '(无洞察正文)';
    return (
      `${i + 1}. ${formatLocalTime(item.created_at)} | 置信度: ${item.confidence ?? '-'}\n` +
      `   - topic_id: ${item.topic_id || '-'} | warning_id: ${item.warning_id || '-'}\n` +
      `   - 洞察: ${insight}\n` +
      `   - 全文 R2: ${item.r2_key || '-'}`
    );
  });
  return `## 知识引擎洞察（共 ${items.length} 条）\n\n${lines.join('\n')}`;
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

/**
 * 每日摘要：实查 Supabase 6 张表的行数（复用 health-db 的 checkSupabaseCounts）。
 * 单表失败时如实渲染 `表名: 查询失败: <原因>`，不静默吞错。
 */
export async function toolGetDailyReport(
  env: Env,
  _ctx: ExecutionContext,
  _params: Record<string, unknown>
): Promise<string> {
  const { supabase_counts, checks } = await checkSupabaseCounts(env);
  const entries = Object.entries(supabase_counts);
  const okEntries = entries.filter(([, v]) => typeof v === 'number');
  const totalRows = okEntries.reduce((sum, [, v]) => sum + (v as number), 0);
  const failedTables = entries.filter(([, v]) => typeof v !== 'number').map(([k]) => k);

  const summary =
    okEntries.length === 0
      ? `CSNEWS 每日摘要 — Supabase ${entries.length} 张表全部查询失败（${checks.supabase_reachable.detail}）`
      : `CSNEWS 每日摘要 — Supabase ${okEntries.length}/${entries.length} 张表可读，累计 ${totalRows} 条记录` +
        (failedTables.length > 0 ? `；失败表: ${failedTables.join(', ')}` : '');

  const counts: Record<string, string> = {};
  for (const [table, value] of entries) {
    counts[table] = typeof value === 'number' ? String(value) : `查询失败: ${value.error}`;
  }

  return formatDailyReportAsMarkdown({ summary, counts });
}

/**
 * 裂变报告: pull type=fission-reports
 *
 * 不暴露 status 过滤: fission_reports.status 的 CHECK 约束只有
 * ('completed','failed','pending'),而 parseFilters 用的是 warnings 的 VALID_STATUS
 * (open/acknowledged/validated/dismissed/closed)—— 两个取值集合不相交,
 * 任何一边传过去都会 400 或恒空。真实状态值写进 tool description,让 agent 从输出里读。
 *
 * 不暴露 fission_type 过滤: 它在 TYPE_CONFIG.allowedFilters 里但 parseFilters 从不解析
 * 该参数,传了是静默 no-op(假参数),不如不暴露。
 */
export async function toolGetFissionReports(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'fission-reports');
  url.searchParams.set('order_by', 'triggered_at');
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  if (params.max_hours) {
    const hours = Math.min(Math.max(Number(params.max_hours), 1), 720);
    url.searchParams.set('since', `${hours}h`);
  }
  if (params.topic_id) {
    url.searchParams.set('topic_id', String(params.topic_id));
  }

  const result = await handlePull(env, url, ctx);
  return formatFissionReportsAsMarkdown(result.items);
}

/**
 * 实体档案: pull type=entity(R2 entity-finalized.json,非 Supabase)
 *
 * 类型过滤走 category 参数: TYPE_CONFIG.entity.allowedFilters 列的是 'type',
 * 但 parseFilters 只对白名单里的 level / category 做解析,queryEntity 也只读
 * filters.category —— 所以 MCP 侧命名 entity_type,实际写进 category。
 */
export async function toolGetEntityProfile(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'entity');
  url.searchParams.set(
    'order_by',
    typeof params.order_by === 'string' ? params.order_by : 'last_seen'
  );
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  if (params.entity_type) {
    url.searchParams.set('category', String(params.entity_type));
  }

  const result = await handlePull(env, url, ctx);
  return formatEntitiesAsMarkdown(result.items);
}

/**
 * 知识引擎洞察: pull type=knowledge(Supabase knowledge 表)
 */
export async function toolGetKnowledgeArticles(
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL('https://placeholder/?action=pull');
  url.searchParams.set('type', 'knowledge');
  url.searchParams.set(
    'order_by',
    typeof params.order_by === 'string' ? params.order_by : 'created_at'
  );
  url.searchParams.set('order', 'desc');
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  url.searchParams.set('limit', String(limit));

  if (params.topic_id) {
    url.searchParams.set('topic_id', String(params.topic_id));
  }

  const result = await handlePull(env, url, ctx);
  return formatKnowledgeAsMarkdown(result.items);
}
