/**
 * CSNEWS Agent · 消费面通用 pull 端点（v0.31）
 *
 * 端点：GET /?action=pull
 * 设计原则：架构接口统一 / 模块化可复用可扩展通用性 / 最少扰动 / 不增熵
 *
 * 4 个 type(v0.31 阶段):news / topics / warnings / fission-pending
 * 2 个 type(v0.32 阶段):trends / stats
 *
 * 通用参数:limit / order / order_by / since / until / level / category /
 *           topic_id / status / stage / fission_triggered / select / format
 */

import { Env, supabaseFetch, safeJson } from './shared';
import {
  cacheGet,
  cacheSet,
  makeCacheKey,
  DEFAULT_TTL_SECONDS,
  isNegativeSentinel,
  setNegativeSentinel,
  clearNegativeSentinel,
} from './cache';
import type { NewsHotspotRow, PullTopicRow } from './types';

// ====== Type 白名单配置(v0.31) ======

export interface TypeConfig {
  /** Supabase 表名 */
  table: string;
  /** 默认 order_by 字段 */
  defaultOrderBy: string;
  /** 允许的 order_by 字段白名单 */
  allowedOrderBy: string[];
  /** 默认 select 字段(format=summary) */
  defaultSelect: string;
  /** 允许的 filter 参数白名单 */
  allowedFilters: string[];
  /** 时间窗过滤字段(默认 created_at) */
  timeField: string;
}

export const TYPE_CONFIG: Record<string, TypeConfig> = {
  news: {
    table: 'news_hotspots',
    defaultOrderBy: 'created_at',
    allowedOrderBy: ['created_at', 'published_at', 'hot_score', 'score', 'updated_at'],
    defaultSelect:
      'id, title, url, source, category, hot_score, published_at, summary, topic_id, level, score, is_stored_r2, created_at, updated_at',
    // fission_triggered 字段在 news_hotspots 表里没有,改走 fission-pending(type=news 的裂变标记需求 v0.32 加 migration)
    // stage 字段在 news_hotspots 表里没有,stage 只该在 trends 上用
    allowedFilters: ['level', 'category', 'topic_id', 'title_like'],
    timeField: 'created_at',
  },
  topics: {
    table: 'topics',
    defaultOrderBy: 'score',
    allowedOrderBy: ['score', 'last_active_at', 'created_at', 'updated_at'],
    defaultSelect:
      'id, topic_key, level, score, last_active_at, first_news_id, created_at, updated_at',
    allowedFilters: ['level'],
    timeField: 'created_at',
  },
  warnings: {
    table: 'warnings',
    defaultOrderBy: 'severity',
    allowedOrderBy: ['created_at', 'severity', 'updated_at'],
    defaultSelect:
      'id, topic_id, snapshot_id, warning_type, severity, reason, status, report_r2_key, validated, validated_at, created_at, updated_at',
    allowedFilters: ['status', 'topic_id', 'level'],
    timeField: 'created_at',
  },
  // fission-pending 是衍生视图:从 topics 拉 level='explosive' AND score>=6
  // 不直接查表,改走 SQL 拼装(白名单安全,无注入风险)
  'fission-pending': {
    table: 'topics',
    defaultOrderBy: 'score',
    allowedOrderBy: ['score', 'last_active_at'],
    defaultSelect:
      'id, topic_key, level, score, last_active_at, first_news_id, created_at, updated_at',
    allowedFilters: [],
    timeField: 'created_at',
  },
  // trends: 趋势快照查询 trend_snapshots 表,用于 get_trending_velocity 和 get_topic_acceleration
  trends: {
    table: 'trend_snapshots',
    defaultOrderBy: 'velocity',
    allowedOrderBy: ['velocity', 'acceleration', 'score', 'created_at'],
    defaultSelect: 'id, topic_id, score, velocity, acceleration, stage, created_at',
    allowedFilters: ['topic_id'],
    timeField: 'created_at',
  },
  // stats: 统计汇总视图,查询 news_hotspots / topics / warnings 各表 count
  stats: {
    table: 'news_hotspots',
    defaultOrderBy: 'created_at',
    allowedOrderBy: ['created_at'],
    defaultSelect: 'id, created_at',
    allowedFilters: [],
    timeField: 'created_at',
  },
};

// ====== format 三档投影 ======

export type Format = 'ids' | 'summary' | 'full';

export interface PullResponse {
  type: string;
  count: number;
  total: number;
  truncated: boolean;
  filters: Record<string, any>;
  items: any[];
}

/**
 * 按 format 投影 items
 * - ids: 只保留 id
 * - summary: 截断 summary 字段到 200 字,其他保留
 * - full: 完整字段(但仍排除 embedding 大字段)
 */
function projectFormat(items: any[], format: Format): any[] {
  if (format === 'ids') {
    return items.map((item) => ({ id: item.id }));
  }
  if (format === 'summary') {
    return items.map((item) => {
      const { embedding, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars
      if (rest.summary && typeof rest.summary === 'string' && rest.summary.length > 200) {
        rest.summary = rest.summary.slice(0, 200) + '…';
      }
      return rest;
    });
  }
  // full: 排除 embedding(太大,没意义)
  return items.map((item) => {
    const { embedding, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  });
}

// ====== 参数解析 ======

export interface ParsedFilters {
  type: string;
  limit: number;
  offset?: number; // 分页 offset (v0.36.10.3 viewer 全量拉取用)
  order: 'asc' | 'desc';
  orderBy: string;
  since?: string; // ISO 8601
  until?: string;
  level?: string;
  category?: string;
  topicId?: string;
  status?: string;
  stage?: string;
  fissionTriggered?: boolean;
  titleLike?: string;
  select?: string;
  format: Format;
}

export const VALID_LEVELS = ['follow', 'important', 'explosive'];
export const VALID_STATUS = ['open', 'acknowledged', 'validated', 'dismissed', 'closed'];
export const VALID_STAGES = ['emerging', 'growing', 'hot', 'mature', 'declining'];

// Add stage to trends filters
TYPE_CONFIG.trends.allowedFilters.push('stage');
export const VALID_FORMATS: Format[] = ['ids', 'summary', 'full'];

/**
 * 解析相对时间(24h / 7d / 30m)为 ISO 8601
 */
function resolveRelativeTime(rel: string): string | null {
  const m = rel.match(/^(\d+)([mhd])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const now = Date.now();
  const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
  return new Date(now - ms).toISOString();
}

export function parseFilters(
  url: URL
): { ok: true; filters: ParsedFilters } | { ok: false; error: string } {
  const type = url.searchParams.get('type') || '';
  if (!type) {
    return {
      ok: false,
      error: 'missing type param. Valid: ' + Object.keys(TYPE_CONFIG).join(', '),
    };
  }
  if (!TYPE_CONFIG[type]) {
    return {
      ok: false,
      error: `unknown type: ${type}. Valid: ${Object.keys(TYPE_CONFIG).join(', ')}`,
    };
  }

  const config = TYPE_CONFIG[type];

  // limit
  const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  if (isNaN(rawLimit) || rawLimit < 1) {
    return { ok: false, error: 'limit must be a positive integer' };
  }
  if (rawLimit > 200) {
    return { ok: false, error: 'limit exceeds maximum 200' };
  }
  const limit = rawLimit;

  // offset (v0.36.10.3 viewer 全量分页用, 默认 0)
  const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (isNaN(rawOffset) || rawOffset < 0) {
    return { ok: false, error: 'offset must be a non-negative integer' };
  }
  const offset = rawOffset;

  // order
  const order = (url.searchParams.get('order') || 'desc').toLowerCase();
  if (order !== 'asc' && order !== 'desc') {
    return { ok: false, error: 'order must be asc or desc' };
  }

  // order_by
  const orderBy = url.searchParams.get('order_by') || config.defaultOrderBy;
  if (!config.allowedOrderBy.includes(orderBy)) {
    return {
      ok: false,
      error: `order_by ${orderBy} not allowed for type=${type}. Valid: ${config.allowedOrderBy.join(', ')}`,
    };
  }

  // time window
  let since: string | undefined;
  let until: string | undefined;
  const sinceRaw = url.searchParams.get('since');
  if (sinceRaw) {
    const resolved = /^\d+[mhd]$/.test(sinceRaw) ? resolveRelativeTime(sinceRaw) : sinceRaw;
    if (!resolved || isNaN(Date.parse(resolved))) {
      return { ok: false, error: 'since must be ISO 8601 or relative like 24h/7d/30m' };
    }
    since = new Date(resolved).toISOString();
  }
  const untilRaw = url.searchParams.get('until');
  if (untilRaw) {
    const resolved = /^\d+[mhd]$/.test(untilRaw) ? resolveRelativeTime(untilRaw) : untilRaw;
    if (!resolved || isNaN(Date.parse(resolved))) {
      return { ok: false, error: 'until must be ISO 8601 or relative like 24h/7d/30m' };
    }
    until = new Date(resolved).toISOString();
  }

  // filters (按 type 白名单校验)
  const filters: ParsedFilters = {
    type,
    limit,
    offset,
    order: order as 'asc' | 'desc',
    orderBy,
    since,
    until,
    format: 'summary',
  };

  if (config.allowedFilters.includes('level')) {
    const level = url.searchParams.get('level');
    if (level) {
      if (!VALID_LEVELS.includes(level)) {
        return { ok: false, error: `level must be one of ${VALID_LEVELS.join(', ')}` };
      }
      filters.level = level;
    }
  }

  if (config.allowedFilters.includes('category')) {
    const category = url.searchParams.get('category');
    if (category) filters.category = category;
  }

  if (config.allowedFilters.includes('topic_id')) {
    const topicId = url.searchParams.get('topic_id');
    if (topicId) {
      // UUID 格式校验
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
        return { ok: false, error: 'topic_id must be a valid UUID' };
      }
      filters.topicId = topicId;
    }
  }

  if (config.allowedFilters.includes('status')) {
    const status = url.searchParams.get('status');
    if (status) {
      if (!VALID_STATUS.includes(status)) {
        return { ok: false, error: `status must be one of ${VALID_STATUS.join(', ')}` };
      }
      filters.status = status;
    }
  }

  if (config.allowedFilters.includes('stage')) {
    const stage = url.searchParams.get('stage');
    if (stage) {
      if (!VALID_STAGES.includes(stage)) {
        return { ok: false, error: `stage must be one of ${VALID_STAGES.join(', ')}` };
      }
      filters.stage = stage;
    }
  }

  if (config.allowedFilters.includes('fission_triggered')) {
    const ft = url.searchParams.get('fission_triggered');
    if (ft === 'true') filters.fissionTriggered = true;
    else if (ft === 'false') filters.fissionTriggered = false;
  }

  if (config.allowedFilters.includes('title_like')) {
    const titleLike = url.searchParams.get('title_like');
    if (titleLike) {
      // 长度限制 + 危险字符过滤
      if (titleLike.length > 100) {
        return { ok: false, error: 'title_like max 100 chars' };
      }
      filters.titleLike = titleLike;
    }
  }

  // select
  const selectRaw = url.searchParams.get('select');
  if (selectRaw) {
    const fields = selectRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // 简单白名单: 必须是 config.defaultSelect 列表的子集(防泄漏未知字段)
    const allowedFields = new Set(config.defaultSelect.split(',').map((s) => s.trim()));
    for (const f of fields) {
      if (!allowedFields.has(f)) {
        return {
          ok: false,
          error: `select field '${f}' not allowed. Valid: ${[...allowedFields].join(', ')}`,
        };
      }
    }
    filters.select = fields.join(',');
  }

  // format
  const format = (url.searchParams.get('format') || 'summary').toLowerCase();
  if (!VALID_FORMATS.includes(format as Format)) {
    return { ok: false, error: `format must be one of ${VALID_FORMATS.join(', ')}` };
  }
  filters.format = format as Format;

  return { ok: true, filters };
}

// ====== PostgREST 查询构造器(白名单 + 参数化) ======

function buildPostgRestQuery(filters: ParsedFilters): string {
  const config = TYPE_CONFIG[filters.type];
  const params: string[] = [];

  // select
  const select = filters.select || config.defaultSelect;
  params.push(`select=${encodeURIComponent(select)}`);

  // order
  params.push(`order=${encodeURIComponent(filters.orderBy + '.' + filters.order)}`);

  // limit
  params.push(`limit=${filters.limit}`);

  // offset (v0.36.10.3 viewer 全量分页用)
  if (filters.offset && filters.offset > 0) {
    params.push(`offset=${filters.offset}`);
  }

  // time window
  if (filters.since) {
    params.push(`${config.timeField}=gte.${encodeURIComponent(filters.since)}`);
  }
  if (filters.until) {
    params.push(`${config.timeField}=lte.${encodeURIComponent(filters.until)}`);
  }

  // 通用 filters
  if (filters.level) {
    params.push(`level=eq.${encodeURIComponent(filters.level)}`);
  }
  if (filters.category) {
    params.push(`category=eq.${encodeURIComponent(filters.category)}`);
  }
  if (filters.topicId) {
    params.push(`topic_id=eq.${encodeURIComponent(filters.topicId)}`);
  }
  if (filters.status) {
    params.push(`status=eq.${encodeURIComponent(filters.status)}`);
  }
  if (filters.stage) {
    params.push(`stage=eq.${encodeURIComponent(filters.stage)}`);
  }
  if (filters.fissionTriggered !== undefined) {
    params.push(`fission_triggered=eq.${filters.fissionTriggered}`);
  }
  if (filters.titleLike) {
    // PostgREST ilike 用 % 通配符 (不用 *), 修复 audit 4.4 bug
    // ilike = case-insensitive like; % 是通配符(已 encode)
    params.push(`title=ilike.${encodeURIComponent('%' + filters.titleLike + '%')}`);
  }

  return params.join('&');
}

// ====== fission-pending 特殊处理(衍生视图) ======

/**
 * fission-pending 实际是 topics 满足条件:level='explosive' AND score>=6
 * 用 RPC 暴露更安全(避免拼 Or/And)
 */
async function queryFissionPending(
  env: Env,
  filters: ParsedFilters
): Promise<{ items: any[]; total: number }> {
  const config = TYPE_CONFIG['fission-pending'];

  // 用 PostgREST 查询 topics,加 level=eq.explosive 过滤
  const params: string[] = [];
  const select = filters.select || config.defaultSelect;
  params.push(`select=${encodeURIComponent(select)}`);
  params.push(`order=${encodeURIComponent(filters.orderBy + '.' + filters.order)}`);
  params.push(`limit=${filters.limit}`);
  params.push(`level=eq.explosive`);

  // time window
  if (filters.since) {
    params.push(`${config.timeField}=gte.${encodeURIComponent(filters.since)}`);
  }
  if (filters.until) {
    params.push(`${config.timeField}=lte.${encodeURIComponent(filters.until)}`);
  }

  const query = params.join('&');
  const res = await supabaseFetch(env, `/rest/v1/topics?${query}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase query failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
  const items = ((await safeJson(res)) as PullTopicRow[]) || [];

  // 客户端再过滤 score >= 6(避免 Or/And 拼接)
  // 实际生产应该用 RPC,但 v0.31 阶段先客户端过滤,简单且无 SQL 注入风险
  const filtered = items.filter((it: any) => (it.score || 0) >= 6);

  // total: 简单取 filtered.length;精确 count 需要额外 RPC,先不实现
  return { items: filtered, total: filtered.length };
}

// ====== Seed Envelope helpers ======

/**
 * 计算 items 数组中最新内容的年龄(分钟)
 * 用于 SeedEnvelope.maxContentAgeMin, health 端点判断 pull 缓存新鲜度
 * - 有 created_at 字段: 取最新一条的 age
 * - 无 created_at: 返回 -1 (未知, 不参与 freshness 检查)
 */
function computeMaxContentAgeMin(items: any[]): number {
  if (!items || items.length === 0) return -1;
  let newestMs = 0;
  for (const item of items) {
    if (item && typeof item === 'object' && item.created_at) {
      const ms = Date.parse(item.created_at);
      if (Number.isFinite(ms) && ms > newestMs) newestMs = ms;
    }
  }
  if (newestMs === 0) return -1;
  return Math.round((Date.now() - newestMs) / 60000);
}

// ====== 入口 ======

/**
 * pull 端点主入口
 * 返回: 标准 PullResponse 或 throw
 *
 * 缓存策略 (v0.36.25 派活 17):
 * - 入口 cacheGet → 命中直接返 (不查 Supabase)
 * - miss 走 Supabase → 写回 cache (ctx.waitUntil fire-and-forget, 响应不等 KV put)
 * - cacheKey = makeCacheKey('pull', filters), 顺序无关 + null 过滤
 * - 缓存错 / 写错 → 静默, 不影响主流程
 */
export async function handlePull(env: Env, url: URL, ctx: ExecutionContext): Promise<PullResponse> {
  const parsed = parseFilters(url);
  if (!parsed.ok) {
    const err: any = new Error(parsed.error);
    err.status = 400;
    throw err;
  }
  const filters = parsed.filters;
  const config = TYPE_CONFIG[filters.type];

  // 缓存 lookup (按 filters 顺序无关)
  // makeCacheKey 接受 Record<string, any>，ParsedFilters 满足结构兼容，无需 cast
  const cacheKey = await makeCacheKey('pull', filters);
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    return cached as PullResponse;
  }

  // Negative Sentinel 检查: 上游故障时跳过重试, 保护 AI budget
  if (await isNegativeSentinel(env, cacheKey)) {
    return {
      type: filters.type,
      count: 0,
      total: 0,
      truncated: false,
      filters: {
        limit: filters.limit,
        order: filters.order,
        order_by: filters.orderBy,
        since: filters.since,
        until: filters.until,
        level: filters.level,
        category: filters.category,
        topic_id: filters.topicId,
        status: filters.status,
        stage: filters.stage,
        fission_triggered: filters.fissionTriggered,
        title_like: filters.titleLike,
        select: filters.select,
        format: filters.format,
      },
      items: [],
    };
  }

  let items: any[];
  let total: number;

  try {
    if (filters.type === 'fission-pending') {
      // 衍生视图,走专用查询
      const result = await queryFissionPending(env, filters);
      items = result.items;
      total = result.total;
    } else {
      // 普通表查询(PostgREST)
      const query = buildPostgRestQuery(filters);
      const res = await supabaseFetch(env, `/rest/v1/${config.table}?${query}`);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Supabase query failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
      }
      items = ((await safeJson(res)) as PullTopicRow[]) || [];

      // total: PostgREST 默认不在响应里;v0.31 阶段用 items.length 近似
      // 精确 count 留给 v0.32 (Prefer: count=exact 头)
      total = items.length;
    }

    // 成功: 清除 Negative Sentinel (cleanup)
    await clearNegativeSentinel(env, cacheKey);
  } catch (e: any) {
    // 失败: 写入 Negative Sentinel, 30s 内跳过重试
    await setNegativeSentinel(env, cacheKey);
    throw e;
  }

  const projected = projectFormat(items, filters.format);

  const response: PullResponse = {
    type: filters.type,
    count: projected.length,
    total,
    truncated: total > projected.length,
    filters: {
      limit: filters.limit,
      order: filters.order,
      order_by: filters.orderBy,
      since: filters.since,
      until: filters.until,
      level: filters.level,
      category: filters.category,
      topic_id: filters.topicId,
      status: filters.status,
      stage: filters.stage,
      fission_triggered: filters.fissionTriggered,
      title_like: filters.titleLike,
      select: filters.select,
      format: filters.format,
    },
    items: projected,
  };

  // fire-and-forget 写缓存 (ctx.waitUntil 让 KV put 在响应后继续)
  // 传入 recordCount + maxContentAgeMin, 自动包装 SeedEnvelope
  const maxContentAgeMin = computeMaxContentAgeMin(items);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      cacheSet(env, cacheKey, response, DEFAULT_TTL_SECONDS, {
        recordCount: projected.length,
        maxContentAgeMin,
      })
    );
  } else {
    // 无 ctx (如测试) → 同步写
    await cacheSet(env, cacheKey, response, DEFAULT_TTL_SECONDS, {
      recordCount: projected.length,
      maxContentAgeMin,
    });
  }

  return response;
}
