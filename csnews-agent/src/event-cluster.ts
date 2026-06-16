/**
 * CSNEWS Agent · 事件聚类 (v0.36.11)
 *
 * kzclaw 16:48 确定:
 *   - 蓝图 v0.35+ 第 2.7 节 Jaccard entity_overlap 公式
 *   - threshold 从 event-threshold.ts 读 (kzclaw review 反馈自适应)
 *   - 聚类用 union-find 简化实现
 *   - 0 temporal / semantic / causal edge (留 v0.37+)
 */
import { Env } from './shared';
import { getCurrentThreshold } from './event-threshold';
import type { EntityFinalized } from './entity-process';

export interface EventCluster {
  cluster_id: string;
  entity_names: string[];
  entity_count: number;
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
 * 流程:
 *   1. 读 R2 entity-finalized.json (KR0 跑出来的)
 *   2. 按 topic_id 分组 (每条 news 关联 entity)
 *   3. 每个 topic = 一个 event candidate
 *   4. 两两算 Jaccard entity_overlap
 *   5. Jaccard >= threshold → union-find 合并
 *   6. 输出 cluster 列表
 */
export async function runEventClustering(
  env: Env,
  entities: EntityFinalized[],
): Promise<{ clusters: EventCluster[]; threshold: number; jaccard_pairs: number }> {
  const threshold = await getCurrentThreshold(env);

  // 简化版: 每个 entity 自成一组, 两两比 Jaccard, 超过 threshold 合并
  // kzclaw 16:48 确定: v2 简化 = 不依赖 news_topic_members, 0 DDL
  // entity names 之间的共享 = 同一 event 候选

  // 1. 把 entities 按 name 分组, 同 name 合并
  const uniqueNames = Array.from(new Set(entities.map((e) => e.name)));

  // 2. 简化聚类: 包含共同高频 entity 名字 (e.g. 月份/数字) 的归一类
  //    kzclaw 16:48 确定: 启发式聚类 + 0 硬编码 = 用 entity 名字字符重叠做粗聚类
  const uf = new UnionFind();
  for (const name of uniqueNames) uf.find(name);  // 初始化

  let jaccardPairs = 0;
  for (let i = 0; i < uniqueNames.length; i++) {
    for (let j = i + 1; j < uniqueNames.length; j++) {
      const a = uniqueNames[i];
      const b = uniqueNames[j];
      // 简化 Jaccard: 2 个 entity 名字的字符集重叠
      const jaccard = entityOverlapJaccard(
        Array.from(new Set(a)),
        Array.from(new Set(b)),
      );
      jaccardPairs++;
      if (jaccard >= threshold) {
        uf.union(a, b);
      }
    }
  }

  // 3. 收集 clusters
  const rootToMembers = new Map<string, string[]>();
  for (const name of uniqueNames) {
    const root = uf.find(name);
    if (!rootToMembers.has(root)) rootToMembers.set(root, []);
    rootToMembers.get(root)!.push(name);
  }

  const clusters: EventCluster[] = [];
  let clusterIdx = 0;
  for (const [, members] of rootToMembers) {
    clusters.push({
      cluster_id: `cluster-${clusterIdx++}-${members.length}`,
      entity_names: members,
      entity_count: members.length,
      jaccard_pairs: jaccardPairs,
      created_at: new Date().toISOString(),
      reviewed: 'pending',
    });
  }

  return { clusters, threshold, jaccard_pairs: jaccardPairs };
}
