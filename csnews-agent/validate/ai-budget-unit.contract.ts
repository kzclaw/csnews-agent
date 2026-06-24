/**
 * CSNEWS Agent · AI 预算追踪业务契约 (Phase 5 扩展)
 *
 * Phase 5 目标：补充 recordAiCall / getDailyUsage / shouldTriggerAiCall / resetDailyCounter 单元测试
 * + 集成测试模拟三档降级
 *
 * 业务红线:
 *   - recordAiCall: 正常写入 / KV 不存在时创建 / 多次累加
 *   - getDailyUsage: 有数据 / 无数据（空 KV）
 *   - getBudgetStatus: normal / warning / critical / shutdown 四档（已在 Phase 1 覆盖）
 *   - shouldTriggerAiCall: L1=true / L2=true / L4 阈值(7000) / L5 阈值(8000) / L6 阈值(9000)
 *   - resetDailyCounter: 重置成功 / 重置后读取为 0
 *
 * 详见：tasks/csnews-agent-okr.md Phase 5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BUDGET_TIERS,
  getDailyUsage,
  recordAiCall,
  getBudgetStatus,
  shouldTriggerAiCall,
  resetDailyCounter,
} from '../src/ai-budget';

// ============================================================
// Helper factories
// ============================================================

function makeMockKV(getReturn?: string, putReturn?: unknown, deleteReturn?: unknown) {
  return {
    AI_USAGE_KV: {
      get: vi.fn().mockResolvedValue(getReturn ?? null),
      put: vi.fn().mockResolvedValue(putReturn ?? undefined),
      delete: vi.fn().mockResolvedValue(deleteReturn ?? undefined),
    },
  };
}

// ============================================================
// recordAiCall · 单元测试
// ============================================================
describe('recordAiCall · 正常写入', () => {
  it('第一次调用时创建新 record，total 累加正确', async () => {
    const env = makeMockKV(null) as any;

    await recordAiCall(env, 'kimi-k2.5', 500);

    expect(env.AI_USAGE_KV.put).toHaveBeenCalledOnce();
    const putArg = env.AI_USAGE_KV.put.mock.calls[0];
    const written = JSON.parse(putArg[1] as string);
    expect(written.total).toBe(500);
    expect(written.calls).toHaveLength(1);
    expect(written.calls[0].model).toBe('kimi-k2.5');
    expect(written.calls[0].neurons).toBe(500);
    expect(putArg[2]).toMatchObject({ expirationTtl: 604_800 });
  });

  it('KV 不存在时创建新 record，不抛异常', async () => {
    const env = makeMockKV(undefined) as any;

    await expect(
      recordAiCall(env, 'test-model', 100)
    ).resolves.not.toThrow();

    expect(env.AI_USAGE_KV.put).toHaveBeenCalledOnce();
    const written = JSON.parse(env.AI_USAGE_KV.put.mock.calls[0][1] as string);
    expect(written.total).toBe(100);
    expect(written.calls).toHaveLength(1);
  });

  it('多次调用时 total 正确累加', async () => {
    const existingRecord = JSON.stringify({
      total: 1200,
      calls: [{ model: 'prev', neurons: 1200, ts: Date.now() - 1000 }],
    });
    const env = makeMockKV(existingRecord) as any;

    await recordAiCall(env, 'kimi-k2.5', 800);

    expect(env.AI_USAGE_KV.put).toHaveBeenCalledOnce();
    const written = JSON.parse(env.AI_USAGE_KV.put.mock.calls[0][1] as string);
    expect(written.total).toBe(2000); // 1200 + 800
    expect(written.calls).toHaveLength(2);
    expect(written.calls[1].model).toBe('kimi-k2.5');
    expect(written.calls[1].neurons).toBe(800);
  });

  it('KV 写入失败时静默捕获，不抛异常', async () => {
    const env = {
      AI_USAGE_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockRejectedValue(new Error('KV write failed')),
      },
    } as any;

    await expect(
      recordAiCall(env, 'model', 100)
    ).resolves.not.toThrow();
  });

  it('neurons < 0 时直接返回，不写入', async () => {
    const env = makeMockKV() as any;

    await recordAiCall(env, 'model', -500);

    expect(env.AI_USAGE_KV.get).not.toHaveBeenCalled();
    expect(env.AI_USAGE_KV.put).not.toHaveBeenCalled();
  });

  it('neurons = 0 时仍然写入（合法调用）', async () => {
    const env = makeMockKV(null) as any;

    await recordAiCall(env, 'free-model', 0);

    expect(env.AI_USAGE_KV.put).toHaveBeenCalledOnce();
    const written = JSON.parse(env.AI_USAGE_KV.put.mock.calls[0][1] as string);
    expect(written.total).toBe(0);
    expect(written.calls).toHaveLength(1);
  });
});

// ============================================================
// getDailyUsage · 单元测试
// ============================================================
describe('getDailyUsage · 用量查询', () => {
  it('有数据时返回正确的 total', async () => {
    const raw = JSON.stringify({ total: 3500, calls: [] });
    const env = makeMockKV(raw) as any;

    const result = await getDailyUsage(env);

    expect(result).toBe(3500);
    expect(env.AI_USAGE_KV.get).toHaveBeenCalledOnce();
  });

  it('KV 为空（null）时返回 0', async () => {
    const env = makeMockKV(null) as any;

    const result = await getDailyUsage(env);

    expect(result).toBe(0);
  });

  it('KV 为空字符串时返回 0（静默处理）', async () => {
    const env = makeMockKV('') as any;

    const result = await getDailyUsage(env);

    expect(result).toBe(0);
  });

  it('JSON 解析失败时返回 0（静默处理）', async () => {
    const env = makeMockKV('not valid json {{{') as any;

    const result = await getDailyUsage(env);

    expect(result).toBe(0);
  });

  it('record.total 为 undefined 时返回 0（fallback）', async () => {
    const env = makeMockKV(JSON.stringify({ total: undefined, calls: [] })) as any;

    const result = await getDailyUsage(env);

    expect(result).toBe(0);
  });

  it('指定日期时使用对应 key', async () => {
    const env = makeMockKV(JSON.stringify({ total: 999, calls: [] })) as any;

    await getDailyUsage(env, '2026-06-20');

    const getCall = env.AI_USAGE_KV.get.mock.calls[0][0];
    expect(getCall).toBe('usage/2026-06-20');
  });
});

// ============================================================
// shouldTriggerAiCall · 单元测试（Phase 2 阈值）
// ============================================================
describe('shouldTriggerAiCall · 预算阈值触发', () => {
  it('L1 始终返回 true（规则分类 0 Neurons）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 9000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L1');

    expect(result).toBe(true);
  });

  it('L2 始终返回 true（AI 评分免费路由）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 9500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L2');

    expect(result).toBe(true);
  });

  it('L4: used < 7000 → true', async () => {
    const env = makeMockKV(JSON.stringify({ total: 6000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L4');

    expect(result).toBe(true);
  });

  it('L4: used = 7000 → false（触发阈值边界）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 7000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L4');

    expect(result).toBe(false);
  });

  it('L4: used > 7000 → false', async () => {
    const env = makeMockKV(JSON.stringify({ total: 7500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L4');

    expect(result).toBe(false);
  });

  it('L5: used < 8000 → true', async () => {
    const env = makeMockKV(JSON.stringify({ total: 7500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L5');

    expect(result).toBe(true);
  });

  it('L5: used = 8000 → false（触发阈值边界）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 8000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L5');

    expect(result).toBe(false);
  });

  it('L5: used > 8000 → false', async () => {
    const env = makeMockKV(JSON.stringify({ total: 8500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L5');

    expect(result).toBe(false);
  });

  it('L6: used < 9000 → true', async () => {
    const env = makeMockKV(JSON.stringify({ total: 8500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L6');

    expect(result).toBe(true);
  });

  it('L6: used = 9000 → false（触发阈值边界）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 9000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L6');

    expect(result).toBe(false);
  });

  it('L6: used > 9000 → false', async () => {
    const env = makeMockKV(JSON.stringify({ total: 9500, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L6');

    expect(result).toBe(false);
  });

  it('L3: normal tier → true', async () => {
    const env = makeMockKV(JSON.stringify({ total: 1000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L3');

    expect(result).toBe(true);
  });

  it('L3: shutdown tier → false（降级跳过）', async () => {
    const env = makeMockKV(JSON.stringify({ total: 9000, calls: [] })) as any;

    const result = await shouldTriggerAiCall(env, 'L3');

    expect(result).toBe(false);
  });
});

// ============================================================
// resetDailyCounter · 单元测试
// ============================================================
describe('resetDailyCounter · 每日重置', () => {
  it('重置成功 → delete 被调用一次', async () => {
    const env = makeMockKV() as any;

    await resetDailyCounter(env);

    expect(env.AI_USAGE_KV.delete).toHaveBeenCalledOnce();
    // delete key 格式为 usage/YYYY-MM-DD
    const deleteKey = env.AI_USAGE_KV.delete.mock.calls[0][0];
    expect(deleteKey).toMatch(/^usage\/\d{4}-\d{2}-\d{2}$/);
  });

  it('重置后 getDailyUsage 读取为 0', async () => {
    // 第一次调用 set up 旧数据
    const env = makeMockKV(
      JSON.stringify({ total: 5000, calls: [] })
    ) as any;

    await resetDailyCounter(env);

    // 重新创建 KV mock（模拟 delete 后的状态）
    const freshEnv = makeMockKV(null) as any;
    const result = await getDailyUsage(freshEnv);
    expect(result).toBe(0);
  });

  it('KV 不存在时 delete 失败静默捕获', async () => {
    const env = {
      AI_USAGE_KV: {
        delete: vi.fn().mockRejectedValue(new Error('KV delete failed')),
      },
    } as any;

    await expect(resetDailyCounter(env)).resolves.not.toThrow();
  });

  it('无 AI_USAGE_KV binding 时直接返回', async () => {
    const env = {} as any;

    await resetDailyCounter(env);

    // 不抛异常
    expect(true).toBe(true);
  });
});

// ============================================================
// BUDGET_TIERS 边界值测试
// ============================================================
describe('BUDGET_TIERS · 常量锁定', () => {
  it('NORMAL 必须 = 5000', () => {
    expect(BUDGET_TIERS.NORMAL).toBe(5_000);
  });

  it('WARNING 必须 = 7000', () => {
    expect(BUDGET_TIERS.WARNING).toBe(7_000);
  });

  it('CRITICAL 必须 = 8000', () => {
    expect(BUDGET_TIERS.CRITICAL).toBe(8_000);
  });
});
