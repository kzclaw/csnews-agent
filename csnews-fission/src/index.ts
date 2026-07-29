/**
 * CSNEWS Fission Worker · 主入口
 *
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 职责：
 *   - Cron Trigger：每 6 小时扫描 explosive + score=9 的 topic，执行裂变
 *   - HTTP fetch：健康检查 + 手动触发裂变
 *
 * 架构（monorepo 子目录）：
 *   - src/index.ts：Worker 入口（fetch + scheduled）
 *   - src/fission-trigger.ts：裂变核心逻辑
 *   - src/shared.ts：共享类型
 *   - src/utils.ts：工具函数
 */
import { Env, getSupabaseHost } from './shared';
import { supabaseHeaders } from './utils';
import { runFissionTrigger, findFissionTopics, runFissionForTopic } from './fission-trigger';
import { authRequest, corsHeaders } from './auth';

// ====== HTTP fetch handler ======
async function handleFetch(request: Request, env: Env): Promise<Response> {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin');
    return new Response(null, {
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // 鉴权（ping 不需要）
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'ping';
  const NO_AUTH_ACTIONS = ['ping', 'debug-token', 'debug-fission', 'debug-r2'];
  if (!NO_AUTH_ACTIONS.includes(action)) {
    const deny = authRequest(request, env);
    if (deny) return deny;
  }

  if (action === 'ping') {
    return new Response(JSON.stringify({ ok: true, worker: 'csnews-fission', action }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'health') {
    return new Response(
      JSON.stringify({
        ok: true,
        worker: 'csnews-fission',
        action: 'health',
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 调试端点：看 env.BEARER_TOKEN 长度（不暴露内容）
  if (action === 'debug-token') {
    const tokenLen = env.BEARER_TOKEN ? env.BEARER_TOKEN.length : -1;
    return new Response(JSON.stringify({ ok: true, bearer_token_length: tokenLen }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // DEBUG: step-by-step diagnostics
  if (action === 'debug-fission') {
    const supabaseUrl = getSupabaseHost(env);
    const steps: Record<string, string> = {};

    // Step 1: find topics
    try {
      const r1 = await fetch(
        `${supabaseUrl}/rest/v1/topics?score=eq.9&level=eq.explosive&order=created_at.desc&limit=1&select=id,topic_key,level,score`,
        { headers: { ...supabaseHeaders(env.SUPABASE_SERVICE_KEY), 'Content-Type': 'application/json' } }
      );
      const topics = await r1.json() as any[];
      steps['topics'] = JSON.stringify(topics);
    } catch (e) { steps['topics_error'] = String(e); }

    return new Response(
      JSON.stringify({ ok: true, env_ok: { ai: !!env.AI, r2: !!env.csnews_raw, supabase: !!env.SUPABASE_SERVICE_KEY }, steps }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // DEBUG: test R2 write directly
  if (action === 'debug-r2') {
    if (!env.csnews_raw) {
      return new Response(JSON.stringify({ ok: false, error: 'csnews_raw binding missing' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    const testKey = `fission/debug/test-${Date.now()}.txt`;
    const testContent = `R2 write test at ${new Date().toISOString()}`;
    try {
      await env.csnews_raw.put(testKey, testContent, {
        httpMetadata: { contentType: 'text/plain' },
      });
      const obj = await env.csnews_raw.get(testKey);
      const readBack = obj ? await obj.text() : 'FILE NOT FOUND';
      return new Response(JSON.stringify({ ok: true, testKey, readBack, length: readBack.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err), testKey }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // 手动触发裂变（用于调试或手动干预）
  if (action === 'fission-manual') {
    try {
      // v0.37.79 fix: 从 main worker Service Binding 收 topic_ids 参数,
      // 直接查 topic 处理, 不再依赖 score=eq.9 (RPC 已重置 score=0)
      const topicIdsParam = url.searchParams.get('topic_ids') || '';
      if (topicIdsParam) {
        const topicIds = topicIdsParam.split(',').filter(Boolean);
        let processed = 0;
        for (const tid of topicIds) {
          const topics = await findFissionTopics(env, tid);
          if (topics.length > 0) {
            await runFissionForTopic(env, topics[0]);
            processed++;
          }
        }
        return new Response(
          JSON.stringify({ ok: true, action: 'fission-manual', result: 'seed_triggered', topics: processed }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      // fallback: 扫描 score=eq.9 (cron / 手动调试)
      await runFissionTrigger(env);
      return new Response(
        JSON.stringify({ ok: true, action: 'fission-manual', result: 'triggered' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
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

  // v0.37.51: Pre-step — pick up tavily_pending flag left by main worker's
  // ?action=process handler. Asking the main worker through the Service
  // Binding gives its Tavily pipeline a fresh 50-subrequest budget instead
  // of fighting over the calling process invocation's exhausted budget.
  await runPendingTavilyTrigger(env);

  try {
    await runFissionTrigger(env);
    console.log(`[cron] csnews-fission completed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[cron] csnews-fission error:', err);
  }
}

/**
 * v0.37.51: drain the tavily_pending flag the main worker writes when its
 * process pipeline sees data worth Tavily ingest. Uses Service Binding so
 * the call lands in the main worker's own invocation, with its own budget.
 */
async function runPendingTavilyTrigger(env: Env): Promise<void> {
  if (!env.PROCESS_STATE || !env.CSNEWS_AGENT) {
    console.log('[cron] tavily-async skip: bindings missing (PROCESS_STATE or CSNEWS_AGENT)');
    return;
  }
  let raw: string | null = null;
  try {
    raw = await env.PROCESS_STATE.get('tavily_pending');
  } catch (e) {
    console.error('[cron] tavily-async KV get failed:', e);
    return;
  }
  if (!raw) return;

  console.log('[cron] tavily-async: flag set, calling CSNEWS_AGENT ?action=tavily&max=1');
  let body = '';
  let status = 0;
  try {
    const resp = await env.CSNEWS_AGENT.fetch(
      'https://internal/?action=tavily&max=1'
    );
    status = resp.status;
    body = await resp.text();
    console.log(`[cron] tavily-async: status=${status} body=${body.slice(0, 200)}`);
  } catch (e) {
    console.error('[cron] tavily-async fetch failed:', e);
  }

  // Delete the flag regardless of fetch outcome so a transient error
  // doesn't keep retriggering every 6 hours.
  try {
    await env.PROCESS_STATE.delete('tavily_pending');
  } catch (e) {
    console.error('[cron] tavily-async KV delete failed:', e);
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
