/**
 * CSNEWS Agent · Reader Float Modal / proxy 端点业务红线契约（v0.37）
 *
 * 唯一目标：守住"proxy 端点 API 契约就是这样"（当前实现的 snapshot）
 *
 * 业务红线:
 *   - action=proxy: url 参数必填, 仅支持 http/https
 *   - 反爬: 单 IP 60 req/min (KV key = content_rate:<ip>)
 *   - 超时: 10s 硬截止
 *   - 非 HTML: 415 Unsupported Media Type
 *   - fetch 失败: 502 Bad Gateway
 *   - Readability 解析失败: 502
 *
 * 详见: tasks/csnews-agent-okr.md O2KR2 · Reader 浮窗 Readability 模式
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rateKeyForIp, RATE_LIMIT_PER_MIN } from '../src/content-validation';
import { createMockKVNamespace } from '../src/test-helpers';

// ============================================================
// Mock linkedom + @mozilla/readability
// ============================================================
// 避免 vitest ESM 环境里 import linkedom 报错
vi.mock('linkedom', () => ({
  parseHTML: vi.fn((html: string) => {
    // 简单 DOM mock: 返回一个带 querySelector 的 document mock
    const createEl = (tag: string) => ({
      tagName: tag.toUpperCase(),
      textContent: '',
      innerHTML: '',
      setAttribute: vi.fn(),
      appendChild: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      removeChild: vi.fn(),
      getAttribute: vi.fn(() => null),
    });
    return {
      document: {
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        createElement: createEl,
        documentElement: createEl('html'),
        body: createEl('body'),
        head: createEl('head'),
        title: '',
        content: '',
        textContent: '',
      },
      window: {},
    };
  }),
}));

vi.mock('@mozilla/readability', () => ({
  Readability: vi.fn().mockImplementation(function (this: any, _doc: any, _opts: any) {
    this.parse = vi.fn().mockReturnValue({
      title: 'Test Article',
      content: '<p>Hello world content</p>',
      textContent: 'Hello world content',
      siteName: 'example.com',
      length: 28,
      excerpt: null,
      byline: null,
      dir: null,
    });
  }),
}));

// ============================================================
// 辅助: 构建 mock Request / URL / Env / ExecutionContext
// ============================================================

function buildMockCtx(prefill: Record<string, string> = {}) {
  const kvStore: Record<string, string> = { ...prefill };
  const mockKV = createMockKVNamespace(kvStore);
  // put/删除 直接写 kvStore (不重新赋值 mockKV.get, 避免闭包覆盖)
  mockKV.put = vi.fn().mockImplementation(async (key: string, value: string) => {
    kvStore[key] = value;
  });
  return {
    kvStore,
    mockKV,
    ctx: {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

function buildMockEnv(mockCtx: ReturnType<typeof buildMockCtx>) {
  return {
    SUPABASE_SERVICE_KEY: 'test-key',
    BEARER_TOKEN: 'test-bearer',
    csnews_raw: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    },
    PROCESS_STATE: mockCtx.mockKV as any,
    AI: { run: vi.fn() },
    WORKER_SELF_URL: 'https://test.example.com',
  } as any;
}

function makeRequest(url: string, options: RequestInit = {}) {
  return new Request(url, {
    headers: { 'CF-Connecting-IP': '1.2.3.4', Authorization: 'Bearer test-bearer', ...options.headers },
    ...options,
  });
}

// ============================================================
// rateKeyForIp (来自 content-validation.ts)
// ============================================================
describe('rateKeyForIp · KV key 格式', () => {
  it('ip=1.2.3.4 → content_rate:1.2.3.4', () => {
    expect(rateKeyForIp('1.2.3.4')).toBe('content_rate:1.2.3.4');
  });
  it('ip=unknown → content_rate:unknown', () => {
    expect(rateKeyForIp('unknown')).toBe('content_rate:unknown');
  });
  it('空 ip → content_rate:unknown (空字符串取默认值 unknown)', () => {
    expect(rateKeyForIp('')).toBe('content_rate:unknown');
  });
  it('RATE_LIMIT_PER_MIN = 60', () => {
    expect(RATE_LIMIT_PER_MIN).toBe(60);
  });
});

// ============================================================
// handleProxyAction · URL 参数校验
// ============================================================
describe('handleProxyAction · URL 参数校验', async () => {
  const { handleProxyAction } = await import('../src/endpoints-proxy');

  let mockCtx: ReturnType<typeof buildMockCtx>;
  let env: ReturnType<typeof buildMockEnv>;

  beforeEach(() => {
    mockCtx = buildMockCtx();
    env = buildMockEnv(mockCtx);
    vi.clearAllMocks();
  });

  it('无 url 参数 → 400 missing_url', async () => {
    const req = makeRequest('https://test.example.com/?action=proxy');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('missing_url');
  });

  it('url=非 URL 字符串 → 400 invalid_url', async () => {
    const req = makeRequest('https://test.example.com/?action=proxy&url=not-a-url');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('invalid_url');
  });

  it('url=file:// → 400 invalid_url (仅 http/https)', async () => {
    const req = makeRequest('https://test.example.com/?action=proxy&url=file:///etc/passwd');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('invalid_url');
  });

  it('url=javascript: → 400 invalid_url', async () => {
    const req = makeRequest('https://test.example.com/?action=proxy&url=javascript:alert(1)');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('invalid_url');
  });
});

// ============================================================
// handleProxyAction · 限流
// ============================================================
describe('handleProxyAction · 限流 60 req/min', async () => {
  const { handleProxyAction } = await import('../src/endpoints-proxy');

  it('同一 IP 第 61 次请求 → 429 rate_limited', async () => {
    // 预填 count=60 (已达到 60 req/min 阈值)
    const prefill: Record<string, string> = { 'content_rate:1.2.3.4': '60' };
    const { mockKV } = buildMockCtx(prefill);

    const env = {
      PROCESS_STATE: mockKV as any,
    } as any;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const req = makeRequest('https://test.example.com/?action=proxy&url=https://example.com');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, ctx);
    expect(resp.status).toBe(429);
    const body = await resp.json();
    expect(body.error).toBe('rate_limited');
    expect(body.reason).toContain('60');
  });
});

// ============================================================
// handleProxyAction · fetch 场景
// ============================================================
describe('handleProxyAction · fetch 场景', async () => {
  const { handleProxyAction } = await import('../src/endpoints-proxy');

  let mockCtx: ReturnType<typeof buildMockCtx>;
  let env: ReturnType<typeof buildMockEnv>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCtx = buildMockCtx();
    env = buildMockEnv(mockCtx);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    vi.clearAllMocks();
  });

  it('HTTP 500 响应 → 502 fetch_failed', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 500, headers: { 'content-type': 'text/html' } })
    );
    const req = makeRequest('https://test.example.com/?action=proxy&url=https://badsite.com/');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toBe('fetch_failed');
  });

  it('非 HTML Content-Type → 415 unsupported_content_type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"json": "data"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const req = makeRequest('https://test.example.com/?action=proxy&url=https://api.example.com/data');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(415);
    const body = await resp.json();
    expect(body.error).toBe('unsupported_content_type');
  });

  it('HTML 正常响应 → 200 text/html', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body><article><h1>Test</h1><p>Hello world</p></article></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
    const req = makeRequest('https://test.example.com/?action=proxy&url=https://news.example.com/article');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toContain('Test');
  });

  it('fetch throw (网络错误) → 502 fetch_failed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const req = makeRequest('https://test.example.com/?action=proxy&url=https://offline.example.com/');
    const url = new URL(req.url);
    const resp = await handleProxyAction(req, env, url, {}, mockCtx.ctx);
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toBe('fetch_failed');
  });
});
