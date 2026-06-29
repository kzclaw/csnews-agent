/**
 * CSNEWS Agent · 事件处理 (v0.36.13)
 *
 * v0.36.13:
 *   - 聚类完成后对所有 cluster topic_ids 跑 event_stage transition
 *   - 0 DDL = 聚类结果暂存 R2 event-clusters.json
 *   - event_stage transition 走 Supabase RPC (server-side 逻辑)
 */
import { Env } from './shared';
import { runEventClustering } from './event-cluster';
import { loadReviewedCandidates, type EntityFinalized } from './entity-process';
import { logEvent } from './log';
import { transitionEventStageBatch } from './event-stage';
export { runEventClustering };

export const EVENT_CLUSTERS_R2_KEY = 'event-clusters.json';
export const EVENT_CLUSTERS_INDEX_R2_KEY = 'event-clusters-index.json';

export interface EventClustersIndexEntry {
  cluster_id: string;
  entity_count: number;
  topic_count: number;
  created_at: string;
}

/**
 * 主函数: 跑事件聚类 + event_stage transition + 暂存 R2
 */
export async function runEventProcess(env: Env): Promise<{
  clusters: number;
  threshold: number;
  written: number;
  errors: number;
  stage_transitions: number;
}> {
  let entities: EntityFinalized[] = [];
  try {
    entities = await loadReviewedCandidates(env);
  } catch (e: any) {
    await logEvent(
      env,
      'error',
      `[event-process] loadReviewedCandidates failed: ${e?.message || e}`,
      undefined,
      'event'
    );
    return { clusters: 0, threshold: 0, written: 0, errors: 1, stage_transitions: 0 };
  }

  if (entities.length === 0) {
    return { clusters: 0, threshold: 0, written: 0, errors: 0, stage_transitions: 0 };
  }

  const result = await runEventClustering(env, entities);
  const ts = new Date().toISOString();

  // Collect all topic_ids from clusters and run event_stage transition
  const allTopicIds = Array.from(
    new Set(result.clusters.flatMap((c) => c.topic_ids || []))
  );
  let stageTransitions = 0;
  if (allTopicIds.length > 0) {
    const stageResults = await transitionEventStageBatch(env, allTopicIds);
    stageTransitions = stageResults.filter((r) => r.changed).length;
    if (stageTransitions > 0) {
      await logEvent(
        env,
        'info',
        `[event-process] event_stage transitions: ${stageTransitions}/${allTopicIds.length} topics changed stage`,
        { changed: stageResults.filter((r) => r.changed) },
        'event'
      );
    }
  }

  try {
    // 暂存 R2 event-clusters.json (0 DDL 原则)
    await env.csnews_raw.put(
      EVENT_CLUSTERS_R2_KEY,
      JSON.stringify(
        {
          generated_at: ts,
          threshold: result.threshold,
          jaccard_pairs: result.jaccard_pairs,
          clusters: result.clusters,
        },
        null,
        2
      )
    );

    // 累积分页索引
    const indexEntry: EventClustersIndexEntry[] = result.clusters.map((c) => ({
      cluster_id: c.cluster_id,
      entity_count: c.entity_count,
      topic_count: c.topic_ids?.length || 0,
      created_at: c.created_at,
    }));
    await env.csnews_raw.put(EVENT_CLUSTERS_INDEX_R2_KEY, JSON.stringify(indexEntry, null, 2));

    return {
      clusters: result.clusters.length,
      threshold: result.threshold,
      written: result.clusters.length,
      errors: 0,
      stage_transitions: stageTransitions,
    };
  } catch (e: any) {
    await logEvent(
      env,
      'error',
      `[event-process] R2 put failed: ${e?.message || e}`,
      undefined,
      'event'
    );
    return { clusters: result.clusters.length, threshold: result.threshold, written: 0, errors: 1, stage_transitions: 0 };
  }
}
