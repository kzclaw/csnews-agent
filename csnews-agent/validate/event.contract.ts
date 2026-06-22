/**
 * CSNEWS Agent · event 业务契约 (v0.36.11)
 *
 * kzclaw 16:48 确定:
 *   - Jaccard entity_overlap 聚类 + threshold 自适应
 *   - threshold 0.4 起步 + kzclaw review 反馈驱动 ±0.05
 *   - 0 DDL = 聚类结果暂存 R2 event-clusters.json
 *
 * 详见：tasks/csnews-agent-okr.md (本地私密 OKR 文档, 不入库)
 */
import { describe, it, expect } from 'vitest';
import {
  THRESHOLD_DEFAULT,
  THRESHOLD_STEP,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  nextThreshold,
  loadThresholdHistory,
  recordReview,
  getCurrentThreshold,
  type ThresholdHistory,
} from '../src/event-threshold';
import { entityOverlapJaccard, runEventClustering, type EventCluster } from '../src/event-cluster';
import {
  runEventProcess,
  EVENT_CLUSTERS_R2_KEY,
  EVENT_CLUSTERS_INDEX_R2_KEY,
} from '../src/event-process';
import type { EntityFinalized } from '../src/entity-process';

// ============================================================
// 业务常量
// ============================================================
describe('event 业务常量', () => {
  it('THRESHOLD_DEFAULT 必须 = 0.4 (蓝图 v0.35+ 公式)', () => {
    expect(THRESHOLD_DEFAULT).toBe(0.4);
  });

  it('THRESHOLD_STEP 必须 = 0.05 (kzclaw 16:48 确定 review 反馈驱动 step)', () => {
    expect(THRESHOLD_STEP).toBe(0.05);
  });

  it('THRESHOLD_MIN 必须 = 0.1 (更严不能 < 0.1)', () => {
    expect(THRESHOLD_MIN).toBe(0.1);
  });

  it('THRESHOLD_MAX 必须 = 0.9 (更宽不能 > 0.9)', () => {
    expect(THRESHOLD_MAX).toBe(0.9);
  });

  it('EVENT_CLUSTERS_R2_KEY 必须 = "event-clusters.json"', () => {
    expect(EVENT_CLUSTERS_R2_KEY).toBe('event-clusters.json');
  });

  it('EVENT_CLUSTERS_INDEX_R2_KEY 必须 = "event-clusters-index.json"', () => {
    expect(EVENT_CLUSTERS_INDEX_R2_KEY).toBe('event-clusters-index.json');
  });
});

// ============================================================
// 0 硬编码保证: 没有固定 threshold 写死
// ============================================================
describe('0 硬编码保证', () => {
  it('event-cluster.ts 必须 0 硬编码固定 threshold (读 event-threshold.ts 自适应)', async () => {
    const mod = await import('../src/event-cluster');
    // 业务红线: 没有写死 0.4 / 0.5 等固定 threshold
    expect((mod as any).THRESHOLD_FIXED).toBeUndefined();
  });

  it('event-threshold.ts 必须 0 硬编码 review 逻辑 (纯 step 函数)', async () => {
    const mod = await import('../src/event-threshold');
    expect((mod as any).THRESHOLD_FIXED).toBeUndefined();
  });
});

// ============================================================
// nextThreshold
// ============================================================
describe('nextThreshold · review 反馈驱动', () => {
  it('correct (聚类对) → threshold +0.05 (更宽, 接受更多 entity 共享)', () => {
    expect(nextThreshold(0.4, 'correct')).toBeCloseTo(0.45, 5);
  });

  it('incorrect (聚类错) → threshold -0.05 (更严, 只接受更明确共享)', () => {
    expect(nextThreshold(0.4, 'incorrect')).toBeCloseTo(0.35, 5);
  });

  it('THRESHOLD_MIN clamp: incorrect 不能 < 0.1', () => {
    expect(nextThreshold(0.1, 'incorrect')).toBe(0.1);
    expect(nextThreshold(0.05, 'incorrect')).toBe(0.1);
  });

  it('THRESHOLD_MAX clamp: correct 不能 > 0.9', () => {
    expect(nextThreshold(0.9, 'correct')).toBe(0.9);
    expect(nextThreshold(0.95, 'correct')).toBe(0.9);
  });
});

// ============================================================
// entityOverlapJaccard
// ============================================================
describe('entityOverlapJaccard · Jaccard 公式', () => {
  it('空集合 ∩ 空集合 = 0', () => {
    expect(entityOverlapJaccard([], [])).toBe(0);
  });

  it('相同集合 Jaccard = 1', () => {
    expect(entityOverlapJaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('完全不同集合 Jaccard = 0', () => {
    expect(entityOverlapJaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('部分重叠 Jaccard = 0.5 (2 共享 / 4 总)', () => {
    expect(entityOverlapJaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('A ⊂ B 完整包含 (|A ∩ B| = |A|, |A ∪ B| = |B|)', () => {
    // A = [a], B = [a, b] → 交集 1, 并集 2 → 0.5
    expect(entityOverlapJaccard(['a'], ['a', 'b'])).toBe(0.5);
  });

  it('B ⊂ A 完整包含', () => {
    expect(entityOverlapJaccard(['a', 'b'], ['a'])).toBe(0.5);
  });
});

// ============================================================
// loadThresholdHistory / recordReview / getCurrentThreshold
// ============================================================
describe('loadThresholdHistory · 读 R2 threshold history', () => {
  it('R2 无 history → 返 freshHistory (current=0.4, history=[])', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const history = await loadThresholdHistory(env);
    expect(history.current).toBe(0.4);
    expect(history.history).toEqual([]);
  });

  it('R2 返 history JSON → 透传', async () => {
    const stored: ThresholdHistory = {
      current: 0.5,
      history: [
        {
          ts: '2026-06-16T08:00:00Z',
          old_value: 0.4,
          new_value: 0.5,
          review_type: 'correct',
          reason: 'test',
        },
      ],
      updated_at: '2026-06-16T08:00:00Z',
    };
    const env: any = { csnews_raw: { get: async () => ({ json: async () => stored }) } };
    const history = await loadThresholdHistory(env);
    expect(history.current).toBe(0.5);
    expect(history.history.length).toBe(1);
  });
});

describe('recordReview · kzclaw review 反馈 → threshold 自动微调', () => {
  it('首次 correct review → current 0.4 → 0.45', async () => {
    let putCalled = false;
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async (key: string, value: string) => {
          putCalled = true;
          return {};
        },
      },
    };
    const updated = await recordReview(env, 'correct');
    expect(updated.current).toBeCloseTo(0.45, 5);
    expect(putCalled).toBe(true);
    expect(updated.history.length).toBe(1);
    expect(updated.history[0].review_type).toBe('correct');
    expect(updated.history[0].old_value).toBe(0.4);
    expect(updated.history[0].new_value).toBeCloseTo(0.45, 5);
  });

  it('首次 incorrect review → current 0.4 → 0.35', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async () => ({}),
      },
    };
    const updated = await recordReview(env, 'incorrect');
    expect(updated.current).toBeCloseTo(0.35, 5);
  });

  it('review 多次 → history 累加', async () => {
    let stored: ThresholdHistory = {
      current: 0.4,
      history: [],
      updated_at: new Date().toISOString(),
    };
    const env: any = {
      csnews_raw: {
        get: async () => ({ json: async () => stored }),
        put: async (_key: string, value: string) => {
          stored = JSON.parse(value);
          return {};
        },
      },
    };
    await recordReview(env, 'correct');
    await recordReview(env, 'correct');
    await recordReview(env, 'incorrect');
    expect(stored.history.length).toBe(3);
    expect(stored.current).toBeCloseTo(0.45, 5); // 0.4 → 0.45 → 0.5 → 0.45
  });
});

describe('getCurrentThreshold · 0 确定点 = 自动从 R2 读', () => {
  it('R2 无 → 返 0.4 (THRESHOLD_DEFAULT)', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const t = await getCurrentThreshold(env);
    expect(t).toBe(0.4);
  });

  it('R2 有 → 返最新 current', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => ({ json: async () => ({ current: 0.55, history: [], updated_at: '' }) }),
      },
    };
    const t = await getCurrentThreshold(env);
    expect(t).toBe(0.55);
  });
});

// ============================================================
// runEventClustering
// ============================================================
describe('runEventClustering · Jaccard 聚类', () => {
  it('空 entities → 0 clusters', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const result = await runEventClustering(env, []);
    expect(result.clusters.length).toBe(0);
    expect(result.threshold).toBe(0.4);
  });

  it('单 entity → 1 cluster', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const entities: EntityFinalized[] = [
      {
        name: '伊朗',
        type: 'place',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-16T00:00:00Z',
        last_seen: '2026-06-16T00:00:00Z',
        mention_count: 1,
      },
    ];
    const result = await runEventClustering(env, entities);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].entity_names).toEqual(['伊朗']);
  });

  it('多 entity → 多个 cluster + jaccard_pairs = N*(N-1)/2', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const entities: EntityFinalized[] = [
      {
        name: '伊朗',
        type: 'place',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '',
        last_seen: '',
        mention_count: 1,
      },
      {
        name: '美国',
        type: 'place',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '',
        last_seen: '',
        mention_count: 1,
      },
      {
        name: '日本',
        type: 'place',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '',
        last_seen: '',
        mention_count: 1,
      },
    ];
    const result = await runEventClustering(env, entities);
    expect(result.jaccard_pairs).toBe(3); // C(3,2) = 3
    expect(result.threshold).toBe(0.4);
  });
});

// ============================================================
// runEventProcess · kzclaw 0 DDL = 暂存 R2
// ============================================================
describe('runEventProcess · kzclaw 0 DDL = 暂存 R2 event-clusters.json', () => {
  it('R2 无 candidates → clusters=0, errors=0', async () => {
    const env: any = { csnews_raw: { get: async () => null, put: async () => ({}) } };
    const result = await runEventProcess(env);
    expect(result.clusters).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('R2 有 candidates → 写 R2 event-clusters.json + index', async () => {
    const candidates = [
      {
        name: '伊朗',
        type: 'place',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-16T00:00:00Z',
        last_seen: '2026-06-16T00:00:00Z',
        mention_count: 1,
      },
    ];
    const putCalls: { key: string; value: string }[] = [];
    const env: any = {
      csnews_raw: {
        get: async (key: string) => {
          if (key === 'entity-candidates.json') {
            return { json: async () => ({ candidates }) };
          }
          return null;
        },
        put: async (key: string, value: string) => {
          putCalls.push({ key, value });
          return {};
        },
      },
    };
    const result = await runEventProcess(env);
    expect(result.written).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(putCalls.length).toBe(2);
    expect(putCalls.some((c) => c.key === EVENT_CLUSTERS_R2_KEY)).toBe(true);
    expect(putCalls.some((c) => c.key === EVENT_CLUSTERS_INDEX_R2_KEY)).toBe(true);
  });

  it('R2 读失败 → errors=1 (兜底)', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => {
          throw new Error('R2 unavailable');
        },
        put: async () => ({}),
      },
    };
    const result = await runEventProcess(env);
    expect(result.errors).toBe(1);
  });
});
