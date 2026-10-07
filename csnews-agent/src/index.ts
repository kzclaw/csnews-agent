/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 */

import { dispatchAction } from './dispatch';
import { VIEWER_HTML } from './viewer-page';
import { Env, getSupabaseHost, jsonResponse } from './shared';
import { authRequest, corsHeaders } from './auth';
import { logEvent } from './log';
import {
  scheduledProcess,
  scheduledEntity,
  scheduledArchiveOldEntities,
  scheduledFeedback,
  scheduledReset,
} from './scheduled';

// ============================================================
// 主 Worker
// ============================================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';

    // v0.37.3 鉴权回归修复：public endpoint 白名单
    // 健康检查/模型测试/health 端点（9 维度）默认放行，无需鉴权
    const PUBLIC_ACTIONS = new Set(['ping', 'health', 'model-test']);
    if (!PUBLIC_ACTIONS.has(action)) {
      const authError = authRequest(request, env);
      if (authError) return authError;
    }

    // viewer 路由: GET /viewer → 返回本 Worker 同源的 viewer HTML
    // 目的: 让 viewer 与 API 同源, 避免本地 http 页面向 https Worker 取数被浏览器 Mixed Content 拦截
    // 注: viewer 端点走 PUBLIC (类似 ping/health), 因为用户要先看到 viewer 才能输入 token
    if (url.pathname.endsWith('/viewer') && request.method === 'GET') {
      return new Response(VIEWER_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...cors,
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    if (action === 'diag') {
      const results = [];

      // 1. Insert topic
      const t0 = Date.now();
      const tr = await fetch(`${getSupabaseHost(env)}/rest/v1/topics`, {
        method: 'POST',
        body: JSON.stringify({ topic_key: 'diag-' + Date.now(), level: 'follow' }),
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      });
      const t0t = await tr.text();
      let t0id = null;
      try {
        const d = JSON.parse(t0t);
        t0id = d?.[0]?.id || d?.id;
      } catch {}
      results.push({ step: 'topic_insert', status: tr.status, id: t0id, body: t0t.slice(0, 100) });

      // 2. Insert news
      const t1 = Date.now();
      const nr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_hotspots`, {
        method: 'POST',
        body: JSON.stringify({ title: 'diag-' + Date.now(), source: 'zaker', category: '测试' }),
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      });
      const t1t = await nr.text();
      let t1id = null;
      try {
        const d = JSON.parse(t1t);
        t1id = d?.[0]?.id || d?.id;
      } catch {}
      results.push({ step: 'news_insert', status: nr.status, id: t1id, body: t1t.slice(0, 100) });

      // 3. Join (if both IDs exist)
      if (t0id && t1id) {
        const t2 = Date.now();
        // Join: news_topic_members.news_id = news.id, topic_id = topic.id
        const jr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_topic_members`, {
          method: 'POST',
          body: JSON.stringify({ news_id: t1id, topic_id: t0id, role: 'seed' }),
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
        });
        const t2t = await jr.text();
        results.push({ step: 'join', status: jr.status, body: t2t.slice(0, 200) });
      } else {
        results.push({ step: 'join', status: -1, reason: 'missing IDs', tid: t0id, nid: t1id });
      }

      return jsonResponse({ ts: Date.now(), results }, cors);
    }

    // All other actions → dispatch layer (pull, health, ai-usage, ping, score, etc.)
    return await dispatchAction(env, ctx, action, request);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const cron = controller?.cron ?? 'unknown';

    // Route to the appropriate handler based on cron expression
    if (cron === '0 3,15 * * *') {
      // Entity selflearn + process + event clustering — twice daily (03:00 & 15:00 UTC)
      // bge-m3 ~5K Neurons/day, within Free Plan 10K/day quota
      ctx.waitUntil(
        scheduledEntity(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] entity error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 * * * *') {
      // Process + tavily + knowledge — hourly at :00 UTC
      ctx.waitUntil(
        scheduledProcess(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] process error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 1 1 * *') {
      // Archive old entities — monthly 1st at 01:00 UTC
      ctx.waitUntil(
        scheduledArchiveOldEntities(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] archive error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 4 * * *') {
      // Feedback loop — daily at 04:00 UTC
      ctx.waitUntil(
        scheduledFeedback(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] feedback error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 0 * * *') {
      // AI budget daily reset — daily at 00:00 UTC (Phase 1 Neurons tracking)
      // clears AI_USAGE_KV usage/{YYYY-MM-DD} counter for fresh day budget accounting
      ctx.waitUntil(
        scheduledReset(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] reset error: ${e?.message || e}`);
        })
      );
    }
    // Unknown crons: no-op (ignore silently)
  },
};
