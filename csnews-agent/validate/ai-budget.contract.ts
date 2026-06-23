/**
 * CSNEWS Agent · AI 预算追踪业务契约 (Phase 1)
 *
 * 蓝图 2.9: if ai_budget < threshold: only_process(L4, L5)
 *
 * 业务红线:
 *   - 4 档阈值: normal < 5K / warning 5K-7K / critical 7K-8K / shutdown >= 8K
 *   - BUDGET_TIERS 常量必须锁定值
 *   - L1/L2 始终允许 (0 Neurons / 免费路由)
 *   - L3 仅 normal/warning 允许
 *   - L4/L5 仅 normal/warning/critical 允许
 *   - L6 仅 normal 允许
 *   - recordAiCall 正确累加
 *   - getDailyUsage 返回正确初始值
 *
 * 详见：tasks/csnews-agent-okr.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BUDGET_TIERS,
  type BudgetTier,
  getDailyUsage,
  recordAiCall,
  getBudgetStatus,
  canUseTier,
} from '../src/ai-budget';

// ============================================================
// 业务常量
// ============================================================
describe('业务常量', () => {
  it('BUDGET_TIERS.NORMAL 必须 = 5000', () => {
    expect(BUDGET_TIERS.NORMAL).toBe(5000);
  });

  it('BUDGET_TIERS.WARNING 必须 = 7000', () => {
    expect(BUDGET_TIERS.WARNING).toBe(7000);
  });

  it('BUDGET_TIERS.CRITICAL 必须 = 8000', () => {
    expect(BUDGET_TIERS.CRITICAL).toBe(8000);
  });
});

// ============================================================
// getBudgetStatus 档位判断 (Phase 1)
// ============================================================
describe('getBudgetStatus · 4 档阈值', () => {
  // 构造符合新格式的 JSON KV value
  const makeMockEnv = (total: number) => ({
    AI_USAGE_KV: {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({ total, calls: [{ model: 'test', neurons: total, ts: Date.now() }] })
      ),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  });

  it('used=0 → tier=normal', async () => {
    const env = makeMockEnv(0);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('normal');
  });

  it('used=4999 → tier=normal', async () => {
    const env = makeMockEnv(4999);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('normal');
  });

  it('used=5000 → tier=warning', async () => {
    const env = makeMockEnv(5000);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('warning');
  });

  it('used=6999 → tier=warning', async () => {
    const env = makeMockEnv(6999);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('warning');
  });

  it('used=7000 → tier=critical', async () => {
    const env = makeMockEnv(7000);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('critical');
  });

  it('used=7999 → tier=critical', async () => {
    const env = makeMockEnv(7999);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('critical');
  });

  it('used=8000 → tier=shutdown', async () => {
    const env = makeMockEnv(8000);
    const result = await getBudgetStatus(env as any);
    expect(result.tier).toBe('shutdown');
  });

  it('tier=normal 时 remaining = daily_limit - used (default 10000)', async () => {
    const env = makeMockEnv(2000);
    const result = await getBudgetStatus(env as any);
    expect(result.remaining).toBe(8000);
    expect(result.quota).toBe(10000);
  });
});

// ============================================================
// canUseTier 路由规则 (蓝图 2.9) — Phase 2 but tested in Phase 1
// ============================================================
describe('canUseTier · 蓝图 2.9 路由规则', () => {
  const makeEnv = (total: number) => ({
    AI_USAGE_KV: {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({ total, calls: [] })
      ),
      put: vi.fn().mockResolvedValue(undefined),
    },
  });

  it('L1 始终允许 (tier=normal)', async () => {
    const env = makeEnv(1000);
    expect(await canUseTier(env as any, 'L1')).toBe(true);
  });

  it('L1 始终允许 (tier=shutdown)', async () => {
    const env = makeEnv(10000);
    expect(await canUseTier(env as any, 'L1')).toBe(true);
  });

  it('L2 始终允许 (tier=shutdown)', async () => {
    const env = makeEnv(10000);
    expect(await canUseTier(env as any, 'L2')).toBe(true);
  });

  it('L3: normal → 允许', async () => {
    const env = makeEnv(1000);
    expect(await canUseTier(env as any, 'L3')).toBe(true);
  });

  it('L3: warning → 允许', async () => {
    const env = makeEnv(6000);
    expect(await canUseTier(env as any, 'L3')).toBe(true);
  });

  it('L3: critical → 跳过', async () => {
    const env = makeEnv(7500);
    expect(await canUseTier(env as any, 'L3')).toBe(false);
  });

  it('L3: shutdown → 跳过', async () => {
    const env = makeEnv(10000);
    expect(await canUseTier(env as any, 'L3')).toBe(false);
  });

  it('L4: normal → 允许', async () => {
    const env = makeEnv(1000);
    expect(await canUseTier(env as any, 'L4')).toBe(true);
  });

  it('L4: critical → 允许', async () => {
    const env = makeEnv(7500);
    expect(await canUseTier(env as any, 'L4')).toBe(true);
  });

  it('L4: shutdown → 跳过', async () => {
    const env = makeEnv(10000);
    expect(await canUseTier(env as any, 'L4')).toBe(false);
  });

  it('L5: shutdown → 跳过', async () => {
    const env = makeEnv(10000);
    expect(await canUseTier(env as any, 'L5')).toBe(false);
  });

  it('L6: normal → 允许', async () => {
    const env = makeEnv(1000);
    expect(await canUseTier(env as any, 'L6')).toBe(true);
  });

  it('L6: warning → 跳过', async () => {
    const env = makeEnv(6000);
    expect(await canUseTier(env as any, 'L6')).toBe(false);
  });
});
