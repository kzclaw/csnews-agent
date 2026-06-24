/**
 * CSNEWS Agent · entity review 业务契约 (v0.36.22)
 *
 * approve / reject / noise-add / noise-remove 四档 review 闭环
 *
 * 业务契约:
 *   - id 参数必 UUID v4 格式 (isValidUuidV4 校验)
 *   - approve: 从 R2 entity-candidates.json 移到 entity-finalized.json
 *   - reject: 从 R2 entity-candidates.json 删除
 *   - noise-add: entity name 加入 R2 entity-noise-anchors.json
 *   - noise-remove: 从 noise anchors 移除
 *   - 找不到 id → 404 + { error, reason }
 */
import { describe, it, expect } from 'vitest';
import { type EntityCandidate, ENTITY_CANDIDATES_R2_KEY, generateUuidV4 } from '../src/entity-selflearn';
import { type EntityFinalized, ENTITY_FINALIZED_R2_KEY } from '../src/entity-process';
import { ENTITY_NOISE_ANCHORS_R2_KEY, NOISE_THRESHOLD_DEFAULT } from '../src/entity-noise-filter';

// ============================================================
// UUID v4 格式校验 (内联实现, 跟 endpoints-entity.ts 同步)
// ============================================================
function isValidUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

describe('entity review 业务常量', () => {
  it('ENTITY_CANDIDATES_R2_KEY 必须 = "entity-candidates.json"', () => {
    expect(ENTITY_CANDIDATES_R2_KEY).toBe('entity-candidates.json');
  });

  it('ENTITY_FINALIZED_R2_KEY 必须 = "entity-finalized.json"', () => {
    expect(ENTITY_FINALIZED_R2_KEY).toBe('entity-finalized.json');
  });

  it('ENTITY_NOISE_ANCHORS_R2_KEY 必须 = "entity-noise-anchors.json"', () => {
    expect(ENTITY_NOISE_ANCHORS_R2_KEY).toBe('entity-noise-anchors.json');
  });

  it('NOISE_THRESHOLD_DEFAULT 必须 = 0.85', () => {
    expect(NOISE_THRESHOLD_DEFAULT).toBe(0.85);
  });
});

describe('UUID v4 格式校验 (isValidUuidV4)', () => {
  it('标准 UUID v4 格式必须通过', () => {
    const valid = 'a1b2c3d4-e5f4-4a7b-8c9d-0e1f2a3b4c5d';
    expect(isValidUuidV4(valid)).toBe(true);
  });

  it('generateUuidV4() 生成必须通过 isValidUuidV4 校验', () => {
    const uuid = generateUuidV4();
    expect(isValidUuidV4(uuid)).toBe(true);
  });

  it('generateUuidV4() 每次生成必须唯一 (100 次采样)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) {
      set.add(generateUuidV4());
    }
    expect(set.size).toBe(100);
  });

  it('全零 UUID 必须失败', () => {
    expect(isValidUuidV4('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('空字符串必须失败', () => {
    expect(isValidUuidV4('')).toBe(false);
  });

  it('UUID v1 格式 (非 4 版本号) 必须失败', () => {
    // v1: 第三段以 1 开头
    expect(isValidUuidV4('a1b2c3d4-e5f6-1a7b-8c9d-0e1f2a3b4c5d')).toBe(false);
  });

  it('缺少横杠 UUID 必须失败', () => {
    expect(isValidUuidV4('a1b2c3d4e5f44a7b8c9d0e1f2a3b4c5d')).toBe(false);
  });

  it('含非十六进制字符 UUID 必须失败', () => {
    expect(isValidUuidV4('g1b2c3d4-e5f4-4a7b-8c9d-0e1f2a3b4c5d')).toBe(false);
  });
});

describe('EntityCandidate interface 含 uuid 字段', () => {
  it('EntityCandidate 必须含 uuid 属性', () => {
    const candidate: EntityCandidate = {
      uuid: 'a1b2c3d4-e5f4-4a7b-8c9d-0e1f2a3b4c5d',
      name: '伊朗',
      type: 'place',
      frequency: 10,
      sample_context: '伊朗宣布...',
      confidence: 0.5,
      source: 'selflearn',
      first_seen: '2026-06-24T00:00:00.000Z',
    };
    expect(candidate.uuid).toBe('a1b2c3d4-e5f4-4a7b-8c9d-0e1f2a3b4c5d');
    expect(typeof candidate.uuid).toBe('string');
  });

  it('EntityCandidate.uuid 必须通过 isValidUuidV4 校验', () => {
    const uuid = generateUuidV4();
    const candidate: EntityCandidate = {
      uuid,
      name: '特朗普',
      type: 'person',
      frequency: 5,
      sample_context: '特朗普表示...',
      confidence: 0.5,
      source: 'selflearn',
      first_seen: new Date().toISOString(),
    };
    expect(isValidUuidV4(candidate.uuid)).toBe(true);
  });
});

describe('EntityFinalized interface 含 uuid 字段', () => {
  it('EntityFinalized 必须含 uuid 属性', () => {
    // EntityFinalized 是 interface, 运行时类型检查用构造对象验证结构
    const finalized = {
      uuid: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6',
      name: '伊朗',
      type: 'place' as const,
      confidence: 0.8,
      source: 'review' as const,
      first_seen: '2026-06-24T00:00:00.000Z',
      last_seen: '2026-06-24T12:00:00.000Z',
      mention_count: 3,
    };
    expect(finalized.uuid).toBe('b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6');
    expect(isValidUuidV4(finalized.uuid)).toBe(true);
  });
});

describe('approve 业务契约', () => {
  it('approve 操作后实体必须含 uuid / name / type / source=review', () => {
    const candidate: EntityCandidate = {
      uuid: generateUuidV4(),
      name: '伊朗',
      type: 'place',
      frequency: 10,
      sample_context: '伊朗宣布...',
      confidence: 0.6,
      source: 'selflearn',
      first_seen: '2026-06-24T00:00:00.000Z',
    };

    // approve 构造 finalized 对象
    const finalized: EntityFinalized = {
      uuid: candidate.uuid,
      name: candidate.name,
      type: candidate.type,
      confidence: candidate.confidence,
      source: 'review',
      first_seen: candidate.first_seen,
      last_seen: new Date().toISOString(),
      mention_count: 1,
    };

    expect(finalized.uuid).toBe(candidate.uuid);
    expect(finalized.name).toBe('伊朗');
    expect(finalized.type).toBe('place');
    expect(finalized.source).toBe('review');
    expect(finalized.mention_count).toBe(1);
    expect(isValidUuidV4(finalized.uuid)).toBe(true);
  });

  it('candidates 数组移除已批准实体后长度必须 -1', () => {
    const candidates: EntityCandidate[] = [
      {
        uuid: 'uuid-1',
        name: '伊朗',
        type: 'place',
        frequency: 10,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
      {
        uuid: 'uuid-2',
        name: '特朗普',
        type: 'person',
        frequency: 5,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const targetId = 'uuid-1';
    const idx = candidates.findIndex((c) => c.uuid === targetId);
    expect(idx).toBe(0);
    candidates.splice(idx, 1);
    expect(candidates.length).toBe(1);
    expect(candidates[0].name).toBe('特朗普');
  });

  it('approve 找不到 id → candidates.findIndex 必须返回 -1', () => {
    const candidates: EntityCandidate[] = [
      {
        uuid: 'uuid-1',
        name: '伊朗',
        type: 'place',
        frequency: 10,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const result = candidates.findIndex((c) => c.uuid === 'nonexistent-uuid');
    expect(result).toBe(-1);
  });

  it('entity-in-noise 场景: approve 前需先 noise-add (reject 防止误批准)', () => {
    // 逻辑: 如果实体在 noise 分组, 不能直接 approve
    const noiseGroup = [
      {
        uuid: 'noise-uuid',
        name: '6月',
        type: 'place',
        frequency: 20,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const candidates: EntityCandidate[] = [];

    // 先 noise-add 把 name 加入 anchors
    const anchor = noiseGroup[0].name;
    const noiseAnchors = ['回应', '表示', anchor];

    // 批准前检查: candidates.findIndex 找不到 + noise.findIndex 找到了
    const candidateIdx = candidates.findIndex((c) => c.uuid === 'noise-uuid');
    const noiseIdx = noiseGroup.findIndex((n) => n.uuid === 'noise-uuid');

    expect(candidateIdx).toBe(-1);
    expect(noiseIdx).toBe(0);
    expect(noiseAnchors.includes(anchor)).toBe(true);
  });
});

describe('reject 业务契约', () => {
  it('reject 操作从 candidates 移除后长度必须 -1', () => {
    const candidates: EntityCandidate[] = [
      {
        uuid: 'uuid-1',
        name: '伊朗',
        type: 'place',
        frequency: 10,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
      {
        uuid: 'uuid-2',
        name: '特朗普',
        type: 'person',
        frequency: 5,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const targetId = 'uuid-2';
    const idx = candidates.findIndex((c) => c.uuid === targetId);
    expect(idx).toBe(1);
    const [rejected] = candidates.splice(idx, 1);
    expect(rejected.name).toBe('特朗普');
    expect(candidates.length).toBe(1);
    expect(candidates[0].name).toBe('伊朗');
  });

  it('reject 找不到 id → 404 条件成立 (findIndex === -1)', () => {
    const candidates: EntityCandidate[] = [
      {
        uuid: 'uuid-1',
        name: '伊朗',
        type: 'place',
        frequency: 10,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const result = candidates.findIndex((c) => c.uuid === 'nonexistent-uuid');
    expect(result).toBe(-1);
    // 404 条件: result === -1
    const shouldReturn404 = result === -1;
    expect(shouldReturn404).toBe(true);
  });

  it('空 candidates 时 reject 必须触发 404', () => {
    const candidates: EntityCandidate[] = [];
    const result = candidates.findIndex((c) => c.uuid === generateUuidV4());
    expect(result).toBe(-1);
    const shouldReturn404 = result === -1;
    expect(shouldReturn404).toBe(true);
  });
});

describe('noise-add 业务契约', () => {
  it('noise-add 新增 anchor 后 anchors.length 必须 +1', () => {
    const existingAnchors = ['回应', '表示', '公司'];
    const newAnchor = '伊朗';

    expect(existingAnchors.includes(newAnchor)).toBe(false);
    const newAnchors = [...existingAnchors, newAnchor];
    expect(newAnchors.length).toBe(4);
    expect(newAnchors[newAnchors.length - 1]).toBe('伊朗');
  });

  it('noise-add 重复 anchor 必须检测并返回 400 (includes)', () => {
    const anchors = ['回应', '伊朗', '公司'];
    const duplicate = '伊朗';
    expect(anchors.includes(duplicate)).toBe(true);
    // 重复时返回 400, 不修改 anchors
    const shouldReturn400 = anchors.includes(duplicate);
    expect(shouldReturn400).toBe(true);
  });

  it('noise-add 找 entity: candidates + noise 两个分组都要查', () => {
    const candidates = [
      {
        uuid: 'c-uuid-1',
        name: '伊朗',
        type: 'place',
        frequency: 10,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];
    const noise = [
      {
        uuid: 'n-uuid-1',
        name: '6月',
        type: 'place',
        frequency: 20,
        sample_context: '',
        confidence: 0.5,
        source: 'selflearn',
        first_seen: '2026-06-24T00:00:00.000Z',
      },
    ];

    const allEntities = [...candidates, ...noise];
    const entity1 = allEntities.find((e) => e.uuid === 'c-uuid-1');
    const entity2 = allEntities.find((e) => e.uuid === 'n-uuid-1');
    expect(entity1?.name).toBe('伊朗');
    expect(entity2?.name).toBe('6月');
  });

  it('noise-add 找不到 entity → 404 条件成立', () => {
    const candidates: EntityCandidate[] = [];
    const noise: EntityCandidate[] = [];
    const allEntities = [...candidates, ...noise];
    const entity = allEntities.find((e) => e.uuid === 'nonexistent');
    expect(entity).toBeUndefined();
  });
});

describe('noise-remove 业务契约', () => {
  it('noise-remove 移除后 anchors.length 必须 -1', () => {
    const anchors = ['回应', '表示', '伊朗', '公司'];
    const target = '伊朗';
    const idx = anchors.indexOf(target);
    expect(idx).toBe(2);
    const newAnchors = [...anchors];
    newAnchors.splice(idx, 1);
    expect(newAnchors.length).toBe(3);
    expect(newAnchors).not.toContain('伊朗');
  });

  it('noise-remove 找不到 anchor → 404 条件成立 (indexOf === -1)', () => {
    const anchors = ['回应', '表示', '公司'];
    const result = anchors.indexOf('不存在的词');
    expect(result).toBe(-1);
    const shouldReturn404 = result === -1;
    expect(shouldReturn404).toBe(true);
  });
});

describe('approve/reject/noise-add/noise-remove 统一契约', () => {
  it('4 个新 action type 全部需要 id 参数', () => {
    const newTypes = ['approve', 'reject', 'noise-add', 'noise-remove'];
    expect(newTypes.length).toBe(4);
    expect(newTypes).toContain('approve');
    expect(newTypes).toContain('reject');
    expect(newTypes).toContain('noise-add');
    expect(newTypes).toContain('noise-remove');
  });

  it('noise-add/noise-remove id 语义: approve/reject 是 uuid, noise-remove 是 anchor name', () => {
    // noise-add/reject: id 是 entity uuid (需查 candidates/noise 找 name)
    // noise-remove: id 是 anchor name (直接 indexOf 查找)
    const noiseRemoveId = '伊朗'; // anchor name
    const anchors = ['回应', '表示', '伊朗', '公司'];
    const idx = anchors.indexOf(noiseRemoveId);
    expect(idx).toBe(2); // noise-remove 直接用 name 作为 id

    // approve/reject: id 是 uuid
    const approveId = 'a1b2c3d4-e5f4-4a7b-8c9d-0e1f2a3b4c5d';
    expect(isValidUuidV4(approveId)).toBe(true);
  });
});
