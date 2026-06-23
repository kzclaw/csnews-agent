/**
 * CSNEWS Fission Worker · 主入口
 *
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 职责：
 *   - Cron Trigger：每 30 分钟扫描 explosive + score=9 的 topic，执行裂变
 *   - HTTP fetch：健康检查 + 手动触发裂变
 *
 * 架构（monorepo 子目录）：
 *   - src/index.ts：Worker 入口（fetch + scheduled）
 *   - src/fission-trigger.ts：裂变核心逻辑
 *   - src/shared.ts：共享类型
 *   - src/utils.ts：工具函数
 */
import { Env } from './shared';
import { runFissionTrigger } from './fission-trigger';
import { authRequest } from './auth';

// ====== HTTP fetch handler ======
async function handleFetch(request: Request, env: Env): Promise<Response> {
  // 鉴权（ping 不需要）
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'ping';
  if (action !== 'ping') {
    const deny = authRequest(request, env);
    if (deny) return deny;
  }

  if (action === 'ping') {
    return new Response(JSON.stringify({ ok: true, worker: 'csnews-fission', action }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'health') {
    return new Response(JSON.stringify({
      ok: true,
      worker: 'csnews-fission',
      action: 'health',
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 手动触发裂变（用于调试或手动干预）
  if (action === 'fission-manual') {
    try {
      await runFissionTrigger(env);
      return new Response(JSON.stringify({ ok: true, action: 'fission-manual', result: 'triggered' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ====== Cron Trigger handler ======
async function handleScheduled(env: Env, controller: ScheduledController): Promise<void> {
  const ts = new Date().toISOString();
  const cron = controller?.cron || 'unknown';
  console.log(`[cron] csnews-fission triggered at ${ts} cron=${cron}`);

  try {
    await runFissionTrigger(env);
    console.log(`[cron] csnews-fission completed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[cron] csnews-fission error:', err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(env, controller);
  },
};
