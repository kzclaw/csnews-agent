/**
 * v0.37.37 (拍板 B): Topic Delta 5 档 映射 unit test
 *
 * mapNewsScoreToDelta: news hot_score 0-10 → topic delta 1-3
 * 期望 case:
 *   - <6 → +1
 *   - 6-7 (含 6 不含 7) → +1.5
 *   - 7-8 → +2
 *   - 8-9 → +2.5
 *   - ≥9 → +3
 * 容错: NaN / undefined / 负数 / 超 10 → +1 fallback
 */
import { describe, it, expect } from 'vitest';
import { mapNewsScoreToDelta } from '../src/topic-delta';

describe('mapNewsScoreToDelta · 5 档 平滑 映射 (v0.37.37 拍板 B)', () => {
  it('<6 (低分) → +1 (跟 现 行为 一致)', () => {
    expect(mapNewsScoreToDelta(5.5)).toBe(1);
    expect(mapNewsScoreToDelta(5.9)).toBe(1);
    expect(mapNewsScoreToDelta(0)).toBe(1);
  });

  it('6-7 (中等) → +1.5', () => {
    expect(mapNewsScoreToDelta(6.0)).toBe(1.5);
    expect(mapNewsScoreToDelta(6.5)).toBe(1.5);
    expect(mapNewsScoreToDelta(6.99)).toBe(1.5);
  });

  it('7-8 (中高) → +2', () => {
    expect(mapNewsScoreToDelta(7.0)).toBe(2);
    expect(mapNewsScoreToDelta(7.5)).toBe(2);
    expect(mapNewsScoreToDelta(7.99)).toBe(2);
  });

  it('8-9 (高, 卡 8 explosive 加速) → +2.5', () => {
    expect(mapNewsScoreToDelta(8.0)).toBe(2.5);
    expect(mapNewsScoreToDelta(8.5)).toBe(2.5);
    expect(mapNewsScoreToDelta(8.99)).toBe(2.5);
  });

  it('≥9 (超高) → +3', () => {
    expect(mapNewsScoreToDelta(9.0)).toBe(3);
    expect(mapNewsScoreToDelta(9.1)).toBe(3);
    expect(mapNewsScoreToDelta(10)).toBe(3);
  });

  // 容错 5 重: 边界 + 异常 输入
  it('容错 NaN / Infinity fallback +1 (avoid worker hang)', () => {
    expect(mapNewsScoreToDelta(NaN)).toBe(1);
    expect(mapNewsScoreToDelta(Infinity)).toBe(1);
  });

  it('容错 负数 fallback +1', () => {
    expect(mapNewsScoreToDelta(-1)).toBe(1);
    expect(mapNewsScoreToDelta(-100)).toBe(1);
  });

  it('超 10 (clamped 高分) → +3 (跟 ≥9 同 档 clamp)', () => {
    expect(mapNewsScoreToDelta(11)).toBe(3);
    expect(mapNewsScoreToDelta(50)).toBe(3);
  });
});
