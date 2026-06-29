/**
 * CSNEWS Agent · 事件处理 (v0.36.11)
 *
 * 16:48 确定: 0 DDL = 聚类结果暂存 R2 event-clusters.json
 * 5h 配额期外等 entity 表 schema migration 后启用 writeEventClustersToSupabase
 */
import { Env } from './shared';
import { runEventClustering } from './event-cluster';
import { loadReviewedCandidates, type EntityFinalized } from './entity-process';
import { logEvent } from './log';
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
 * 主函数: 跑事件聚类 + 暂存 R2
 */
export async function runEventProcess(env: Env): Promise<{
  clusters: number;
  threshold: number;
  written: number;
  errors: number;
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
    return { clusters: 0, threshold: 0, written: 0, errors: 1 };
  }

  if (entities.length === 0) {
    return { clusters: 0, threshold: 0, written: 0, errors: 0 };
  }

  const result = await runEventClustering(env, entities);
  const ts = new Date().toISOString();

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
    };
  } catch (e: any) {
    await logEvent(
      env,
      'error',
      `[event-process] R2 put failed: ${e?.message || e}`,
      undefined,
      'event'
    );
    return { clusters: result.clusters.length, threshold: result.threshold, written: 0, errors: 1 };
  }
}
