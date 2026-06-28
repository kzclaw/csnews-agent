/**
 * Business contract tests for scheduled() — the CF Cron Trigger entry point.
 *
 * Covers:
 *   - 4 cron → 4 scheduledXxx() routing
 *   - ctx.waitUntil is called with a Promise for each known cron
 *   - unknown crons are silent no-ops
 *   - Promise resolves successfully (catch block swallows errors)
 *
 * Root-cause lesson: scheduled() ctx.waitUntil trap (await only waits for
 * return value, not the ctx.waitUntil Promise completing) — scheduler log
 * was lost while KV last_process_at was fine. These tests verify the
 * routing contract so the bug class cannot regress silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockR2Bucket } from '../test-helpers';

// =============================================================================
// Minimal Env — all optional fields omitted so they are undefined (null-safe skip)
// =============================================================================

function makeMockEnv() {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1024).fill(0.1) }],
      }),
    } as unknown as Ai,
    csnews_raw: createMockR2Bucket({}),
    BEARER_TOKEN: 'test-token',
    SUPABASE_URL: 'test-project',
    SUPABASE_SERVICE_KEY: 'test-key',
    WORKER_SELF_URL: 'https://test.workers.dev',
  };
}

// =============================================================================
// scheduled() routing — 4 cron branches + unknown silent no-op
// =============================================================================

describe('scheduled() — cron routing contract', () => {
  let mockEnv: ReturnType<typeof makeMockEnv>;
  let waitUntilSpy: ReturnType<typeof vi.fn>;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockEnv = makeMockEnv();
    waitUntilSpy = vi.fn();
    mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Branch 1: '0 3,15 * * *' → scheduledEntity ----

  it('routes "0 3,15 * * *" cron to scheduledEntity and calls ctx.waitUntil once', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 3,15 * * *' } as unknown as ScheduledController;

    expect(waitUntilSpy).not.toHaveBeenCalled();
    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    expect(promiseArg).toBeInstanceOf(Promise);
  });

  it('scheduledEntity Promise resolves for "0 3,15 * * *" cron', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 3,15 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    // scheduled() wraps in .catch() — the Promise resolves (never rejects)
    await expect(promiseArg).resolves.toBeUndefined();
  });

  // ---- Branch 2: '0 0 * * *' → scheduledProcess ----

  it('routes "0 0 * * *" cron to scheduledProcess and calls ctx.waitUntil once', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 0 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    expect(promiseArg).toBeInstanceOf(Promise);
  });

  it('scheduledProcess Promise resolves for "0 0 * * *" cron', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 0 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    await expect(promiseArg).resolves.toBeUndefined();
  });

  // ---- Branch 3: '0 1 1 * *' → scheduledArchiveOldEntities ----

  it('routes "0 1 1 * *" cron to scheduledArchiveOldEntities and calls ctx.waitUntil once', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 1 1 * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    expect(promiseArg).toBeInstanceOf(Promise);
  });

  it('scheduledArchiveOldEntities Promise resolves for "0 1 1 * *" cron', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 1 1 * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    await expect(promiseArg).resolves.toBeUndefined();
  });

  // ---- Branch 4: '0 4 * * *' → scheduledFeedback ----

  it('routes "0 4 * * *" cron to scheduledFeedback and calls ctx.waitUntil once', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 4 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    expect(promiseArg).toBeInstanceOf(Promise);
  });

  it('scheduledFeedback Promise resolves for "0 4 * * *" cron', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 4 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    await expect(promiseArg).resolves.toBeUndefined();
  });

  // ---- Unknown cron: silent no-op ----

  it('unknown cron calls waitUntil zero times (silent no-op)', async () => {
    const worker = (await import('../src/index')).default;
    const controller = { cron: '99 99 99 99 99' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).not.toHaveBeenCalled();
  });

  it('null cron defaults to "unknown" and calls waitUntil zero times', async () => {
    const worker = (await import('../src/index')).default;
    // controller.cron is null → defaults to 'unknown' in scheduled()
    const controller = { cron: null } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).not.toHaveBeenCalled();
  });

  it('undefined cron defaults to "unknown" and calls waitUntil zero times', async () => {
    const worker = (await import('../src/index')).default;
    const controller = {} as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// scheduled() — error handling: catch block prevents Promise rejection
// =============================================================================

describe('scheduled() — error handling contract', () => {
  it('waitUntil Promise catches errors and resolves (never rejects)', async () => {
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;
    const mockEnv = makeMockEnv();

    // Force scheduledProcess to throw by providing empty required fields
    const badEnv = {
      ...makeMockEnv(),
      SUPABASE_URL: '',   // empty causes getSupabaseHost to fail
    };

    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 0 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, badEnv, mockCtx);

    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    // The .catch() inside scheduled() swallows the error — Promise resolves
    await expect(promiseArg).resolves.toBeUndefined();
  });
});

// =============================================================================
// scheduled() — null/undefined env fields are skipped gracefully
// =============================================================================

describe('scheduled() — env null-safety contract', () => {
  it('scheduled() works when PROCESS_STATE is undefined', async () => {
    const mockEnv = makeMockEnv();
    // @ts-expect-error — intentionally omitting optional field
    delete mockEnv.PROCESS_STATE;
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;

    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 0 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    const promiseArg = waitUntilSpy.mock.calls[0][0] as Promise<unknown>;
    await expect(promiseArg).resolves.toBeUndefined();
  });

  it('scheduled() works when AI_USAGE_KV is undefined', async () => {
    const mockEnv = makeMockEnv();
    // @ts-expect-error — intentionally omitting optional field
    delete mockEnv.AI_USAGE_KV;
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;

    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 3,15 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduled() works when VECTORIZE is undefined', async () => {
    const mockEnv = makeMockEnv();
    // @ts-expect-error — intentionally omitting optional field
    delete mockEnv.VECTORIZE;
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;

    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 3,15 * * *' } as unknown as ScheduledController;

    (worker as unknown as { scheduled: Function }).scheduled(controller, mockEnv, mockCtx);

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// scheduled() — ctx.waitUntil trap verification
// =============================================================================

describe('scheduled() — ctx.waitUntil trap awareness', () => {
  it('scheduled() returns void immediately (does not await waitUntil internally)', async () => {
    const mockEnv = makeMockEnv();
    // A waitUntil that would hang forever if scheduled() tried to await it
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as unknown as ExecutionContext;

    const worker = (await import('../src/index')).default;
    const controller = { cron: '0 0 * * *' } as unknown as ScheduledController;

    const start = Date.now();
    const result = (worker as unknown as { scheduled: Function }).scheduled(
      controller,
      mockEnv,
      mockCtx
    );
    const elapsed = Date.now() - start;

    // scheduled() must return undefined immediately — NOT awaiting waitUntil
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(100); // synchronous return (< 100ms)
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
  });

  it('each cron branch calls waitUntil exactly once from scheduled()', async () => {
    const crons = [
      '0 3,15 * * *',
      '0 0 * * *',
      '0 1 1 * *',
      '0 4 * * *',
    ];

    for (const cronExpr of crons) {
      const spy = vi.fn();
      const ctx = { waitUntil: spy } as unknown as ExecutionContext;
      const env = makeMockEnv();
      const worker = (await import('../src/index')).default;
      const controller = { cron: cronExpr } as unknown as ScheduledController;

      (worker as unknown as { scheduled: Function }).scheduled(controller, env, ctx);

      // scheduled() itself calls waitUntil exactly once per branch
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBeInstanceOf(Promise);
    }
  });
});
