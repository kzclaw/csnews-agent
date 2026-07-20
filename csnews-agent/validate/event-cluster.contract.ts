/**
 * Business contract tests for event-cluster.ts.
 * Covers Jaccard entity overlap, UnionFind clustering, and runEventClustering pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockR2Bucket } from '../test-helpers';
import type { EntityFinalized } from '../src/entity-process';

// =============================================================================
// entityOverlapJaccard — pure function tests
// =============================================================================

describe('entityOverlapJaccard — Jaccard entity overlap formula', async () => {
  const { entityOverlapJaccard } = await import('../src/event-cluster');

  it('returns 1.0 for identical entity sets', () => {
    const a = ['字节跳动', '腾讯', '阿里'];
    const b = ['字节跳动', '腾讯', '阿里'];
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for completely disjoint sets', () => {
    const a = ['字节跳动'];
    const b = ['谷歌'];
    expect(entityOverlapJaccard(a, b)).toBe(0);
  });

  it('returns 0.0 for two empty sets', () => {
    expect(entityOverlapJaccard([], [])).toBe(0);
  });

  it('returns 0.0 for one empty set and one non-empty', () => {
    expect(entityOverlapJaccard([], ['字节跳动'])).toBe(0);
    expect(entityOverlapJaccard(['字节跳动'], [])).toBe(0);
  });

  it('returns correct Jaccard for partial overlap', () => {
    const a = ['字节跳动', '腾讯', '阿里'];
    const b = ['字节跳动', '腾讯', '谷歌'];
    // intersection = {字节跳动, 腾讯} = 2
    // union = 3 + 3 - 2 = 4
    // Jaccard = 2/4 = 0.5
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(0.5, 5);
  });

  it('handles duplicates in input arrays (uses Set internally)', () => {
    const a = ['字节跳动', '字节跳动', '腾讯'];
    const b = ['字节跳动', '腾讯', '腾讯'];
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(1.0, 5);
  });

  it('is commutative: J(A, B) === J(B, A)', () => {
    const a = ['字节跳动', '腾讯', '阿里', '美团'];
    const b = ['字节跳动', '谷歌', '亚马逊', '美团'];
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(entityOverlapJaccard(b, a), 5);
  });

  it('produces values in [0, 1] range', () => {
    const pairs: [string[], string[]][] = [
      [['A', 'B', 'C'], ['D', 'E', 'F']],
      [['A', 'B'], ['B', 'C']],
      [['X'], ['X', 'Y', 'Z']],
    ];
    for (const [a, b] of pairs) {
      const j = entityOverlapJaccard(a, b);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(1);
    }
  });

  it('handles single shared entity correctly', () => {
    const a = ['字节跳动'];
    const b = ['字节跳动', '腾讯'];
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(0.5, 5);
  });

  it('handles large identical entity sets', () => {
    const a = Array.from({ length: 50 }, (_, i) => `entity-${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `entity-${i}`);
    expect(entityOverlapJaccard(a, b)).toBeCloseTo(1.0, 5);
  });
});

// =============================================================================
// EventCluster interface shape
// =============================================================================

describe('EventCluster interface — shape validation', async () => {
  const { EventCluster } = await import('../src/event-cluster');

  it('has required fields', () => {
    const cluster: EventCluster = {
      cluster_id: 'cluster-0-2',
      entity_names: ['字节跳动', '腾讯'],
      entity_count: 2,
      jaccard_pairs: 10,
      created_at: '2024-06-01T00:00:00Z',
      reviewed: 'pending',
    };
    expect(cluster.cluster_id).toBe('cluster-0-2');
    expect(cluster.entity_count).toBe(2);
    expect(cluster.reviewed).toBe('pending');
  });

  it('reviewed can be pending, correct, or incorrect', () => {
    const pending: EventCluster = {
      cluster_id: 'c1', entity_names: [], entity_count: 0, jaccard_pairs: 0,
      created_at: '', reviewed: 'pending',
    };
    const correct: EventCluster = {
      cluster_id: 'c2', entity_names: [], entity_count: 0, jaccard_pairs: 0,
      created_at: '', reviewed: 'correct',
    };
    const incorrect: EventCluster = {
      cluster_id: 'c3', entity_names: [], entity_count: 0, jaccard_pairs: 0,
      created_at: '', reviewed: 'incorrect',
    };
    expect(pending.reviewed).toBe('pending');
    expect(correct.reviewed).toBe('correct');
    expect(incorrect.reviewed).toBe('incorrect');
  });
});

// =============================================================================
// runEventClustering — pipeline with proper R2 mocking
// =============================================================================

describe('runEventClustering — clustering pipeline', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * R2 mock that supports both .text() and .json() for threshold history tests.
   */
  function createJsonR2Bucket(objects: Record<string, string> = {}): any {
    const store: Record<string, string> = { ...objects };
    return {
      get: async (key: string) => {
        if (!(key in store)) return null;
        const value = store[key];
        return {
          text: async () => value,
          json: async () => JSON.parse(value),
        };
      },
      put: async (key: string, value: string) => { store[key] = value; },
      head: async (key: string) => key in store ? { size: store[key].length } : null,
      list: async () => ({ keys: Object.keys(store).map(name => ({ name })) }),
    };
  }

  function makeMockEnv(threshold = 0.4): any {
    return {
      csnews_raw: createJsonR2Bucket({
        'event-threshold-history.json': JSON.stringify({
          current: threshold,
          history: [],
          updated_at: '2024-01-01T00:00:00Z',
        }),
      }),
    };
  }

  it('returns empty clusters for empty input', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const result = await runEventClustering(makeMockEnv(), []);
    expect(result.clusters).toEqual([]);
  });

  it('each cluster has cluster_id, entity_names, entity_count, created_at, reviewed', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '字节', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 5, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    expect(result.clusters.length).toBeGreaterThan(0);
    for (const cluster of result.clusters) {
      expect(typeof cluster.cluster_id).toBe('string');
      expect(Array.isArray(cluster.entity_names)).toBe(true);
      expect(typeof cluster.entity_count).toBe('number');
      expect(typeof cluster.created_at).toBe('string');
      expect(['pending', 'correct', 'incorrect']).toContain(cluster.reviewed);
    }
  });

  it('entity_count in cluster matches entity_names length', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '甲', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 1, last_seen: '', first_seen: '' },
      { id: '2', name: '乙', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 1, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    for (const cluster of result.clusters) {
      expect(cluster.entity_count).toBe(cluster.entity_names.length);
    }
  });

  it('cluster_id format is stable (cluster-N-M)', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '测试', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 1, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    expect(result.clusters[0].cluster_id).toMatch(/^cluster-\d+-\d+$/);
  });

  it('jaccard_pairs is non-negative integer', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '甲', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 1, last_seen: '', first_seen: '' },
      { id: '2', name: '乙', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 1, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    expect(result.jaccard_pairs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.jaccard_pairs)).toBe(true);
  });

  it('jaccard_pairs = n*(n-1)/2 for n unique entity names', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const makeEntities = (n: number): EntityFinalized[] =>
      Array.from({ length: n }, (_, i) => ({
        id: String(i), name: `entity-${i}`, type: 'org' as const,
        source: 'selflearn' as const, confidence: 0.5, mention_count: 1,
        last_seen: '', first_seen: '',
      }));

    const r2 = await runEventClustering(makeMockEnv(), makeEntities(2));
    expect(r2.jaccard_pairs).toBe(1);

    const r3 = await runEventClustering(makeMockEnv(), makeEntities(3));
    expect(r3.jaccard_pairs).toBe(3);

    const r5 = await runEventClustering(makeMockEnv(), makeEntities(5));
    expect(r5.jaccard_pairs).toBe(10);
  });

  it('threshold is returned and is a number in (0, 1]', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const result = await runEventClustering(makeMockEnv(), []);
    expect(typeof result.threshold).toBe('number');
    expect(result.threshold).toBeGreaterThan(0);
    expect(result.threshold).toBeLessThanOrEqual(1);
  });

  it('identical entity names deduplicate to single unique name', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '特斯拉', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 5, last_seen: '', first_seen: '' },
      { id: '2', name: '特斯拉', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 3, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    // uniqueNames via Set deduplicates → 1 unique name
    expect(result.clusters.length).toBe(1);
  });

  it('uses threshold from R2 history', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    // Threshold history in R2 specifies 0.7
    const result = await runEventClustering(makeMockEnv(0.7), []);
    expect(result.threshold).toBe(0.7);
  });

  it('defaults to 0.4 when threshold history is absent', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    // Empty R2 → loadThresholdHistory returns freshHistory with default 0.4
    const emptyEnv = { csnews_raw: createJsonR2Bucket({}) };
    const result = await runEventClustering(emptyEnv, []);
    expect(result.threshold).toBe(0.4);
  });

  it('total clusters <= number of unique entity names', async () => {
    const { runEventClustering } = await import('../src/event-cluster');
    const entities: EntityFinalized[] = [
      { id: '1', name: '甲', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 5, last_seen: '', first_seen: '' },
      { id: '2', name: '乙', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 3, last_seen: '', first_seen: '' },
      { id: '3', name: '丙', type: 'org', source: 'selflearn', confidence: 0.5, mention_count: 2, last_seen: '', first_seen: '' },
    ];
    const result = await runEventClustering(makeMockEnv(), entities);
    // Each unique name → at most one cluster per name
    expect(result.clusters.length).toBeLessThanOrEqual(entities.length);
  });
});
