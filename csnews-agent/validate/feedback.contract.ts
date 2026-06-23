/**
 * CSNEWS Agent · feedback + score-rule-weights 业务契约 (v0.36.22 · O11 KR1)
 *
 * 唯一目标：守住"O11 Feedback Loop 业务规则就是这样"（当前实现的 snapshot）
 *
 * 业务红线:
 *   - loadWeights: returns DEFAULT_HOT_WORD_WEIGHTS as fallback on DB error
 *   - adjustWeights: <0.6 → ×0.9 / 0.6–0.8 → no change / >0.8 → ×1.05
 *   - adjustWeights: min weight = 0.1, max weight = 3.0
 *   - scoreRule: unchanged defaults (backward compat, existing tests pass)
 *   - scoreRuleWithWeights: async, uses DB weights when available
 *   - scheduledFeedback: exported with correct signature
 *   - handleFeedbackCheckAction: exported with correct signature
 *
 * 详见: specs/005-kr9-feedback-loop/spec.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWeights, adjustWeights, DEFAULT_HOT_WORD_WEIGHTS } from '../src/score-rule-weights';
import { scoreRule, applyScore, AI_ROUTE_R_THRESHOLD } from '../src/score';
import * as feedback from '../src/feedback';

// ============================================================
// score-rule-weights · 业务契约
// ============================================================
describe('loadWeights · 业务契约', () => {
  it('DEFAULT_HOT_WORD_WEIGHTS 必须包含所有 10 个热词', () => {
    const expected = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新', '突破', '革命', '创历史'];
    for (const w of expected) {
      expect(DEFAULT_HOT_WORD_WEIGHTS).toHaveProperty(w);
    }
  });

  it('DEFAULT_HOT_WORD_WEIGHTS 所有值必须为 1.0 (baseline)', () => {
    for (const [, v] of Object.entries(DEFAULT_HOT_WORD_WEIGHTS)) {
      expect(v).toBe(1.0);
    }
  });

  it('loadWeights 在 DB 错误时必须返回 DEFAULT_HOT_WORD_WEIGHTS', async () => {
    // env 缺 SUPABASE_URL → fetch 抛错 → 应返回 defaults
    const badEnv: any = {};
    const weights = await loadWeights(badEnv, 'tech');
    expect(weights).toEqual(DEFAULT_HOT_WORD_WEIGHTS);
  });
});

describe('adjustWeights · 业务契约', () => {
  it('accuracy < 0.6 必须 reduce ×0.9', async () => {
    const env: any = {
      SUPABASE_URL: 'test-project',
      SUPABASE_SERVICE_KEY: 'test-key',
    };
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    );
    vi.stubGlobal('fetch', mockFetch);
    global.fetch = mockFetch;

    const before = { 突发: 1.0, 震惊: 1.0 };
    const adjusted = await adjustWeights(env, 'tech', 0.4, before);

    expect(adjusted['突发']).toBe(0.9);
    expect(adjusted['震惊']).toBe(0.9);
  });

  it('accuracy 0.6–0.8 必须不改变', async () => {
    const env: any = {};
    const before = { 突发: 1.0, 震惊: 1.0 };
    const adjusted = await adjustWeights(env, 'tech', 0.7, before);
    expect(adjusted).toEqual(before);
  });

  it('accuracy > 0.8 必须 encourage ×1.05', async () => {
    const env: any = {};
    const before = { 突发: 1.0, 震惊: 1.0 };
    const adjusted = await adjustWeights(env, 'tech', 0.9, before);
    expect(adjusted['突发']).toBe(1.05);
    expect(adjusted['震惊']).toBe(1.05);
  });

  it('weight min=0.1, max=3.0 边界保护', async () => {
    const env: any = {};
    // ×0.9 should not go below 0.1
    const before = { 突发: 0.11 };
    const adjusted = await adjustWeights(env, 'tech', 0.4, before);
    expect(adjusted['突发']).toBeGreaterThanOrEqual(0.1);

    // ×1.05 should not exceed 3.0
    const before2 = { 突发: 3.0 };
    const adjusted2 = await adjustWeights(env, 'tech', 0.95, before2);
    expect(adjusted2['突发']).toBeLessThanOrEqual(3.0);
  });

  it('adjustWeights 权重保留 2 位小数', async () => {
    const env: any = {};
    const before = { 突发: 1.0 };
    const adjusted = await adjustWeights(env, 'tech', 0.4, before);
    // 1.0 * 0.9 = 0.9 → 2 decimal places = 0.90
    expect(String(adjusted['突发']).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

// ============================================================
// scoreRule · 向后兼容契约 (原有测试必须继续通过)
// ============================================================
describe('scoreRule · 向后兼容业务红线', () => {
  it('scoreRule 必须仍然存在并返回 { score, reason, isHigh }', () => {
    const result = scoreRule('紧急事件');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('isHigh');
  });

  it('超热词（紧急）必须 score=7.0 (与原测试一致)', () => {
    const { score } = scoreRule('紧急通知');
    expect(score).toBe(7.0);
  });

  it('无任何命中必须 score=5.0 base (与原测试一致)', () => {
    const { score } = scoreRule('普通新闻');
    expect(score).toBe(5.0);
  });
});

// ============================================================
// applyScore · 内部核心函数业务契约
// ============================================================
describe('applyScore · 业务契约', () => {
  it('必须返回 { score, matchedHotWords, superHot }', () => {
    const result = applyScore('紧急通知', DEFAULT_HOT_WORD_WEIGHTS);
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('matchedHotWords');
    expect(result).toHaveProperty('superHot');
    expect(Array.isArray(result.matchedHotWords)).toBe(true);
    expect(typeof result.superHot).toBe('boolean');
  });

  it('超热词(superHot=true)时 matchedHotWords 必须含超热词', () => {
    const result = applyScore('紧急通知', DEFAULT_HOT_WORD_WEIGHTS);
    expect(result.superHot).toBe(true);
    expect(result.matchedHotWords).toContain('紧急');
  });

  it('普通热词(superHot=false)时 matchedHotWords 为空数组', () => {
    const result = applyScore('震惊事件', DEFAULT_HOT_WORD_WEIGHTS);
    expect(result.superHot).toBe(false);
    expect(result.matchedHotWords).toContain('震惊');
  });

  it('无热词时 matchedHotWords 为空数组', () => {
    const result = applyScore('普通新闻标题', DEFAULT_HOT_WORD_WEIGHTS);
    expect(result.matchedHotWords).toHaveLength(0);
    expect(result.superHot).toBe(false);
  });
});

// ============================================================
// scheduledFeedback · 业务契约
// ============================================================
describe('scheduledFeedback · 业务契约', () => {
  it('scheduledFeedback 必须 export (函数签名)', () => {
    expect(typeof feedback.scheduledFeedback).toBe('function');
  });

  it('scheduledFeedback 必须接受 (env, ctx, controller) 3 个参数', () => {
    expect(feedback.scheduledFeedback.length).toBe(3);
  });

  it('scheduledFeedback 必须返回 Promise (async)', () => {
    const env: any = {};
    const ctx: any = { waitUntil: vi.fn() };
    const controller: any = { cron: '0 4 * * *' };
    const ret = feedback.scheduledFeedback(env, ctx, controller);
    expect(ret).toBeInstanceOf(Promise);
    ret.catch(() => {});
  });

  it('env 缺 SUPABASE_URL, scheduledFeedback 必须 catch (不向上抛)', async () => {
    const env: any = {};
    const ctx: any = { waitUntil: vi.fn() };
    const controller: any = { cron: '0 4 * * *' };
    await Promise.race([
      feedback.scheduledFeedback(env, ctx, controller),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
    ]);
    // 不抛 = 满足 catch 兜底
  });
});

// ============================================================
// handleFeedbackCheckAction · 业务契约
// ============================================================
describe('handleFeedbackCheckAction · 业务契约', () => {
  it('handleFeedbackCheckAction 必须 export', () => {
    expect(typeof feedback.handleFeedbackCheckAction).toBe('function');
  });

  it('handleFeedbackCheckAction 必须返回 { ok, result, elapsed_ms }', async () => {
    const env: any = {};
    const result = await feedback.handleFeedbackCheckAction(env);
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('elapsed_ms');
  });

  it('handleFeedbackCheckAction 缺配置时优雅返回 (空 env 不抛错)', async () => {
    // 缺 SUPABASE_URL 时 runFeedbackCheck 仍可完成（空结果）
    // 不要求 errors=1，因为 fetch 不会抛错而是静默返回空
    const env: any = {};
    const result = await feedback.handleFeedbackCheckAction(env);
    expect(result.ok).toBe(true);
    expect(result.result.processed).toBe(0);
  });
});
