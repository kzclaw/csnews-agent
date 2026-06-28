// ============================================================
// Database operations — topic creation, score update, batch insert, trend recording
// ============================================================

import { Env } from './shared';
import {
  createTopic,
  updateTopicScore,
  insertNewsHotspotsBatch,
  dualWriteEmbeddingsToVectorize,
  recordTrendWithMember,
} from './news-process';
import { hashStr } from './score';
import type {
  UpdateTopicScoreResult,
  RecordTrendWithMemberResult,
  CreatedTopicRow,
} from './types';
import { logEvent } from './log';

export interface NewsBatchItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
  embedding?: number[];
  r2_key?: string;
  topic_id?: string;
  level?: string;
  score?: number;
  is_stored_r2?: boolean;
}

/**
 * Generate a deterministic topic key from a news title.
 * Uses hashStr for Chinese-friendly hashing, prefixed with 't-' for clarity.
 */
export function topicKeyFromTitle(title: string): string {
  const titleHash = Math.abs(hashStr(title)).toString(36);
  return `t-${titleHash}`;
}

/** Create a new topic for a news title. Returns the created topic row or null on failure. */
export async function createTopicForTitle(
  env: Env,
  title: string,
  level = 'follow'
): Promise<CreatedTopicRow | null> {
  const topicKey = topicKeyFromTitle(title);
  const created = (await createTopic(env, topicKey, level)) as CreatedTopicRow;
  return created?.id ? created : null;
}

/** Increment topic score by 1. Returns the updated score result. */
export async function updateTopicScoreById(
  env: Env,
  topicId: string
): Promise<UpdateTopicScoreResult> {
  return (await updateTopicScore(env, topicId, 1)) as UpdateTopicScoreResult;
}

/**
 * Batch-insert news records in a single subrequest.
 * Returns array of inserted IDs in the same order as input.
 * Returns empty array on complete failure.
 */
export async function insertNewsBatch(env: Env, newsList: NewsBatchItem[]): Promise<string[]> {
  return insertNewsHotspotsBatch(env, newsList);
}

/**
 * Dual-write embeddings to Vectorize after batch insert.
 * Fire-and-forget: failures are logged but do not throw.
 */
export async function dualWriteVectors(
  env: Env,
  newsList: Array<{ title: string; category?: string; embedding?: number[] }>,
  ids: string[]
): Promise<void> {
  dualWriteEmbeddingsToVectorize(env, newsList, ids).catch(async (err) => {
    await logEvent(env, 'error', '[Vectorize] dual-write failed', { err }, 'process');
  });
}

/**
 * Record trend snapshot and topic membership for a news item.
 * Combines joinTopicMember + recordTrendSnapshot in a single RPC call.
 */
export async function recordTrendForNews(
  env: Env,
  newsId: string,
  topicId: string,
  isNewTopic = false
): Promise<RecordTrendWithMemberResult | null> {
  return recordTrendWithMember(env, newsId, topicId, isNewTopic);
}
