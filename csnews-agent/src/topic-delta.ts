/**
 * CSNEWS Agent · Topic Delta 映射 (v0.37.37)
 *
 * 把 news hot_score (0-10 来自 scoreRule, 实测 5.5-9.1) 映射成 topic delta (1-3 5 档)
 *
 * 5 档 平滑 (v0.37.37 拍板 B):
 *   - hot_score < 6        → +1     (低分, 跟 现 行为 一致)
 *   - 6 <= hot_score < 7   → +1.5   (中等)
 *   - 7 <= hot_score < 8   → +2     (中高)
 *   - 8 <= hot_score < 9   → +2.5   (高, 卡 8 explosive 加速)
 *   - hot_score >= 9       → +3     (超高, 1 步 触顶)
 *
 * 业务 目的:
 *   - 卡 8 explosive topic 加速 跑 到 9+ 触发 fission
 *   - 跟 现 score 实测 range 5.5-9.1 完美 对齐
 *   - 不 改 Supabase schema · 不 改 RPC · 只 改 worker 调用 点
 *
 * 约束 跟 限制:
 *   - 上限 3 (避 免 avalanche)
 *   - 下限 1 (跟 现 行为 backward-compat)
 *   - 输入 边界 容错: NaN / undefined / 负数 全部 fallback +1
 */
export type TopicDelta = 1 | 1.5 | 2 | 2.5 | 3;

export function mapNewsScoreToDelta(hotScore: number): TopicDelta {
  if (!Number.isFinite(hotScore) || hotScore < 6) return 1;
  if (hotScore < 7) return 1.5;
  if (hotScore < 8) return 2;
  if (hotScore < 9) return 2.5;
  return 3;
}
