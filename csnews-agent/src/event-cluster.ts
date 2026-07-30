/**
 * CSNEWS Agent · 事件聚类 (v0.36.12)
 *
 * 16:48 确定:
 *   - 蓝图 v0.35+ 第 2.7 节 Jaccard entity_overlap 公式
 *   - threshold 从 event-threshold.ts 读 (review 反馈自适应)
 *   - 聚类用 union-find 简化实现
 *   - 0 temporal / semantic / causal edge (留 v0.37+)
 *
 * v0.36.12 修复:
 *   - 按 topic_id 分组后 entity 引用交集/并集计算 Jaccard
 *   - 不再用 entity name 字符集重叠 (错误)
 *   - 两两 topic 共享 entity 引用 → Jaccard >= threshold → 同 cluster
 */
import { Env } from './shared';
import { getCurrentThreshold } from './event-threshold';
import type { EntityFinalized } from './entity-process';

export interface EventCluster {
  cluster_id: string;
  entity_names: string[];
  entity_count: number;
  topic_ids: string[];
  jaccard_pairs: number;
  created_at: string;
  reviewed?: 'correct' | 'incorrect' | 'pending';
}

/**
 * Jaccard entity_overlap 公式
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 */
export function entityOverlapJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 简化版 union-find 聚类
 */
class UnionFind {
  private parent: Map<string, string> = new Map();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) === x) return x;
    const root = this.find(this.parent.get(x)!);
    this.parent.set(x, root);
    return root;
  }
  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }
}

/**
 * 主函数: 跑事件聚类
 *
 * 正确逻辑 (v0.36.12):
 *   1. 按 topic_id 分组 entities (每条 news 关联多个 entity)
 *   2. 每个 unique topic_id = 一个 event candidate (topic 的 entity 集合)
 *   3. 两两 topic 算 Jaccard entity_overlap (共享 entity 引用)
 *   4. Jaccard >= threshold → union-find 合并
 *   5. 输出 cluster 列表 (每个 cluster 含所有关联 entity + topic)
 */
export async function runEventClustering(
  env: Env,
  entities: EntityFinalized[]
): Promise<{ clusters: EventCluster[]; threshold: number; jaccard_pairs: number }> {
  const threshold = await getCurrentThreshold(env);

  // 1. Group entities by topic_id
  // Each topic_id represents a news item with a set of entity names
  const topicToEntities = new Map<string, Set<string>>();

  for (const entity of entities) {
    const topicIds = entity.topic_ids || [];
    for (const topicId of topicIds) {
      if (!topicToEntities.has(topicId)) {
        topicToEntities.set(topicId, new Set());
      }
      topicToEntities.get(topicId)!.add(entity.name);
    }
  }

  // If no topic associations, fall back to entity name clustering (legacy mode)
  if (topicToEntities.size < 2) {
    const uniqueNames = Array.from(new Set(entities.map((e) => e.name)));
    const uf = new UnionFind();
    for (const name of uniqueNames) uf.find(name);

    /** Split name into tokens for word-level Jaccard comparison */
    function nameTokens(name: string): string[] {
      return name.toLowerCase().split(/[\s_/-]+/).filter(Boolean);
    }

    let jaccardPairs = 0;
    for (let i = 0; i < uniqueNames.length; i++) {
      for (let j = i + 1; j < uniqueNames.length; j++) {
        const a = uniqueNames[i];
        const b = uniqueNames[j];
        // Use word/term tokenization instead of character-level sets
        const jaccard = entityOverlapJaccard(nameTokens(a), nameTokens(b));
        jaccardPairs++;
        if (jaccard >= threshold) {
          uf.union(a, b);
        }
      }
    }

    const rootToMembers = new Map<string, string[]>();
    for (const name of uniqueNames) {
      const root = uf.find(name);
      if (!rootToMembers.has(root)) rootToMembers.set(root, []);
      rootToMembers.get(root)!.push(name);
    }

    const clusters: EventCluster[] = [];
    let clusterIdx = 0;
    for (const [, members] of rootToMembers) {
      const pairCount = (members.length * (members.length - 1)) / 2;
      clusters.push({
        cluster_id: `cluster-${clusterIdx++}-${members.length}`,
        entity_names: members,
        entity_count: members.length,
        topic_ids: [],
        jaccard_pairs: pairCount,
        created_at: new Date().toISOString(),
        reviewed: 'pending',
      });
    }

    return { clusters, threshold, jaccard_pairs: jaccardPairs };
  }

  // 2. Union-find clustering at topic level using shared entity references
  const topicIds = Array.from(topicToEntities.keys());
  const uf = new UnionFind();
  for (const tid of topicIds) uf.find(tid);

  let jaccardPairs = 0;
  for (let i = 0; i < topicIds.length; i++) {
    for (let j = i + 1; j < topicIds.length; j++) {
      const tidA = topicIds[i];
      const tidB = topicIds[j];
      const entitiesA = Array.from(topicToEntities.get(tidA)!);
      const entitiesB = Array.from(topicToEntities.get(tidB)!);

      // Correct Jaccard: shared entity references between two topics
      const jaccard = entityOverlapJaccard(entitiesA, entitiesB);
      jaccardPairs++;

      if (jaccard >= threshold) {
        uf.union(tidA, tidB);
      }
    }
  }

  // 3. Collect clusters (each cluster = merged topics + all their entities)
  const rootToTopics = new Map<string, string[]>();
  for (const tid of topicIds) {
    const root = uf.find(tid);
    if (!rootToTopics.has(root)) rootToTopics.set(root, []);
    rootToTopics.get(root)!.push(tid);
  }

  const clusters: EventCluster[] = [];
  let clusterIdx = 0;
  for (const [, topics] of rootToTopics) {
    // Collect all entities from all topics in this cluster
    const clusterEntities = new Set<string>();
    const clusterTopics = new Set<string>();

    for (const tid of topics) {
      clusterTopics.add(tid);
      for (const entityName of topicToEntities.get(tid)!) {
        clusterEntities.add(entityName);
      }
    }

    clusters.push({
      cluster_id: `cluster-${clusterIdx++}-${topics.length}`,
      entity_names: Array.from(clusterEntities),
      entity_count: clusterEntities.size,
      topic_ids: Array.from(clusterTopics),
      jaccard_pairs: (topics.length * (topics.length - 1)) / 2,
      created_at: new Date().toISOString(),
      reviewed: 'pending',
    });
  }

  return { clusters, threshold, jaccard_pairs: jaccardPairs };
}
