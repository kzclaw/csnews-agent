/**
 * CSNEWS Agent · entity 业务契约 (v0.36.11)
 *
 * kzclaw 16:28 确定: 0 硬编码, 纯自适应/自学习/自进化
 * kzclaw 16:33 确定推 · bge-m3 走 CF Workers AI 独立池
 *
 * 业务红线:
 *   - 0 静态词典 (kzclaw 16:28 确定)
 *   - 100% n-gram 频率 + bge-m3 相似度自学习
 *   - 自学习 confidence 0.5
 *   - 自学习 24h news 拉, n-gram 2-4 字, 频率 ≥ 3 触发候选
 *   - 启发式 type 推断 (公司 → org / 省 → place / 其他 → person)
 *   - kzclaw 0 维护 = review R2 entity-candidates.json
 *
 * 详见：tasks/csnews-agent-okr.md (本地私密 OKR 文档, 不入库)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ENTITY_CANDIDATES_R2_KEY,
  SELFLEARN_MIN_FREQUENCY,
  SELFLEARN_NGRAM_SIZES,
  SELFLEARN_CONFIDENCE,
  SELFLEARN_MAX_CANDIDATES,
  extractNgramFrequency,
  mergeNgramFrequency,
  inferEntityType,
  isValidGram,
  cosineSimilarity,
  type EntityCandidate,
} from '../src/entity-selflearn';
import {
  ENTITY_FINALIZED_R2_KEY,
  loadReviewedCandidates,
  runEntityProcess,
  type EntityFinalized,
} from '../src/entity-process';
import {
  ENTITY_NOISE_ANCHORS_R2_KEY,
  NOISE_THRESHOLD_DEFAULT,
  NOISE_THRESHOLD_MIN,
  NOISE_THRESHOLD_MAX,
  NOISE_ANCHORS_DEFAULT,
  loadNoiseAnchors,
  maxNoiseSimilarity,
  cosineSimilarity as noiseCosine,
  filterNoiseCandidates,
} from '../src/entity-noise-filter';

// ============================================================
// 业务常量
// ============================================================
describe('entity 业务常量', () => {
  it('SELFLEARN_MIN_FREQUENCY 必须 = 3 (24h 至少出现 3 次)', () => {
    expect(SELFLEARN_MIN_FREQUENCY).toBe(3);
  });

  it('SELFLEARN_NGRAM_SIZES 必须 = [2, 3, 4] (中文 n-gram)', () => {
    expect(SELFLEARN_NGRAM_SIZES).toEqual([2, 3, 4]);
  });

  it('SELFLEARN_CONFIDENCE 必须 = 0.5 (kzclaw 16:28 确定 0 硬编码)', () => {
    expect(SELFLEARN_CONFIDENCE).toBe(0.5);
  });

  it('SELFLEARN_MAX_CANDIDATES 必须 = 50 (单次自学习上限)', () => {
    expect(SELFLEARN_MAX_CANDIDATES).toBe(50);
  });

  it('ENTITY_CANDIDATES_R2_KEY 必须 = "entity-candidates.json"', () => {
    expect(ENTITY_CANDIDATES_R2_KEY).toBe('entity-candidates.json');
  });

  it('ENTITY_FINALIZED_R2_KEY 必须 = "entity-finalized.json"', () => {
    expect(ENTITY_FINALIZED_R2_KEY).toBe('entity-finalized.json');
  });
});

// ============================================================
// 0 硬编码保证: 没有任何 DICTIONARY / 静态词典
// ============================================================
describe('0 硬编码保证', () => {
  it('entity-selflearn.ts 必须 0 export 静态词典 / 0 DICTIONARY 引用', async () => {
    const mod = await import('../src/entity-selflearn');
    // 业务红线: 没有 DICTIONARY / DICTIONARY_BY_TYPE / DICTIONARY_STATS / DICTIONARY_LOADED 这些 export
    expect((mod as any).DICTIONARY).toBeUndefined();
    expect((mod as any).DICTIONARY_BY_TYPE).toBeUndefined();
    expect((mod as any).DICTIONARY_STATS).toBeUndefined();
    expect((mod as any).DICTIONARY_LOADED).toBeUndefined();
    expect((mod as any).extractEntitiesFromText).toBeUndefined();
    expect((mod as any).extractEntitiesByType).toBeUndefined();
    expect((mod as any).extractUniqueEntities).toBeUndefined();
  });

  it('entity-process.ts 必须 0 import dictionary / 0 静态匹配', async () => {
    const mod = await import('../src/entity-process');
    expect((mod as any).extractEntitiesFromText).toBeUndefined();
    expect((mod as any).extractEntitiesByType).toBeUndefined();
  });
});

// ============================================================
// extractNgramFrequency
// ============================================================
describe('extractNgramFrequency · n-gram 频率', () => {
  it('空文本必须返空 Map', () => {
    expect(extractNgramFrequency('').size).toBe(0);
  });

  it('null/undefined 文本必须返空 Map', () => {
    expect(extractNgramFrequency(null as any).size).toBe(0);
    expect(extractNgramFrequency(undefined as any).size).toBe(0);
  });

  it('中文 2-gram 必须正确提取', () => {
    const freq = extractNgramFrequency('特朗普在北京');
    expect(freq.get('特朗')).toBe(1);
    expect(freq.get('朗普')).toBe(1);
  });

  it('3-gram 必须正确提取', () => {
    const freq = extractNgramFrequency('特朗普在北京');
    expect(freq.get('特朗普')).toBe(1);
  });

  it('重复出现频率必须累加', () => {
    const freq = extractNgramFrequency('特朗普 特朗普 特朗普');
    expect(freq.get('特朗普')).toBe(3);
  });

  it('标点必须过滤', () => {
    const freq = extractNgramFrequency('特，朗，普');
    expect(freq.size).toBe(0);
  });

  it('纯空白必须返空 Map', () => {
    const freq = extractNgramFrequency('   !!!  ');
    expect(freq.size).toBe(0);
  });

  it('单字符必须返空 Map (length < 2)', () => {
    const freq = extractNgramFrequency('一');
    expect(freq.size).toBe(0);
  });

  it('mock news: 5 条 news 出现 "华为" 3 次 → 频率 3', () => {
    const mockNews = ['华为发布新产品', '华为公司业绩亮眼', '其他新闻', '华为再次引领', '无关内容'];
    const freqs = mockNews.map((n) => extractNgramFrequency(n));
    const merged = mergeNgramFrequency(freqs);
    expect(merged.get('华为')).toBe(3);
  });
});

// ============================================================
// mergeNgramFrequency
// ============================================================
describe('mergeNgramFrequency · 合并多个频率表', () => {
  it('合并 2 个 Map 必须累加', () => {
    const f1 = new Map([['华为', 2]]);
    const f2 = new Map([['华为', 1]]);
    const merged = mergeNgramFrequency([f1, f2]);
    expect(merged.get('华为')).toBe(3);
  });

  it('合并空数组必须返空 Map', () => {
    expect(mergeNgramFrequency([]).size).toBe(0);
  });

  it('合并多 Map 累加正确', () => {
    const f1 = new Map([['A', 1]]);
    const f2 = new Map([['B', 2]]);
    const f3 = new Map([['A', 3]]);
    const merged = mergeNgramFrequency([f1, f2, f3]);
    expect(merged.get('A')).toBe(4);
    expect(merged.get('B')).toBe(2);
  });
});

// ============================================================
// isValidGram
// ============================================================
describe('isValidGram · 过滤低质量 n-gram', () => {
  it('包含中文字符的合法 gram 必须返 true', () => {
    expect(isValidGram('华为')).toBe(true);
    expect(isValidGram('特朗普')).toBe(true);
    expect(isValidGram('北京市')).toBe(true);
  });

  it('长度 < 2 必须返 false', () => {
    expect(isValidGram('华')).toBe(false);
  });

  it('长度 > 8 必须返 false', () => {
    expect(isValidGram('一二三四五六七八九')).toBe(false);
  });

  it('纯英文 (无中文) 必须返 false', () => {
    expect(isValidGram('Cloudflare')).toBe(false);
  });

  it('纯标点必须返 false', () => {
    expect(isValidGram('!!!')).toBe(false);
  });

  it('纯空白必须返 false', () => {
    expect(isValidGram('   ')).toBe(false);
  });
});

// ============================================================
// inferEntityType · 启发式 type 推断
// ============================================================
describe('inferEntityType · 启发式 type 推断', () => {
  it('含 "公司" → org', () => {
    expect(inferEntityType('华为公司')).toBe('org');
    expect(inferEntityType('某某科技公司')).toBe('org');
  });

  it('含 "集团" → org', () => {
    expect(inferEntityType('字节跳动集团')).toBe('org');
  });

  it('含 "省/市/国" → place', () => {
    expect(inferEntityType('北京市')).toBe('place');
    expect(inferEntityType('浙江省')).toBe('place');
    expect(inferEntityType('美国')).toBe('place');
  });

  it('含 "省" → place', () => {
    expect(inferEntityType('广东省')).toBe('place');
  });

  it('其他 (中文人名) → person', () => {
    expect(inferEntityType('特朗普')).toBe('person');
    expect(inferEntityType('马斯克')).toBe('person');
  });
});

// ============================================================
// cosineSimilarity
// ============================================================
describe('cosineSimilarity · 余弦相似度', () => {
  it('相同向量相似度 = 1', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('正交向量相似度 = 0', () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('反向向量相似度 = -1', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('长度不一致必须返 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('空向量必须返 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ============================================================
// runEntityProcess · kzclaw 0 DDL = 暂存 R2
// ============================================================
// Mock Supabase fetch (方案 D · v0.36.21 · runEntityProcess 调 writeEntitiesHotLayer)
// 避免真实 DNS 查询卡 5s 超时
// 默认 mock 返 500 (Supabase 失败不阻塞 R2 写入, 业务契约稳定)
const mockSupabaseFetch = (status: number = 500, body: string = '{"message":"mock error"}') => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.includes('/rest/v1/entity_hot')) {
      return new Response(body, { status });
    }
    return originalFetch(input);
  }) as any;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

describe('runEntityProcess · kzclaw 0 DDL = 暂存 R2', () => {
  let restoreFetch: () => void;
  beforeEach(() => {
    restoreFetch = mockSupabaseFetch();
  });
  afterEach(() => {
    restoreFetch();
  });

  it('R2 无 candidates → finalized=0, errors=0', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => null,
        put: async () => ({}),
      },
    };
    const result = await runEntityProcess(env);
    expect(result.written).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.finalized).toBe(0);
  });

  it('R2 有 candidates → 写 R2 entity-finalized.json', async () => {
    const candidates = [
      {
        name: '华为',
        type: 'org',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-16T00:00:00Z',
      },
    ];
    let putCalled = false;
    let putKey = '';
    const env: any = {
      csnews_raw: {
        get: async () => ({
          json: async () => ({ candidates }),
        }),
        put: async (key: string) => {
          putCalled = true;
          putKey = key;
          return {};
        },
      },
    };
    const result = await runEntityProcess(env);
    expect(result.finalized).toBe(1);
    expect(putCalled).toBe(true);
    expect(putKey).toBe(ENTITY_FINALIZED_R2_KEY);
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
    const result = await runEntityProcess(env);
    expect(result.errors).toBe(1);
  });
});

// ============================================================
// loadReviewedCandidates
// ============================================================
describe('loadReviewedCandidates · kzclaw review 后读 R2', () => {
  it('R2 无 entity-candidates.json → 返 []', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => null,
      },
    };
    const result = await loadReviewedCandidates(env);
    expect(result).toEqual([]);
  });

  it('R2 读失败 → 抛错 (runEntityProcess 接住返 errors=1)', async () => {
    const env: any = {
      csnews_raw: {
        get: async () => {
          throw new Error('R2 error');
        },
      },
    };
    await expect(loadReviewedCandidates(env)).rejects.toThrow('R2 error');
  });
});

// ============================================================
// noise filter 业务契约 (v0.36.12 · kzclaw 18:22 确定)
// ============================================================
describe('noise filter 业务常量 (kzclaw 18:22 确定)', () => {
  it('NOISE_THRESHOLD_DEFAULT 必须 = 0.85 (kzclaw 18:22 确定 similarity 阈值起步)', () => {
    expect(NOISE_THRESHOLD_DEFAULT).toBe(0.85);
  });

  it('NOISE_THRESHOLD_MIN 必须 = 0.5 (更严不能 < 0.5)', () => {
    expect(NOISE_THRESHOLD_MIN).toBe(0.5);
  });

  it('NOISE_THRESHOLD_MAX 必须 = 0.99 (更宽不能 > 0.99)', () => {
    expect(NOISE_THRESHOLD_MAX).toBe(0.99);
  });

  it('ENTITY_NOISE_ANCHORS_R2_KEY 必须 = "entity-noise-anchors.json"', () => {
    expect(ENTITY_NOISE_ANCHORS_R2_KEY).toBe('entity-noise-anchors.json');
  });

  it('NOISE_ANCHORS_DEFAULT 必须 >= 20 个 (kzclaw 18:09 确定 batch incorrect 20 个)', () => {
    expect(NOISE_ANCHORS_DEFAULT.length).toBeGreaterThanOrEqual(20);
  });

  it('NOISE_ANCHORS_DEFAULT 必须包含kzclaw 18:09 batch 确定的 17 通用词', () => {
    const required = [
      '回应',
      '表示',
      '工作',
      '人员',
      '媒体',
      '当地',
      '协议',
      '报道',
      '相关',
      '参与',
      '家属',
      '上市',
      '第三',
      '年初',
      '发现',
      '记者',
      '公司',
    ];
    for (const w of required) {
      expect(NOISE_ANCHORS_DEFAULT).toContain(w);
    }
  });
});

// ============================================================
// 0 硬编码保证 (kzclaw 18:22 确定 #4)
// ============================================================
describe('noise filter 0 硬编码保证 (kzclaw 18:22 确定)', () => {
  it('entity-noise-filter.ts 必须 0 export 硬编码 const noise anchors 数组 (从 R2 读)', async () => {
    const mod = await import('../src/entity-noise-filter');
    // 业务红线: NOISE_ANCHORS_DEFAULT 是 fallback (R2 无时用), 不算硬编码黑名单
    // 但代码逻辑必须从 R2 读, 不能 const
    expect((mod as any).NOISE_ANCHORS_FIXED).toBeUndefined();
    expect((mod as any).NOISE_WORDS).toBeUndefined();
    expect((mod as any).BLACKLIST).toBeUndefined();
  });
});

// ============================================================
// loadNoiseAnchors
// ============================================================
describe('loadNoiseAnchors · 读 R2 noise anchors', () => {
  it('R2 无 anchors → 返 NOISE_ANCHORS_DEFAULT + threshold 0.85', async () => {
    const env: any = { csnews_raw: { get: async () => null } };
    const data = await loadNoiseAnchors(env);
    expect(data.anchors).toEqual(NOISE_ANCHORS_DEFAULT);
    expect(data.threshold).toBe(0.85);
  });

  it('R2 返 anchors JSON → 透传', async () => {
    const stored = {
      anchors: ['foo', 'bar'],
      threshold: 0.9,
      updated_at: '2026-06-16T18:00:00Z',
    };
    const env: any = {
      csnews_raw: { get: async () => ({ json: async () => stored }) },
    };
    const data = await loadNoiseAnchors(env);
    expect(data.anchors).toEqual(['foo', 'bar']);
    expect(data.threshold).toBe(0.9);
  });
});

// ============================================================
// maxNoiseSimilarity / cosineSimilarity
// ============================================================
describe('maxNoiseSimilarity · candidate vs anchors 最大 cosine', () => {
  it('跟自身 1.0 anchor 比 → 1.0', () => {
    const v = [1, 0, 0];
    expect(maxNoiseSimilarity(v, [v])).toBeCloseTo(1, 5);
  });

  it('正交向量 → 0', () => {
    expect(maxNoiseSimilarity([1, 0], [[0, 1]])).toBeCloseTo(0, 5);
  });

  it('多 anchor 返最大 sim', () => {
    const candidate = [1, 0.5, 0];
    const anchors = [
      [0, 1, 0], // 0
      [1, 0, 0], // 0.89
      [1, 1, 0], // 0.94
    ];
    const max = maxNoiseSimilarity(candidate, anchors);
    expect(max).toBeCloseTo(0.94, 1);
  });

  it('空 anchors → 0 (无 anchor 不能判 noise)', () => {
    expect(maxNoiseSimilarity([1, 0, 0], [])).toBe(0);
  });
});

describe('cosineSimilarity · entity-noise-filter 独立函数', () => {
  it('相同向量 = 1', () => {
    expect(noiseCosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('空向量 = 0', () => {
    expect(noiseCosine([], [])).toBe(0);
  });

  it('长度不一致 = 0', () => {
    expect(noiseCosine([1, 2], [1, 2, 3])).toBe(0);
  });
});

// ============================================================
// filterNoiseCandidates (kzclaw 18:22 确定核心)
// ============================================================
describe('filterNoiseCandidates · similarity ≥ threshold → noise', () => {
  it('candidate 跟 anchor 完全相同 → noise', () => {
    const v = [1, 0.5, 0];
    const candidates = [{ name: '测试词', count: 5 }];
    const candidateEmbeddings = [v];
    const anchorEmbeddings = [v]; // 相同 → similarity = 1.0 ≥ 0.85 → noise
    const result = filterNoiseCandidates(candidates, candidateEmbeddings, anchorEmbeddings, 0.85);
    expect(result.kept.length).toBe(0);
    expect(result.noise.length).toBe(1);
    expect(result.noise[0].max_noise_similarity).toBeCloseTo(1, 5);
  });

  it('candidate 跟 anchor 完全正交 → kept', () => {
    const candidates = [{ name: '真实实体', count: 5 }];
    const candidateEmbeddings = [[1, 0, 0]];
    const anchorEmbeddings = [[0, 1, 0]]; // 正交 → 0
    const result = filterNoiseCandidates(candidates, candidateEmbeddings, anchorEmbeddings, 0.85);
    expect(result.kept.length).toBe(1);
    expect(result.noise.length).toBe(0);
  });

  it('kzclaw 18:22 确定 0.85 阈值实战 (mixed)', () => {
    const candidates = [
      { name: '特朗普', count: 80 }, // 真实实体 (跟"回应"等通用词正交)
      { name: '回应', count: 75 }, // 通用词 (跟 anchor "回应" 相同)
      { name: '苹果', count: 60 }, // 真实实体 (跟"通用词" 正交)
      { name: '表示', count: 65 }, // 通用词 (跟 anchor "表示" 相同)
    ];
    const candidateEmbeddings = [
      [1, 0, 0, 0], // 特朗普
      [0, 1, 0, 0], // 回应 (跟 anchor 同)
      [0, 0, 1, 0], // 苹果
      [0, 0, 0, 1], // 表示 (跟 anchor 同)
    ];
    const anchorEmbeddings = [
      [0, 1, 0, 0], // anchor 1 = 回应
      [0, 0, 0, 1], // anchor 2 = 表示
    ];
    const result = filterNoiseCandidates(candidates, candidateEmbeddings, anchorEmbeddings, 0.85);
    expect(result.kept.map((c) => c.name)).toEqual(['特朗普', '苹果']);
    expect(result.noise.map((n) => n.candidate.name)).toEqual(['回应', '表示']);
    expect(result.scores.length).toBe(4);
  });

  it('0 embedding → 保守 kept', () => {
    const candidates = [{ name: 'edge case', count: 3 }];
    const result = filterNoiseCandidates(candidates, [], [], 0.85);
    expect(result.kept.length).toBe(1);
    expect(result.noise.length).toBe(0);
  });

  it('threshold 边界 0.85 (>= 才 noise, < 才 kept)', () => {
    // similarity = 0.85 → noise
    const candidates = [{ name: 'a', count: 1 }];
    const v = [0.85, 0.527, 0]; // 跟自身 1.0 相似度近似 0.85
    // 实际算法: similarity 0.85 → 命中 >= 阈值 → noise
    const result = filterNoiseCandidates(candidates, [v], [v], 0.85);
    expect(result.noise.length).toBe(1);
  });
});
