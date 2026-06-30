/**
 * CSNEWS Agent · Supabase RPC & Workers AI 类型定义
 * 消除 unsafe 类型断言，统一接口类型
 */

/**
 * Workers AI 文本生成响应
 * @cf/meta/llama-3.1-8b-instruct-fp8 返回格式
 */
export interface AiTextResponse {
  response: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * Workers AI 嵌入响应
 * @cf/baai/bge-m3 返回格式
 */
export interface AiEmbeddingResponse {
  shape?: number[];
  data?: AiEmbeddingItem[];
  response?: string;
  [key: string]: unknown;
}

export interface AiEmbeddingItem {
  embedding?: number[];
  [key: string]: unknown;
}

/**
 * ZAKER 热点 API 响应
 */
export interface ZakerHotResponse {
  data?: {
    list?: ZakerHotItem[];
  };
  [key: string]: unknown;
}

export interface ZakerHotItem {
  title?: string;
  url?: string;
  summary?: string;
  publish_time?: string;
  [key: string]: unknown;
}

// ======== Supabase RPC 返回类型 ========

/** cleanup_stale_topics RPC 返回 */
export interface CleanupStaleResult {
  deleted_topic_count: number;
  deleted_news_count: number;
}

/** find_similar_news RPC 返回数组元素 */
export interface SimilarNewsItem {
  topic_id: string;
  similarity: number;
  score?: number;
  level?: string;
  [key: string]: unknown;
}

/** update_topic_score RPC 返回 */
export interface UpdateTopicScoreResult {
  new_score: number;
  new_level: string;
  upgraded: boolean;
  fission_triggered: boolean;
}

/** record_trend_snapshot RPC 返回 */
export interface TrendSnapshotResult {
  snapshot_id: string;
  warning_id?: string;
  velocity: number;
  acceleration: number;
  stage: string;
  warning_created?: string;
  [key: string]: unknown;
}

/** topics 表写入返回 */
export interface TopicRecord {
  id: string;
  topic_key: string;
  level: string;
  score: number;
  first_news_id?: string;
  [key: string]: unknown;
}

// ======== 类型守卫函数 ========

export function isAiTextResponse(v: unknown): v is AiTextResponse {
  return typeof v === 'object' && v !== null && 'response' in v;
}

export function isAiEmbeddingResponse(v: unknown): v is AiEmbeddingResponse {
  return typeof v === 'object' && v !== null && 'shape' in v;
}

export function isZakerHotResponse(v: unknown): v is ZakerHotResponse {
  return typeof v === 'object' && v !== null;
}

export function isCleanupStaleResult(v: unknown): v is CleanupStaleResult {
  return (
    typeof v === 'object' && v !== null && 'deleted_topic_count' in v && 'deleted_news_count' in v
  );
}

export function isSimilarNewsItem(v: unknown): v is SimilarNewsItem {
  return typeof v === 'object' && v !== null && 'topic_id' in v;
}

export function isUpdateTopicScoreResult(v: unknown): v is UpdateTopicScoreResult {
  return typeof v === 'object' && v !== null && 'new_score' in v && 'new_level' in v;
}

export function isTrendSnapshotResult(v: unknown): v is TrendSnapshotResult {
  return typeof v === 'object' && v !== null && 'snapshot_id' in v;
}
