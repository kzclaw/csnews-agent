/**
 * Business contract tests for dispatch.ts action routing.
 */

describe('dispatch.ts — ALLOWED_ACTIONS coverage', () => {
  it('contains all expected actions', async () => {
    const { ALLOWED_ACTIONS } = await import('../src/dispatch');
    expect(ALLOWED_ACTIONS).toContain('pull');
    expect(ALLOWED_ACTIONS).toContain('ping');
    expect(ALLOWED_ACTIONS).toContain('score');
    expect(ALLOWED_ACTIONS).toContain('classify');
    expect(ALLOWED_ACTIONS).toContain('batch-score');
    expect(ALLOWED_ACTIONS).toContain('fission');
    expect(ALLOWED_ACTIONS).toContain('save');
    expect(ALLOWED_ACTIONS).toContain('list');
    expect(ALLOWED_ACTIONS).toContain('embed');
    expect(ALLOWED_ACTIONS).toContain('zaker-hot');
    expect(ALLOWED_ACTIONS).toContain('rescore');
    expect(ALLOWED_ACTIONS).toContain('process');
    expect(ALLOWED_ACTIONS).toContain('health');
    expect(ALLOWED_ACTIONS).toContain('ai-usage');
    expect(ALLOWED_ACTIONS).toContain('logs');
    expect(ALLOWED_ACTIONS).toContain('content');
    expect(ALLOWED_ACTIONS).toContain('trend');
    expect(ALLOWED_ACTIONS).toContain('knowledge');
    expect(ALLOWED_ACTIONS).toContain('entity');
    expect(ALLOWED_ACTIONS).toContain('event');
    expect(ALLOWED_ACTIONS).toContain('mcp');
    expect(ALLOWED_ACTIONS).toContain('mcp-list');
    expect(ALLOWED_ACTIONS).toContain('feedback-check');
    expect(ALLOWED_ACTIONS).toContain('tavily');
    expect(ALLOWED_ACTIONS).toContain('proxy');
    expect(ALLOWED_ACTIONS).toContain('model-test');
    expect(ALLOWED_ACTIONS).toContain('ai-test');
  });

  it('has 26 actions total', async () => {
    const { ALLOWED_ACTIONS } = await import('../src/dispatch');
    expect(ALLOWED_ACTIONS.length).toBe(27);
  });

  it('DEFAULT_ACTION is ping', async () => {
    const { DEFAULT_ACTION } = await import('../src/dispatch');
    expect(DEFAULT_ACTION).toBe('ping');
  });

  it('DEFAULT_ACTION is a valid action', async () => {
    const { DEFAULT_ACTION, ALLOWED_ACTIONS } = await import('../src/dispatch');
    expect(ALLOWED_ACTIONS.includes(DEFAULT_ACTION)).toBe(true);
  });
});

describe('dispatch.ts — handleCorsPreflight', () => {
  it('returns null for non-OPTIONS requests', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    const request = new Request('http://localhost/', { method: 'GET' });
    const result = handleCorsPreflight(request);
    expect(result).toBeNull();
  });

  it('returns Response for OPTIONS requests', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    const request = new Request('http://localhost/', { method: 'OPTIONS' });
    const result = handleCorsPreflight(request);
    expect(result).not.toBeNull();
    expect(result instanceof Response).toBe(true);
  });

  it('OPTIONS response has correct CORS headers', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    const request = new Request('http://localhost/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });
    const result = handleCorsPreflight(request);
    expect(result).not.toBeNull();
    const headers = result!.headers;
    expect(headers.has('Access-Control-Allow-Origin')).toBe(true);
    expect(headers.has('Access-Control-Allow-Methods')).toBe(true);
  });

  it('handles OPTIONS without Origin header', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    const request = new Request('http://localhost/', { method: 'OPTIONS' });
    const result = handleCorsPreflight(request);
    expect(result).not.toBeNull();
    expect(result instanceof Response).toBe(true);
  });

  it('handles different Origin values', async () => {
    const { handleCorsPreflight } = await import('../src/dispatch');
    const origins = [
      'https://example.com',
      'https://app.example.com',
      'null',
    ];
    for (const origin of origins) {
      const request = new Request('http://localhost/', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      const result = handleCorsPreflight(request);
      expect(result instanceof Response).toBe(true);
    }
  });
});
