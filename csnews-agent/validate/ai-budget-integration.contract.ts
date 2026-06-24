/**
 * CSNEWS Agent · AI 预算降级集成测试 (Phase 5)
 *
 * 模拟三档降级场景，验证 shouldTriggerAiCall + canUseTier 联动行为：
 *
 * 场景 A (warning 5K-7K):  Neurons = 5K
 *   → L6 跳过，但 L5/L4/L3 正常
 *
 * 场景 B (critical 7K-8K): Neurons = 7K
 *   → L5/L6 跳过，但 L4/L3 正常
 *
 * 场景 C (shutdown >=8K):   Neurons = 8K
 *   → L4/L5/L6 全跳过
 *
 * 业务规则（蓝图 2.9）:
 *   L1: 始终允许（0 Neurons / 免费路由）
 *   L2: 始终允许（AI 评分 / 免费路由）
 *   L3: normal/warning 允许；critical/shutdown 跳过
 *   L4: normal/warning/critical 允许；shutdown 跳过
 *   L5: normal/warning/critical 允许；shutdown 跳过
 *   L6: normal 允许；warning/critical/shutdown 跳过
 *
 * shouldTriggerAiCall 阈值（Phase 2）:
 *   L4: used < 7,000
 *   L5: used < 8,000
 *   L6: used < 9,000
 *
 * 详见：tasks/csnews-agent-okr.md Phase 5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldTriggerAiCall, canUseTier, getBudgetStatus } from '../src/ai-budget';

function makeMockKV(total: number) {
  return {
    AI_USAGE_KV: {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({ total, calls: [{ model: 'test', neurons: total, ts: Date.now() }] })
      ),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// ============================================================
// 场景 A: warning (5K-7K) — Neurons = 5K
// ============================================================
describe('场景 A · warning (5K-7K): used = 5,000', () => {
  const env = makeMockKV(5_000) as any;

  it('getBudgetStatus tier = warning', async () => {
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('warning');
  });

  it('L1 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L1')).toBe(true);
  });

  it('L2 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L2')).toBe(true);
  });

  it('L3 → 允许（canUseTier · warning 档）', async () => {
    expect(await canUseTier(env, 'L3')).toBe(true);
  });

  it('L4 → 允许（canUseTier · warning 档）', async () => {
    expect(await canUseTier(env, 'L4')).toBe(true);
  });

  it('L5 → 允许（canUseTier · warning 档）', async () => {
    expect(await canUseTier(env, 'L5')).toBe(true);
  });

  it('L6 → 跳过（canUseTier · warning 档）', async () => {
    expect(await canUseTier(env, 'L6')).toBe(false);
  });

  it('shouldTriggerAiCall L4 → true（5K < 7K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(true);
  });

  it('shouldTriggerAiCall L5 → true（5K < 8K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
  });

  it('shouldTriggerAiCall L6 → true（5K < 9K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
  });

  it('综合结论：L6 跳过，L5/L4/L3/L2/L1 正常', async () => {
    expect(await shouldTriggerAiCall(env, 'L1')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L2')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L3')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
    // canUseTier L6 才是降级判断
    expect(await canUseTier(env, 'L6')).toBe(false); // 降级核心验证
  });
});

// ============================================================
// 场景 B: critical (7K-8K) — Neurons = 7,000
// ============================================================
describe('场景 B · critical (7K-8K): used = 7,000', () => {
  const env = makeMockKV(7_000) as any;

  it('getBudgetStatus tier = critical', async () => {
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('critical');
  });

  it('L1 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L1')).toBe(true);
  });

  it('L2 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L2')).toBe(true);
  });

  it('L3 → 跳过（canUseTier · critical 档）', async () => {
    expect(await canUseTier(env, 'L3')).toBe(false);
  });

  it('L4 → 允许（canUseTier · critical 档）', async () => {
    expect(await canUseTier(env, 'L4')).toBe(true);
  });

  it('L5 → 允许（canUseTier · critical 档）', async () => {
    expect(await canUseTier(env, 'L5')).toBe(true);
  });

  it('L6 → 跳过（canUseTier · critical 档）', async () => {
    expect(await canUseTier(env, 'L6')).toBe(false);
  });

  it('shouldTriggerAiCall L4 → false（7K >= 7K 阈值边界）', async () => {
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(false);
  });

  it('shouldTriggerAiCall L5 → true（7K < 8K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
  });

  it('shouldTriggerAiCall L6 → true（7K < 9K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
  });

  it('综合结论：L5/L6 跳过，L4/L3/L2/L1 正常', async () => {
    // L3 canUseTier 跳过（critical 档不允许）
    expect(await canUseTier(env, 'L3')).toBe(false);
    // L4/L5 canUseTier 允许，但 shouldTriggerAiCall L4 因阈值跳过
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(false); // 降级核心验证
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
    expect(await canUseTier(env, 'L6')).toBe(false); // 降级核心验证
  });
});

// ============================================================
// 场景 C: shutdown (>=8K) — Neurons = 8,000
// ============================================================
describe('场景 C · shutdown (>=8K): used = 8,000', () => {
  const env = makeMockKV(8_000) as any;

  it('getBudgetStatus tier = shutdown', async () => {
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('shutdown');
  });

  it('L1 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L1')).toBe(true);
  });

  it('L2 → 允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L2')).toBe(true);
  });

  it('L3 → 跳过（canUseTier · shutdown 档）', async () => {
    expect(await canUseTier(env, 'L3')).toBe(false);
  });

  it('L4 → 跳过（canUseTier · shutdown 档）', async () => {
    expect(await canUseTier(env, 'L4')).toBe(false);
  });

  it('L5 → 跳过（canUseTier · shutdown 档）', async () => {
    expect(await canUseTier(env, 'L5')).toBe(false);
  });

  it('L6 → 跳过（canUseTier · shutdown 档）', async () => {
    expect(await canUseTier(env, 'L6')).toBe(false);
  });

  it('shouldTriggerAiCall L4 → false（8K >= 7K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(false);
  });

  it('shouldTriggerAiCall L5 → false（8K >= 8K 阈值边界）', async () => {
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(false);
  });

  it('shouldTriggerAiCall L6 → true（8K < 9K）', async () => {
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
  });

  it('综合结论：L4/L5/L6 全跳过，L3/L2/L1 正常（仅 canUseTier）', async () => {
    expect(await canUseTier(env, 'L4')).toBe(false); // 降级核心验证
    expect(await canUseTier(env, 'L5')).toBe(false); // 降级核心验证
    expect(await canUseTier(env, 'L6')).toBe(false); // 降级核心验证
    // L1/L2 仍允许（免费路由）
    expect(await canUseTier(env, 'L1')).toBe(true);
    expect(await canUseTier(env, 'L2')).toBe(true);
  });
});

// ============================================================
// 场景 D: normal (< 5K) — Neurons = 1,000（基线验证）
// ============================================================
describe('场景 D · normal (<5K): used = 1,000（基线验证）', () => {
  const env = makeMockKV(1_000) as any;

  it('getBudgetStatus tier = normal', async () => {
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('normal');
  });

  it('L1-L6 全部允许（canUseTier）', async () => {
    expect(await canUseTier(env, 'L1')).toBe(true);
    expect(await canUseTier(env, 'L2')).toBe(true);
    expect(await canUseTier(env, 'L3')).toBe(true);
    expect(await canUseTier(env, 'L4')).toBe(true);
    expect(await canUseTier(env, 'L5')).toBe(true);
    expect(await canUseTier(env, 'L6')).toBe(true);
  });

  it('shouldTriggerAiCall: L4/L5/L6 全部 true（1K < 各自阈值）', async () => {
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
  });
});

// ============================================================
// 边界值精确测试
// ============================================================
describe('边界值 · 各阈值临界点', () => {
  it('used = 4999 → tier = normal（L4/L5/L6 全部触发）', async () => {
    const env = makeMockKV(4_999) as any;
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('normal');
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);
  });

  it('used = 5000 → tier = warning（L6 canUseTier 跳过）', async () => {
    const env = makeMockKV(5_000) as any;
    const status = await getBudgetStatus(env);
    expect(status.tier).toBe('warning');
    expect(await canUseTier(env, 'L6')).toBe(false);
  });

  it('used = 6999 → tier = warning（L4/L5 阈值内）', async () => {
    const env = makeMockKV(6_999) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('warning');
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(true);  // 6999 < 7000
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);  // 6999 < 8000
  });

  it('used = 7000 → tier = critical（L4 阈值触发）', async () => {
    const env = makeMockKV(7_000) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('critical');
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(false); // 7000 >= 7000
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);  // 7000 < 8000
  });

  it('used = 7999 → tier = critical（L5 阈值内）', async () => {
    const env = makeMockKV(7_999) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('critical');
    expect(await shouldTriggerAiCall(env, 'L4')).toBe(false); // 7999 >= 7000
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(true);   // 7999 < 8000
  });

  it('used = 8000 → tier = shutdown（L5 阈值触发）', async () => {
    const env = makeMockKV(8_000) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('shutdown');
    expect(await shouldTriggerAiCall(env, 'L5')).toBe(false); // 8000 >= 8000
  });

  it('used = 8999 → tier = shutdown（L6 阈值内）', async () => {
    const env = makeMockKV(8_999) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('shutdown');
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(true);  // 8999 < 9000
  });

  it('used = 9000 → L6 阈值触发（tier = shutdown）', async () => {
    const env = makeMockKV(9_000) as any;
    expect(await getBudgetStatus(env).then(s => s.tier)).toBe('shutdown');
    expect(await shouldTriggerAiCall(env, 'L6')).toBe(false); // 9000 >= 9000
  });
});
