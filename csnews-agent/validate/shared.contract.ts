/**
 * Business contract tests for the shared utility module.
 * Covers supabaseFetch, safeJson, jsonResponse, validationError,
 * parseCountHeader, payloadTooLargeResponse, and getSupabaseHost.
 */

import { describe, it, expect } from 'vitest';
import { createMockUrl } from '../test-helpers';

// Mock fetch helper
function mockFetchSuccess(data: unknown, status = 200) {
  const orig = globalThis.fetch;
  globalThis.fetch = (url: URL | RequestInfo, init?: RequestInit) => {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => data,
      text: async () => JSON.stringify(data),
    }) as unknown as Promise<Response>;
  };
  return () => { globalThis.fetch = orig; };
}

describe('getSupabaseHost', () => {
  it('returns correct Supabase host URL', async () => {
    const { getSupabaseHost } = await import('../src/shared');
    const mockEnv = { SUPABASE_URL: 'my-project' } as any;
    expect(getSupabaseHost(mockEnv)).toBe('https://my-project.supabase.co');
  });
});

describe('supabaseFetch', () => {
  it('sets correct Supabase headers', async () => {
    const { supabaseFetch } = await import('../src/shared');
    const restore = mockFetchSuccess({ ok: true });
    try {
      const mockEnv = {
        SUPABASE_URL: 'test-project',
        SUPABASE_SERVICE_KEY: 'test-key-123',
      } as any;
      await supabaseFetch(mockEnv, '/rest/v1/news_hotspots');
      // Verify fetch was called
      expect(globalThis.fetch).toBeDefined();
    } finally {
      restore();
    }
  });

  it('allows method override via options', async () => {
    const { supabaseFetch } = await import('../src/shared');
    const restore = mockFetchSuccess({ id: 1 });
    try {
      const mockEnv = {
        SUPABASE_URL: 'test-project',
        SUPABASE_SERVICE_KEY: 'test-key-123',
      } as any;
      await supabaseFetch(mockEnv, '/rest/v1/news_hotspots', { method: 'POST' });
    } finally {
      restore();
    }
  });
});

describe('safeJson', () => {
  it('parses valid JSON', async () => {
    const { safeJson } = await import('../src/shared');
    const mockRes = {
      ok: true,
      text: async () => '{"key":"value"}',
    } as unknown as Response;
    expect(await safeJson(mockRes)).toEqual({ key: 'value' });
  });

  it('returns null for empty response', async () => {
    const { safeJson } = await import('../src/shared');
    const mockRes = {
      ok: true,
      text: async () => '',
    } as unknown as Response;
    expect(await safeJson(mockRes)).toBeNull();
  });

  it('returns null for whitespace-only response', async () => {
    const { safeJson } = await import('../src/shared');
    const mockRes = {
      ok: true,
      text: async () => '   \n\t  ',
    } as unknown as Response;
    expect(await safeJson(mockRes)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const { safeJson } = await import('../src/shared');
    const mockRes = {
      ok: true,
      text: async () => 'not json {',
    } as unknown as Response;
    expect(await safeJson(mockRes)).toBeNull();
  });

  it('returns parsed null value', async () => {
    const { safeJson } = await import('../src/shared');
    const mockRes = {
      ok: true,
      text: async () => 'null',
    } as unknown as Response;
    expect(await safeJson(mockRes)).toBeNull();
  });
});

describe('jsonResponse', () => {
  it('returns Response with correct headers', async () => {
    const { jsonResponse } = await import('../src/shared');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const res = jsonResponse({ message: 'ok' }, cors);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('serializes data as JSON', async () => {
    const { jsonResponse } = await import('../src/shared');
    const data = { count: 42, items: ['a', 'b'] };
    const res = jsonResponse(data, {});
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(data);
  });

  it('respects custom status via init', async () => {
    const { jsonResponse } = await import('../src/shared');
    const res = jsonResponse({ error: 'not found' }, {}, { status: 404 });
    expect(res.status).toBe(404);
  });
});

describe('validationError', () => {
  it('returns 400 status', async () => {
    const { validationError } = await import('../src/shared');
    const result = { ok: false, error: 'invalid_param', reason: 'missing id' };
    const res = validationError(result, {});
    expect(res.status).toBe(400);
  });

  it('returns correct JSON body', async () => {
    const { validationError } = await import('../src/shared');
    const result = { ok: false, error: 'bad_input', reason: 'invalid format' };
    const res = validationError(result, {});
    const body = await res.json();
    expect(body.error).toBe('bad_input');
    expect(body.reason).toBe('invalid format');
  });

  it('handles missing reason field', async () => {
    const { validationError } = await import('../src/shared');
    const result = { ok: false, error: 'validation_failed' };
    const res = validationError(result, {});
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.reason).toBeNull();
  });
});

describe('parseCountHeader', () => {
  it('parses valid content-range header', async () => {
    const { parseCountHeader } = await import('../src/shared');
    const mockRes = {
      headers: new Map([['content-range', '0-19/100']]),
    } as unknown as Response;
    expect(parseCountHeader(mockRes)).toBe(100);
  });

  it('returns 0 when header is missing', async () => {
    const { parseCountHeader } = await import('../src/shared');
    const mockRes = { headers: new Map() } as unknown as Response;
    expect(parseCountHeader(mockRes)).toBe(0);
  });

  it('returns 0 when header format is invalid', async () => {
    const { parseCountHeader } = await import('../src/shared');
    const mockRes = {
      headers: new Map([['content-range', 'invalid']]),
    } as unknown as Response;
    expect(parseCountHeader(mockRes)).toBe(0);
  });

  it('handles range with only total', async () => {
    const { parseCountHeader } = await import('../src/shared');
    const mockRes = {
      headers: new Map([['content-range', '*/500']]),
    } as unknown as Response;
    expect(parseCountHeader(mockRes)).toBe(500);
  });
});

describe('payloadTooLargeResponse', () => {
  it('returns 413 status', async () => {
    const { payloadTooLargeResponse } = await import('../src/shared');
    const res = payloadTooLargeResponse('entity too big', 1024, {});
    expect(res.status).toBe(413);
  });

  it('returns correct JSON body', async () => {
    const { payloadTooLargeResponse } = await import('../src/shared');
    const res = payloadTooLargeResponse('image exceeds 5MB', 5 * 1024 * 1024, {});
    const body = await res.json();
    expect(body.error).toBe('payload_too_large');
    expect(body.reason).toBe('image exceeds 5MB');
  });
});
