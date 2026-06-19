// ============================================================
// 共享类型
// ============================================================
// 用途：跨模块共享的类型契约（避免每个模块各写各的形状）
//
// 注意：safeJson() 返回 any 是设计决定（Supabase PostgREST 动态 JSON 解析）。
//       所有调用处统一用具体类型断言，不用修改 safeJson 本身。

// 注：Env 类型由 csnews-agent/src/cf-types.d.ts（ambient declaration）全局提供，
//     不需要在此 re-export。cf-types.d.ts 已经在 src/ 目录下，TypeScript 自动 include。

// 共享接口（从 csnews-agent/src/index.ts 抽出）
export interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
}

// ============================================================
// Supabase 表行接口（与 SELECT 字段严格对应）
// ============================================================

/** news_hotspots 表行（content/trend/process/pull 端点共用 SELECT） */
export interface NewsHotspotRow {
  id: string;
  title: string | null;
  url: string | null;
  source: string | null;
  category: string | null;
  summary?: string | null;
  hot_score: number | null;
  score: number | null;
  level: string | null;
  topic_id: string | null;
  r2_key: string | null;
  created_at: string;
}

/**
 * R2 存储的新闻内容数据（content endpoint 用）
 * 来自 saveToR2(env, 'news/zaker', {...})，形状由 news-process.ts 决定
 * endpoints-trend.ts handleContentAction 用
 */
export interface R2ContentData {
  title?: string;
  category?: string;
  score?: number;
  level?: string;
  topic_id?: string;
  fission?: boolean;
  similarity?: number;
  created_at?: string;
}

/** topics 表行（trend/knowledge/process/pull 端点共用 SELECT） */
export interface TopicRow {
  id: string;
  topic_key: string;
  level: string;
  score: number;
  last_active_at: string;
  first_news_id: string | null;
}

/** news_topic_members 表行（entity-selflearn 用） */
export interface NewsTopicMemberRow {
  id?: string;
  news_id: string;
  topic_id: string;
  joined_at?: string;
}

/** trend_snapshots 表行（health 端点 zscore_signals 用） */
export interface TrendSnapshotRow {
  id: string;
  topic_id: string;
  score: number | null;
  velocity: number | null;
  acceleration: number | null;
  created_at: string;
}

// ============================================================
// RPC 返回类型
// ============================================================

/** cleanup_stale_topics RPC 返回 */
export interface CleanupStaleTopicsResult {
  deleted_topic_count: number;
  deleted_news_count: number;
}

/** find_similar_news RPC 返回项 */
export interface SimilarNewsItem {
  topic_id: string;
  similarity: number;
  // 其他字段由 RPC 返回，取决于 SQL 定义
}

/** update_topic_score RPC 返回 */
export interface UpdateTopicScoreResult {
  new_score: number;
  new_level: string;
  upgraded: boolean;
  fission_triggered: boolean;
}

/** record_trend_with_member RPC 返回 */
export interface RecordTrendWithMemberResult {
  snapshot_id: string | null;
  warning_id: string | null;
  out_velocity: number | null;
  out_acceleration: number | null;
  out_stage: string | null;
  out_warning_created: string | null;
}

/** insertNewsHotspotsBatch 返回的单条记录 */
export interface InsertedNewsHotspotRow {
  id: string;
}

/** createTopic() 返回的新建话题簇对象 */
export interface CreatedTopicRow {
  id: string;
  topic_key: string;
  level: string;
  score: number;
  first_news_id: string | undefined;
}

/**
 * pull 端点 topics type 返回的 TopicRow 投影
 * (与 TopicRow 字段一致，仅 select 字段子集)
 */
export interface PullTopicRow {
  id: string;
  topic_key: string;
  level: string;
  score: number;
  last_active_at: string;
  first_news_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Workers AI / 外部 API 响应接口
// ============================================================

/**
 * CF Workers AI @cf/meta/llama-3-8b-instruct 响应
 * env.AI.run() 运行时才知道确切形状，定义为宽接口
 */
export interface LlamaAIResponse {
  response?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * CF Workers AI @cf/baai/bge-m3 响应
 * shape: [n, dim], data: [[embedding: number[]]]
 */
export interface BgeEmbeddingResponse {
  shape?: [number, number];
  data?: BgeEmbeddingItem[];
  response?: string;
}

export interface BgeEmbeddingItem {
  embedding?: number[];
}

/**
 * Zaker 热点 API 响应（外部三方 API，形状不归我们控制）
 */
export interface ZakerArticle {
  title?: string;
  url?: string;
  publish_time?: string;
  summary?: string;
}

export interface ZakerHotResponse {
  data?: {
    list?: ZakerArticle[];
  };
}
