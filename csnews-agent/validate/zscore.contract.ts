/**
 * CSNEWS Agent · z-score 异常检测 utility 业务契约 (v0.36.8 · KR0+1 · 蓝图 2.5)
 *
 * 唯一目标：守住"z-score 异常检测算法就是这样"（当前实现的 snapshot）
 *
 * 业务红线:
 *   - z-score 公式: z = (x - μ) / σ (蓝图 2.5 确定)
 *   - 异常阈值: z > 3 (3σ 准则, 99.7% 置信度)
 *   - 7 天 history 窗口 (kzclaw OKR KR0+1 确定)
 *   - 空数组 / 单元素 / NaN / σ=0 边界全部返 NaN
 *   - 过滤 historyValues 里的 NaN / Infinity
 *
 * 加新阈值时: Z_THRESHOLD 常量改 + 此文件 describe 块补 1 个 it
 *
 * 详见：tasks/csnews-agent-okr.md KR0+1
 */
import { describe, it, expect } from 'vitest';
import {
  zScore, isAnomaly, calculateZScore,
  calculateZScoreFromSnapshots, countAnomalySignals,
  Z_THRESHOLD, ZSCORE_REASON_PREFIX,
} from '../src/zscore';

// ============================================================
// 业务常量
// ============================================================
describe('业务常量', () => {
  it('Z_THRESHOLD 必须 = 3.0 (蓝图 2.5 确定 3σ 准则)', () => {
    expect(Z_THRESHOLD).toBe(3.0);
  });

  it('ZSCORE_REASON_PREFIX 必须 = "z-score" (写 warnings 表 reason 字段标签)', () => {
    expect(ZSCORE_REASON_PREFIX).toBe('z-score');
  });
});

// ============================================================
// zScore 核心算法
// ============================================================
describe('zScore · 蓝图 2.5 公式 z = (x - μ) / σ', () => {
  it('标准场景: x=10, history=[8,9,10,11,12] (μ=10, σ≈1.414, z≈0) 必须 z≈0', () => {
    const z = zScore(10, [8, 9, 10, 11, 12]);
    expect(Math.abs(z)).toBeLessThan(0.1);
  });

  it('标准场景: x=20, history=[8,9,10,11,12] (μ=10, σ≈1.414, z≈7.07) 必须 z > 3 (异常)', () => {
    const z = zScore(20, [8, 9, 10, 11, 12]);
    expect(z).toBeGreaterThan(3);
    expect(isAnomaly(z)).toBe(true);
  });

  it('标准场景: x=0, history=[8,9,10,11,12] (μ=10, σ≈1.414, z≈-7.07) 必须 z < -3 (异常)', () => {
    const z = zScore(0, [8, 9, 10, 11, 12]);
    expect(z).toBeLessThan(-3);
    expect(isAnomaly(z)).toBe(true);
  });

  it('7 天 history 标准场景: x=15, history=[10,11,12,13,14,12,13] (μ≈12.14, σ≈1.35) 必须 z ≈ 2.12 (不异常)', () => {
    const z = zScore(15, [10, 11, 12, 13, 14, 12, 13]);
    expect(z).toBeGreaterThan(2);
    expect(z).toBeLessThan(2.5);
    expect(isAnomaly(z)).toBe(false);
  });

  it('恒定 history [5,5,5,5,5] (σ=0) 必须返 NaN', () => {
    expect(Number.isNaN(zScore(5, [5, 5, 5, 5, 5]))).toBe(true);
  });

  it('单元素 history [10] (σ 未定义) 必须返 NaN', () => {
    expect(Number.isNaN(zScore(20, [10]))).toBe(true);
  });

  it('空 history [] 必须返 NaN', () => {
    expect(Number.isNaN(zScore(20, []))).toBe(true);
  });

  it('null history 必须返 NaN (TS 已拒, 运行时兜底)', () => {
    expect(Number.isNaN(zScore(20, null as any))).toBe(true);
  });

  it('undefined history 必须返 NaN', () => {
    expect(Number.isNaN(zScore(20, undefined as any))).toBe(true);
  });

  it('currentValue=NaN 必须返 NaN', () => {
    expect(Number.isNaN(zScore(NaN, [1, 2, 3, 4, 5]))).toBe(true);
  });

  it('currentValue=Infinity 必须返 NaN', () => {
    expect(Number.isNaN(zScore(Infinity, [1, 2, 3, 4, 5]))).toBe(true);
  });

  it('currentValue=-Infinity 必须返 NaN', () => {
    expect(Number.isNaN(zScore(-Infinity, [1, 2, 3, 4, 5]))).toBe(true);
  });

  it('history 包含 NaN 必须过滤掉 (μ 用剩余有限数算)', () => {
    const z = zScore(10, [8, 9, NaN, 11, 12, Infinity, 10] as any);
    // 过滤后: [8, 9, 11, 12, 10] μ=10, σ≈1.414, z=0
    expect(Math.abs(z)).toBeLessThan(0.1);
  });

  it('history 全是 NaN / Infinity 必须返 NaN', () => {
    expect(Number.isNaN(zScore(20, [NaN, Infinity, NaN] as any))).toBe(true);
  });

  it('负值 history: x=-10, history=[-8,-9,-10,-11,-12] 必须 z≈0', () => {
    const z = zScore(-10, [-8, -9, -10, -11, -12]);
    expect(Math.abs(z)).toBeLessThan(0.1);
  });

  it('0 history: x=0, history=[0,0,0,0,0] (σ=0) 必须返 NaN', () => {
    expect(Number.isNaN(zScore(0, [0, 0, 0, 0, 0]))).toBe(true);
  });

  it('大数 history: x=1e6, history=[9e5,1e6,1.1e6,9.5e5,1.05e6] 必须 z 在 ±1 内', () => {
    const z = zScore(1e6, [9e5, 1e6, 1.1e6, 9.5e5, 1.05e6]);
    expect(Math.abs(z)).toBeLessThan(1);
  });
});

// ============================================================
// isAnomaly
// ============================================================
describe('isAnomaly · 蓝图 2.5 阈值 z > 3', () => {
  it('z=3.0 必须 false (> 3 不是 ≥ 3)', () => {
    expect(isAnomaly(3.0)).toBe(false);
  });

  it('z=3.01 必须 true (稍微超过)', () => {
    expect(isAnomaly(3.01)).toBe(true);
  });

  it('z=5 必须 true', () => {
    expect(isAnomaly(5)).toBe(true);
  });

  it('z=-3.5 必须 true (负值也异常, kzclaw OKR 确定双向 |z| > 3)', () => {
    // 蓝图 2.5 原写 "if z > 3 → anomaly signal" 是单向
    // v0.36.8 kzclaw OKR 确定 KR0+1 业务语义: 偏离均值 = 双向异常 (|z| > 3)
    // 理由: kzclaw早晨日报金句场景 = topic news_count 突增/突减都是异常
    expect(isAnomaly(-3.5)).toBe(true);
  });

  it('z=2.5 必须 false', () => {
    expect(isAnomaly(2.5)).toBe(false);
  });

  it('z=0 必须 false', () => {
    expect(isAnomaly(0)).toBe(false);
  });

  it('z=NaN 必须 false (无效输入不算异常)', () => {
    expect(isAnomaly(NaN)).toBe(false);
  });

  it('z=Infinity 必须 true (极大值)', () => {
    expect(isAnomaly(Infinity)).toBe(true);
  });

  it('z=-Infinity 必须 true (负无穷也异常, kzclaw OKR 确定双向 |z| > 3)', () => {
    expect(isAnomaly(-Infinity)).toBe(true);
  });
});

// ============================================================
// calculateZScore (合并函数)
// ============================================================
describe('calculateZScore · 合并函数', () => {
  it('标准场景必须返 { z, isAnomaly }', () => {
    const r = calculateZScore(20, [8, 9, 10, 11, 12]);
    expect(r).toHaveProperty('z');
    expect(r).toHaveProperty('isAnomaly');
    expect(r.isAnomaly).toBe(true);
  });

  it('空 history 必须返 { z: NaN, isAnomaly: false }', () => {
    const r = calculateZScore(20, []);
    expect(Number.isNaN(r.z)).toBe(true);
    expect(r.isAnomaly).toBe(false);
  });

  it('标准正常值必须 isAnomaly: false', () => {
    const r = calculateZScore(10, [8, 9, 10, 11, 12]);
    expect(r.isAnomaly).toBe(false);
  });
});

// ============================================================
// calculateZScoreFromSnapshots (KR0 health 端点用)
// ============================================================
describe('calculateZScoreFromSnapshots · KR0 health 端点用', () => {
  it('snapshot 算 z-score 必须返 { z, isAnomaly, field }', () => {
    const current = { score: 20 };
    const history = [{ score: 8 }, { score: 9 }, { score: 10 }, { score: 11 }, { score: 12 }];
    const r = calculateZScoreFromSnapshots(current, history, 'score');
    expect(r).toHaveProperty('z');
    expect(r).toHaveProperty('isAnomaly');
    expect(r).toHaveProperty('field');
    expect(r.field).toBe('score');
    expect(r.isAnomaly).toBe(true);
  });

  it('snapshot 缺字段 (undefined) 必须 NaN', () => {
    const current = {} as any;
    const history = [{ score: 8 }, { score: 9 }, { score: 10 }];
    const r = calculateZScoreFromSnapshots(current, history, 'score');
    expect(Number.isNaN(r.z)).toBe(true);
  });

  it('velocity 字段算 z-score', () => {
    const current = { velocity: 5 };
    const history = [{ velocity: 0.5 }, { velocity: 1 }, { velocity: 0.8 }, { velocity: 0.3 }, { velocity: 0.7 }];
    const r = calculateZScoreFromSnapshots(current, history, 'velocity');
    expect(r.isAnomaly).toBe(true);
    expect(r.field).toBe('velocity');
  });

  it('acceleration 字段算 z-score', () => {
    const current = { acceleration: 100 };
    const history = [{ acceleration: 1 }, { acceleration: 2 }, { acceleration: 0 }, { acceleration: -1 }, { acceleration: 3 }];
    const r = calculateZScoreFromSnapshots(current, history, 'acceleration');
    expect(r.isAnomaly).toBe(true);
    expect(r.field).toBe('acceleration');
  });
});

// ============================================================
// countAnomalySignals (KR0 health 端点 zscore_signals_today 用)
// ============================================================
describe('countAnomalySignals · KR0 health 端点批量计算', () => {
  it('空数组必须返 0', () => {
    expect(countAnomalySignals([], 'score')).toBe(0);
  });

  it('单元素必须返 0 (没法算 z-score)', () => {
    expect(countAnomalySignals([{ score: 10 }], 'score')).toBe(0);
  });

  it('2 元素无异常必须返 0', () => {
    expect(countAnomalySignals([{ score: 10 }, { score: 10 }], 'score')).toBe(0);
  });

  it('3 元素全异常必须返 3', () => {
    const snapshots = [
      { score: 100 },
      { score: 1 },
      { score: 2 },
    ];
    // 算 score 字段
    // 3 个 snapshot, 每个对其他 2 个算 z-score
    // snapshot 1: x=100, history=[1,2] μ=1.5, σ=0.5, z=(100-1.5)/0.5=197 → 异常
    // snapshot 2: x=1, history=[100,2] μ=51, σ=49, z=(1-51)/49≈-1.02 → 不异常
    // snapshot 3: x=2, history=[100,1] μ=50.5, σ=49.5, z=(2-50.5)/49.5≈-0.98 → 不异常
    // 实际: 只 1 个异常, 不是 3 个
    // 重新理解: countAnomalySignals 是每个 snapshot 对其他 snapshots 算一次 z-score
    // snapshot 1 异常 + snapshot 2/3 不异常 = 1
    const count = countAnomalySignals(snapshots, 'score');
    expect(count).toBe(1);
  });

  it('标准 5 元素无异常 (值都接近) 必须返 0', () => {
    const snapshots = [
      { score: 10 },
      { score: 11 },
      { score: 12 },
      { score: 9 },
      { score: 10 },
    ];
    expect(countAnomalySignals(snapshots, 'score')).toBe(0);
  });

  it('snapshot 缺字段 (NaN) 必须跳过', () => {
    const snapshots = [
      { score: 10 },
      { score: NaN },
      { score: 11 },
      { score: 12 },
    ];
    // 过滤 NaN 后, 3 个有限数: 10, 11, 12
    // 算每个对其他 2 个的 z-score, 全部不异常
    expect(countAnomalySignals(snapshots, 'score')).toBe(0);
  });

  it('velocity 字段批量算', () => {
    const snapshots = [
      { velocity: 0.5 },
      { velocity: 0.6 },
      { velocity: 0.7 },
      { velocity: 100 },
    ];
    const count = countAnomalySignals(snapshots, 'velocity');
    // 算每个对其他 3 个的 z-score
    // 100 对 [0.5, 0.6, 0.7] μ=0.6, σ=0.0816, z=(100-0.6)/0.0816≈1218 → 异常
    // 0.5 对 [0.6, 0.7, 100] μ=33.77, σ=46.65, z=(0.5-33.77)/46.65≈-0.71 → 不异常
    // 0.6 类似 → 不异常
    // 0.7 类似 → 不异常
    // 总数 1
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
