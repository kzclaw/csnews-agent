/**
 * CSNEWS Agent · 事件聚类 threshold 自适应 (v0.36.11)
 *
 * kzclaw 16:48 确定:
 *   - threshold 0.4 起步 (蓝图 v0.35+ 第 2.7 节)
 *   - kzclaw review 反馈驱动自适应 (0 硬编码固定值)
 *   - step 0.05 (kzclaw 5h 配额期外确定)
 *   - R2 event-threshold-history.json 持久化调优历史
 *
 * kzclaw 第 40 + 41 条跨项目原则实战:
 *   - #16 (memory §3): 自适应/自学习/自进化优先, 硬编码是最后手段
 *   - #17 (memory §3): 决策前必须先调研→判断可行性→做微调, PDCA 循环
 */
import { Env } from './shared';

export const THRESHOLD_DEFAULT = 0.4;
export const THRESHOLD_STEP = 0.05;
export const THRESHOLD_MIN = 0.1;
export const THRESHOLD_MAX = 0.9;
export const THRESHOLD_HISTORY_R2_KEY = 'event-threshold-history.json';

export interface ThresholdHistoryEntry {
  ts: string;
  old_value: number;
  new_value: number;
  review_type: 'correct' | 'incorrect';
  cluster_id?: string;
  reason: string;
}

export interface ThresholdHistory {
  current: number;
  history: ThresholdHistoryEntry[];
  updated_at: string;
}

/**
 * 初始化 threshold history (首次)
 */
function freshHistory(): ThresholdHistory {
  return {
    current: THRESHOLD_DEFAULT,
    history: [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * 读 R2 threshold history
 */
export async function loadThresholdHistory(env: Env): Promise<ThresholdHistory> {
  const obj = await env.csnews_raw.get(THRESHOLD_HISTORY_R2_KEY);
  if (!obj) return freshHistory();
  return await obj.json<ThresholdHistory>();
}

/**
 * 计算下一次 threshold (review 反馈驱动)
 *
 * 16:48 确定:
 *   - correct (聚类对) → threshold +0.05 (更宽, 接受更多 entity 共享 = 同一 cluster)
 *   - incorrect (聚类错) → threshold -0.05 (更严, 只接受更明确的 entity 共享)
 *   - 边界: [THRESHOLD_MIN, THRESHOLD_MAX] clamp
 */
export function nextThreshold(current: number, review: 'correct' | 'incorrect'): number {
  const delta = review === 'correct' ? +THRESHOLD_STEP : -THRESHOLD_STEP;
  const next = current + delta;
  return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, next));
}

/**
 * review 反馈 → 持久化
 */
export async function recordReview(
  env: Env,
  review: 'correct' | 'incorrect',
  clusterId?: string,
  reason?: string,
): Promise<ThresholdHistory> {
  const history = await loadThresholdHistory(env);
  const newValue = nextThreshold(history.current, review);

  const entry: ThresholdHistoryEntry = {
    ts: new Date().toISOString(),
    old_value: history.current,
    new_value: newValue,
    review_type: review,
    cluster_id: clusterId,
    reason: reason || (review === 'correct' ? 'cluster accepted' : 'cluster rejected'),
  };

  const updated: ThresholdHistory = {
    current: newValue,
    history: [...history.history, entry],
    updated_at: entry.ts,
  };

  await env.csnews_raw.put(THRESHOLD_HISTORY_R2_KEY, JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * 拿当前 threshold (kzclaw 0 确定点 = 自动)
 */
export async function getCurrentThreshold(env: Env): Promise<number> {
  const history = await loadThresholdHistory(env);
  return history.current;
}
