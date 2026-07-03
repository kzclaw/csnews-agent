/**
 * CSNEWS Agent · Score 阈值 自适应 (v0.37.36)
 *
 * 跟 event-threshold.ts (v0.36.11) 同 范式,  但是 适配 score 阈值
 * (event-threshold 是 聚类 阈值,  score-threshold 是 explosive 触发 阈值)
 *
 * v0.37.36 拍板:
 *   - score 9 不再 写死 · 改 自适应 阈值 (worker R2 持久化)
 *   - 默认值 仍 9 (跟 现状 兼容 · 不 改变 既 行为)
 *   - STEP 0.5 (跟 event-threshold 类似 步长)
 *   - 复用 event-threshold.ts 范本 · R2 score-threshold-history.json
 *
 * 业务 设计:
 *   - review 反馈驱动 自适应
 *     - 'threshold_too_low' (explosive 太少) → +0.5 (要求 更高 分数 才 算 explosive)
 *     - 'threshold_too_high' (explosive 太多) → -0.5 (放宽)
 *   - clamp [SCORE_THRESHOLD_MIN, SCORE_THRESHOLD_MAX]
 *   - 持久化 R2 'score-threshold-history.json' (跟 event-threshold-history.json 同 path 模式)
 *
 * 跨项目原则 实战:
 *   - 自适应 / 自学习 / 自进化 优先,  硬编码 是 最后 手段
 *   - 决策 前 必须 先 调研 → 判断 可行性 → 做 微调,  PDCA 循环
 */
import { Env } from './shared';

export const SCORE_THRESHOLD_DEFAULT = 9;
export const SCORE_THRESHOLD_STEP = 0.5;
export const SCORE_THRESHOLD_MIN = 5;
export const SCORE_THRESHOLD_MAX = 15;
export const SCORE_THRESHOLD_HISTORY_R2_KEY = 'score-threshold-history.json';

export type ScoreReviewType = 'threshold_too_low' | 'threshold_too_high';

export interface ScoreThresholdHistoryEntry {
  ts: string;
  old_value: number;
  new_value: number;
  review_type: ScoreReviewType;
  reason: string;
}

export interface ScoreThresholdHistory {
  current: number;
  history: ScoreThresholdHistoryEntry[];
  updated_at: string;
}

/**
 * 初始化 score-threshold history (首次)
 */
function freshScoreThresholdHistory(): ScoreThresholdHistory {
  return {
    current: SCORE_THRESHOLD_DEFAULT,
    history: [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * 读 R2 score-threshold history
 */
export async function loadScoreThresholdHistory(env: Env): Promise<ScoreThresholdHistory> {
  const obj = await env.csnews_raw.get(SCORE_THRESHOLD_HISTORY_R2_KEY);
  if (!obj) return freshScoreThresholdHistory();
  try {
    return await obj.json<ScoreThresholdHistory>();
  } catch {
    // R2 file 损坏 / 格式错: 回退 到 默认
    return freshScoreThresholdHistory();
  }
}

/**
 * 计算 下一次 score-threshold (review 反馈驱动)
 *
 * 跟 event-threshold 同 模式:
 *   - threshold_too_low (explosive 太少) → +STEP (要求 更高 分数)
 *   - threshold_too_high (explosive 太多) → -STEP (放宽)
 *   - clamp [SCORE_THRESHOLD_MIN, SCORE_THRESHOLD_MAX]
 */
export function nextScoreThreshold(current: number, review: ScoreReviewType): number {
  const delta = review === 'threshold_too_low' ? +SCORE_THRESHOLD_STEP : -SCORE_THRESHOLD_STEP;
  const next = current + delta;
  return Math.max(SCORE_THRESHOLD_MIN, Math.min(SCORE_THRESHOLD_MAX, next));
}

/**
 * review 反馈 → 持久化 (类似 event-threshold.ts recordReview)
 */
export async function recordScoreAdjustment(
  env: Env,
  review: ScoreReviewType,
  reason?: string
): Promise<ScoreThresholdHistory> {
  const history = await loadScoreThresholdHistory(env);
  const newValue = nextScoreThreshold(history.current, review);

  const entry: ScoreThresholdHistoryEntry = {
    ts: new Date().toISOString(),
    old_value: history.current,
    new_value: newValue,
    review_type: review,
    reason: reason || (review === 'threshold_too_low' ? 'explosive too rare' : 'explosive too common'),
  };

  const updated: ScoreThresholdHistory = {
    current: newValue,
    history: [...history.history, entry],
    updated_at: entry.ts,
  };

  await env.csnews_raw.put(SCORE_THRESHOLD_HISTORY_R2_KEY, JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * 拿 当前 score-threshold (0 硬编码 点 = 自动)
 */
export async function getCurrentScoreThreshold(env: Env): Promise<number> {
  const history = await loadScoreThresholdHistory(env);
  return history.current;
}

/**
 * 检查 topic 是否 触发 fission (level='explosive' AND score >= threshold)
 *
 * 决策 4: 触发 条件 = topic.level='explosive' AND score >= current_threshold
 * Supabase RPC 业务 阈值 (SQL 内部) 仍 是 9 · worker 端 加 一层 self-check 用于 触发 fission Service Binding
 * 保持 双 层 防御
 */
export async function shouldTriggerFission(env: Env, level: string, score: number): Promise<boolean> {
  if (level !== 'explosive') return false;
  const threshold = await getCurrentScoreThreshold(env);
  return score >= threshold;
}
