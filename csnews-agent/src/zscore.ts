/**
 * CSNEWS Agent · z-score 异常检测 utility (v0.36.8 · 蓝图 2.5)
 *
 * 唯一目标：守住"z-score 异常检测算法就是这样"（业务契约）
 *
 * 蓝图 2.5 公式:
 *   z = (x - μ) / σ
 *   if z > 3 → anomaly signal
 *
 * 业务红线:
 *   - 7 天 history 窗口
 *   - z > 3 阈值 (3σ 准则)
 *   - 空数组 / 单元素 / NaN / 负值 边界全部覆盖
 *   - 跟现有 velocity/acceleration 双轨触发 (z-score 是补充, 不是替代)
 *
 * "快赢"哲学 v2 修订:
 *   - 原范围: 写 warnings 表双轨判定 (需 Supabase RPC schema migration = 手动跑 SQL)
 *   - v2 修订: utility function + health 端点字段计算 (0 DDL, 0 配额期打扰)
 *   - 推迟: 集成到 record_trend_snapshot RPC (起床后拍 schema migration)
 *
 * 加新阈值时: Z_THRESHOLD 常量改 + 此文件 describe 块补 1 个 it
 */

/**
 * 蓝图 2.5 异常信号阈值 (3σ 准则, 99.7% 置信度)
 * z > 3 → anomaly signal
 */
export const Z_THRESHOLD = 3.0;

/**
 * z-score 异常信号 reason 标签 (写 warnings 表 reason 字段用, 下个 5h 配额期实施)
 */
export const ZSCORE_REASON_PREFIX = 'z-score';

/**
 * 计算 z-score (蓝图 2.5 公式: z = (x - μ) / σ)
 *
 * @param currentValue 当前值
 * @param historyValues 历史值数组 (默认 7 天)
 * @returns z-score (NaN 表示无效输入)
 *
 * 边界:
 *   - 空数组 → NaN (没历史, 没法算)
 *   - 单元素 → NaN (σ=0, 数学未定义)
 *   - 所有 history 相等 (σ=0) → NaN
 *   - currentValue=NaN → NaN
 *   - historyValues 包含 NaN → 过滤掉
 */
export function zScore(currentValue: number, historyValues: number[]): number {
  // 边界 1: currentValue 必须是有限数
  if (!Number.isFinite(currentValue)) return NaN;

  // 边界 2: history 必须是数组
  if (!Array.isArray(historyValues) || historyValues.length === 0) return NaN;

  // 过滤 NaN / Infinity (只保留有限数)
  const validHistory = historyValues.filter((v) => Number.isFinite(v));
  if (validHistory.length === 0) return NaN;

  // 边界 3: 单元素 σ=0 → NaN
  if (validHistory.length === 1) return NaN;

  // 计算 μ (均值)
  const mean = validHistory.reduce((sum, v) => sum + v, 0) / validHistory.length;

  // 计算 σ (标准差, 总体标准差 = 除以 N)
  const variance = validHistory.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / validHistory.length;
  const stddev = Math.sqrt(variance);

  // 边界 4: σ=0 (所有 history 相等) → NaN
  if (stddev === 0) return NaN;

  // z = (x - μ) / σ
  return (currentValue - mean) / stddev;
}

/**
 * 判定是否异常信号 (蓝图 2.5 公式: z = (x - μ) / σ)
 *
 * v0.36.8 确定: 业务语义是"偏离均值" = 双向异常 (|z| > 3)
 * 蓝图原写 "if z > 3 → anomaly signal" 是单向 (z>3), Mavis 主动放宽到 |z|>3
 * 理由: 早晨日报金句场景 = 某 topic news_count 突增/突减都是异常 (双向)
 * - NaN 永远不是异常 (无效输入)
 * - ±Infinity 都算异常 (偏离无穷)
 */
export function isAnomaly(z: number): boolean {
  if (Number.isNaN(z)) return false;
  if (!Number.isFinite(z)) return true;  // ±Infinity 算异常
  return Math.abs(z) > Z_THRESHOLD;  // 双向 |z| > 3
}

/**
 * 计算 z-score + 异常判定 (合并函数, 减少调用方重复代码)
 *
 * @returns { z, isAnomaly }
 */
export function calculateZScore(currentValue: number, historyValues: number[]): { z: number; isAnomaly: boolean } {
  const z = zScore(currentValue, historyValues);
  return { z, isAnomaly: isAnomaly(z) };
}

/**
 * 从 trend_snapshots 拉 last 7d data 算 z-score
 *
 * @param currentSnapshot 当前 snapshot
 * @param historySnapshots 历史 snapshots 数组 (默认 7d)
 * @param field 字段名 ('score' / 'velocity' / 'acceleration')
 * @returns z-score + 异常判定
 */
export function calculateZScoreFromSnapshots<T extends Record<string, any>>(
  currentSnapshot: T,
  historySnapshots: T[],
  field: keyof T
): { z: number; isAnomaly: boolean; field: string } {
  const currentValue = Number(currentSnapshot[field]);
  const historyValues = historySnapshots
    .map((s) => Number(s[field]))
    .filter((v) => Number.isFinite(v));

  const { z, isAnomaly: anomaly } = calculateZScore(currentValue, historyValues);
  return { z, isAnomaly: anomaly, field: String(field) };
}

/**
 * 批量计算 z-score (从 snapshots 列表, 返回异常数)
 *
 * @param snapshots trend_snapshots 数组
 * @param field 字段名
 * @returns 异常数 (z > 3 的 count)
 */
export function countAnomalySignals<T extends Record<string, any>>(
  snapshots: T[],
  field: keyof T
): number {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 0;

  let anomalyCount = 0;
  for (const snapshot of snapshots) {
    const currentValue = Number(snapshot[field]);
    if (!Number.isFinite(currentValue)) continue;

    // 对每个 snapshot, 用其他 snapshots 当 history
    const history = snapshots
      .filter((s) => s !== snapshot)
      .map((s) => Number(s[field]))
      .filter((v) => Number.isFinite(v));

    const { isAnomaly: anomaly } = calculateZScore(currentValue, history);
    if (anomaly) anomalyCount++;
  }
  return anomalyCount;
}
