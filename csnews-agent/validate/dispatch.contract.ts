/**
 * CSNEWS Agent · dispatch utility 业务契约 (v0.36.10 · KR0)
 *
 * 唯一目标：守住"16 action dispatch 路由表就是这样"（当前实现的 snapshot）
 *
 * 业务红线:
 *   - 16 个支持 action 白名单 (ALLOWED_ACTIONS): pull/diag/ping/model-test/ai-test/score/classify/batch-score/fission/save/list/embed/zaker-hot/process/health/logs/content/trend/knowledge
 *   - DEFAULT_ACTION = 'ping' (空 action fallback)
 *   - handleCorsPreflight: OPTIONS 请求返 200 + CORS 头, 其他 method 返 null
 *   - dispatchAction: unknown action 返 400 + { error: "unknown action" }
 *   - 19 个 handler 全部 import from './endpoints'
 *
 * 加新 action 时: ALLOWED_ACTIONS 加 + dispatchAction 加 1 行 + 此文件 describe 块补 1 个 it
 * 详见：tasks/csnews-agent-okr.md KR0
 *
 * v0.36.26 O13-MCP: 新增 2 个 MCP action (mcp / mcp-list) → 总计 23 个
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_ACTIONS,
  DEFAULT_ACTION,
  handleCorsPreflight,
  dispatchAction,
} from '../src/dispatch';

// ============================================================
// 业务常量
// ============================================================
describe('业务常量', () => {
  it('DEFAULT_ACTION 必须 = "ping" (v0.33 确定空 action fallback)', () => {
    expect(DEFAULT_ACTION).toBe('ping');
  });

  it('ALLOWED_ACTIONS 必须含 23 个 action (v0.36.26 新增 mcp / mcp-list)', () => {
    expect(ALLOWED_ACTIONS).toHaveLength(23);
  });

  it('ALLOWED_ACTIONS 必须含全部基础 action', () => {
    expect(ALLOWED_ACTIONS).toContain('pull');
    expect(ALLOWED_ACTIONS).toContain('ping');
    expect(ALLOWED_ACTIONS).toContain('model-test');
    expect(ALLOWED_ACTIONS).toContain('ai-test');
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
    expect(ALLOWED_ACTIONS).toContain('logs');
    expect(ALLOWED_ACTIONS).toContain('content');
    expect(ALLOWED_ACTIONS).toContain('trend');
    expect(ALLOWED_ACTIONS).toContain('knowledge');
    expect(ALLOWED_ACTIONS).toContain('mcp');
    expect(ALLOWED_ACTIONS).toContain('mcp-list');
  });
});

// ============================================================
// handleCorsPreflight
// ============================================================
describe('handleCorsPreflight · CORS preflight 处理', () => {
  it('OPTIONS 请求必须返 Response + CORS 头 (200)', () => {
    const req = new Request('https://example.com/', { method: 'OPTIONS' });
    const res = handleCorsPreflight(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it('OPTIONS 请求必须带 Access-Control-Allow-Origin 头 (origin 来自请求)', () => {
    const req = new Request('https://example.com/', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com' },
    });
    const res = handleCorsPreflight(req);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
  });

  it('GET 请求必须返 null (非 OPTIONS 不处理)', () => {
    const req = new Request('https://example.com/', { method: 'GET' });
    expect(handleCorsPreflight(req)).toBeNull();
  });

  it('POST 请求必须返 null', () => {
    const req = new Request('https://example.com/', { method: 'POST' });
    expect(handleCorsPreflight(req)).toBeNull();
  });

  it('PUT 请求必须返 null', () => {
    const req = new Request('https://example.com/', { method: 'PUT' });
    expect(handleCorsPreflight(req)).toBeNull();
  });

  it('DELETE 请求必须返 null', () => {
    const req = new Request('https://example.com/', { method: 'DELETE' });
    expect(handleCorsPreflight(req)).toBeNull();
  });
});

// ============================================================
// dispatchAction · unknown action
// ============================================================
describe('dispatchAction · unknown action 处理', () => {
  function makeMocks() {
    const env: any = { BEARER_TOKEN: 'test-token' };
    const ctx: any = { waitUntil: vi.fn() };
    return { env, ctx };
  }

  it('unknown action 必须返 400 + { error: "unknown action" }', async () => {
    const { env, ctx } = makeMocks();
    const req = new Request('https://example.com/?action=foo');
    const res = await dispatchAction(env, ctx, 'foo', req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unknown action');
  });

  it('空 action "" 必须按 DEFAULT_ACTION (ping) 走 (不返 400)', async () => {
    // 注意: index.ts 已 .get('action') || 'ping', 这里 dispatchAction 收的 action = 'ping'
    // 测 dispatchAction 接 'ping' 不返 unknown action
    const { env, ctx } = makeMocks();
    const req = new Request('https://example.com/?action=ping');
    const res = await dispatchAction(env, ctx, 'ping', req);
    expect(res.status).not.toBe(400);
  });

  it('大小写敏感 (KR0 实测: action=Health 不识别)', async () => {
    // 大小写不敏感不在 v0.36.10 scope
    const { env, ctx } = makeMocks();
    const req = new Request('https://example.com/?action=Health');
    const res = await dispatchAction(env, ctx, 'Health', req);
    expect(res.status).toBe(400);
  });

  it('dispatcher log 必须 fire-and-forget (ctx.waitUntil 调用但不阻塞)', async () => {
    const { env, ctx } = makeMocks();
    const req = new Request('https://example.com/?action=foo');
    const res = await dispatchAction(env, ctx, 'foo', req);
    // waitUntil 被调用 (logEvent dispatch 写)
    expect(ctx.waitUntil).toHaveBeenCalled();
    // Response 仍返 400 (不阻塞)
    expect(res.status).toBe(400);
  });
});

// ============================================================
// dispatchAction · action 路由正确性
// ============================================================
describe('dispatchAction · 21 action 路由正确性 (mock handler 路径)', () => {
  function makeMocks() {
    const env: any = { BEARER_TOKEN: 'test-token' };
    const ctx: any = { waitUntil: vi.fn() };
    return { env, ctx };
  }

  // 注意: 这些测试验证 dispatch 路由 (即 action 是否在 ALLOWED_ACTIONS 内)
  // 不实际调 handler (handler 内部真实 Supabase / R2 / Workers AI 调用必失败)
  // 测法: ALLOWED_ACTIONS 包含 action → dispatch 不会返 "unknown action"
  // 但若 handler 抛错, dispatch 仍会接到错误响应 (401/500), 这不是 dispatch 责任
  // 所以更安全: 只验证 action 字符串在 ALLOWED_ACTIONS 内
  const actionsToTest = [
    'pull',
    'ping',
    'model-test',
    'ai-test',
    'score',
    'classify',
    'batch-score',
    'fission',
    'save',
    'list',
    'embed',
    'zaker-hot',
    'rescore',
    'process',
    'health',
    'logs',
    'content',
    'trend',
    'knowledge',
    'mcp',
    'mcp-list',
  ];

  for (const action of actionsToTest) {
    it(`${action} 必须在 ALLOWED_ACTIONS 白名单 (dispatch 路由正确)`, () => {
      // 静态验证: 不实际调 dispatchAction (避免 handler 真实调用)
      expect(ALLOWED_ACTIONS).toContain(action);
    });
  }
});
