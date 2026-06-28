/**
 * Business contract tests for dispatch.ts action routing.
 * Covers routing logic, unknown action handling, CORS behavior,
 * and blacklist validation via observable behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKVNamespace } from '../test-helpers';

// =============================================================================
// dispatchAction — routing behavior
// =============================================================================

describe('dispatch.ts — dispatchAction routing', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      SUPABASE_URL: 'test-project',
      SUPABASE_SERVICE_KEY: 'test-key',
      BEARER_TOKEN: 'test-token',
      WORKER_SELF_URL: 'https://test.workers.dev',
      PROCESS_STATE: createMockKVNamespace({}),
      AI_USAGE_KV: createMockKVNamespace({}),
      csnews_raw: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [] }),
      },
      AI: {
        run: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1024).fill(0.1) }],
        }),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRequest(action: string, extraParams = ''): Request {
    return new Request(`http://localhost/?action=${action}${extraParams}`, {
      method: 'GET',
    });
  }

  it('dispatchAction is a function', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    expect(typeof dispatchAction).toBe('function');
  });

  it('returns a Response object for valid actions', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ping');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    expect(res).toBeInstanceOf(Response);
  });

  it('ping action returns 200 status', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ping');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    expect(res.status).toBe(200);
  });

  it('ping returns JSON body with ok=true', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ping');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('score action with title param returns 200 status', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('score', '&title=突发：AI技术重大突破');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'score', req);
    expect(res.status).toBe(200);
  });

  it('score action returns JSON with score field', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('score', '&title=突发：AI技术重大突破');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'score', req);
    const body = await res.json();
    expect(body).toHaveProperty('score');
    expect(typeof body.score).toBe('number');
  });

  it('score without title returns 400', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('score');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'score', req);
    expect(res.status).toBe(400);
  });

  it('unknown action returns 400', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('foobar');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'foobar', req);
    expect(res.status).toBe(400);
  });

  it('unknown action returns JSON with error field', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('invalid-action');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'invalid-action', req);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('unknown action error contains "unknown action"', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('bad-action-xyz');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'bad-action-xyz', req);
    const body = await res.json();
    expect(body.error).toMatch(/unknown/i);
  });

  it('empty action string returns 400', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = new Request('http://localhost/', { method: 'GET' });
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, '', req);
    expect(res.status).toBe(400);
  });

  it('response includes CORS Access-Control-Allow-Origin header', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ping');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('response includes JSON Content-Type', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ping');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('action routing is case-sensitive (uppercase rejected)', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, 'PING', req);
    expect(res.status).toBe(400);
  });

  it('action with trailing space is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, 'ping ', req);
    expect(res.status).toBe(400);
  });

  it('logEvent is called asynchronously via waitUntil', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const waitUntilSpy = vi.fn();
    const mockCtx = { waitUntil: waitUntilSpy } as any;
    const req = makeRequest('ping');
    await dispatchAction(mockEnv, mockCtx, 'ping', req);
    expect(waitUntilSpy).toHaveBeenCalled();
  });

  it('response is returned without waiting for waitUntil to complete', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const waitUntilSpy = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves
    const mockCtx = { waitUntil: waitUntilSpy } as any;
    const req = makeRequest('ping');
    const start = Date.now();
    const res = await dispatchAction(mockEnv, mockCtx, 'ping', req);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200); // Response returns immediately
  });

  it('classify action with title returns 200', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('classify', '&title=OpenAI发布新模型');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'classify', req);
    expect(res.status).toBe(200);
  });

  it('classify without title returns 400', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('classify');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'classify', req);
    expect(res.status).toBe(400);
  });

  it('health action returns 200', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('health');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'health', req);
    expect(res.status).toBe(200);
  });

  it('mcp-list action returns 200', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('mcp-list');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'mcp-list', req);
    expect(res.status).toBe(200);
  });

  it('ai-usage action returns 200', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const req = makeRequest('ai-usage');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const res = await dispatchAction(mockEnv, mockCtx, 'ai-usage', req);
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// dispatchAction — whitelist enforcement via negative tests
// (ALLOWED_ACTIONS is internal; verify the contract via observable behavior)
// =============================================================================

describe('dispatch.ts — whitelist enforcement (observable)', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      SUPABASE_URL: 'test-project',
      SUPABASE_SERVICE_KEY: 'test-key',
      BEARER_TOKEN: 'test-token',
      WORKER_SELF_URL: 'https://test.workers.dev',
      PROCESS_STATE: createMockKVNamespace({}),
      AI_USAGE_KV: createMockKVNamespace({}),
      csnews_raw: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [] }),
      },
      AI: { run: vi.fn().mockResolvedValue({ data: [{ embedding: [] }] }) },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('random garbage string is rejected with 400', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, 'asdfghjkl', req);
    expect(res.status).toBe(400);
  });

  it('sql injection attempt is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, "'; DROP TABLE users; --", req);
    expect(res.status).toBe(400);
  });

  it('path traversal attempt is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, '../../../etc/passwd', req);
    expect(res.status).toBe(400);
  });

  it('null byte injection is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, 'ping\x00injected', req);
    expect(res.status).toBe(400);
  });

  it('unicode override attempt is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await dispatchAction(mockEnv, mockCtx, 'ΡΙΝG', req);
    expect(res.status).toBe(400);
  });

  it('very long action string is rejected', async () => {
    const { dispatchAction } = await import('../src/dispatch');
    const mockCtx = { waitUntil: vi.fn() } as any;
    const req = new Request('http://localhost/', { method: 'GET' });
    const longAction = 'a'.repeat(1000);
    const res = await dispatchAction(mockEnv, mockCtx, longAction, req);
    expect(res.status).toBe(400);
  });
});
