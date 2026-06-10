/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 */
import { Env } from './shared';
import { authRequest, corsHeaders } from './auth';
import { handlePullAction, handleDiagAction, handlePingAction, handleModelTestAction, handleAiTestAction, handleScoreAction, handleClassifyAction, handleBatchScoreAction, handleFissionAction, handleSaveAction, handleListAction, handleEmbedAction, handleZakerHotAction, handleProcessAction, handleHealthAction, handleLogsAction } from './endpoints';
import { logEvent, pruneOldLogs } from './log';

// ============================================================
// News Self Growth核心函数已抽到 src/news-process.ts ·T000（8 个函数：cleanupStaleTopics/findSimilarNews/updateTopicScore/recordTrendSnapshot/createTopic/insertNewsHotspot/joinTopicMember/saveToR2）
// ============================================================

// ============================================================
// 安全中间件（authRequest + corsHeaders 已抽到 src/auth.ts · T000）
// ============================================================

// ============================================================
//评分规则已抽到 src/score.ts ·T000（hashStr +3路由常量 + scoreRule）
// ============================================================
// Workers AI 响应解析
// 主 Worker
// ============================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const authError = authRequest(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';

// --------16 action dispatch (handlers 已抽到 src/endpoints.ts) --------
 if (action === 'pull') return await handlePullAction(request, env, url, cors);
 if (action === 'diag') return await handleDiagAction(request, env, url, cors);
 if (action === 'ping') return await handlePingAction(request, env, url, cors);
 if (action === 'model-test') return await handleModelTestAction(request, env, url, cors);
 if (action === 'ai-test') return await handleAiTestAction(request, env, url, cors);
 if (action === 'score') return await handleScoreAction(request, env, url, cors);
 if (action === 'classify') return await handleClassifyAction(request, env, url, cors);
 if (action === 'batch-score') return await handleBatchScoreAction(request, env, url, cors);
 if (action === 'fission') return await handleFissionAction(request, env, url, cors);
 if (action === 'save') return await handleSaveAction(request, env, url, cors);
 if (action === 'list') return await handleListAction(request, env, url, cors);
 if (action === 'embed') return await handleEmbedAction(request, env, url, cors);
 if (action === 'zaker-hot') return await handleZakerHotAction(request, env, url, cors);
 if (action === 'process') return await handleProcessAction(request, env, url, cors);
 if (action === 'health') return await handleHealthAction(request, env, url, cors);
 if (action === 'logs') return await handleLogsAction(request, env, url, cors);
 return new Response(JSON.stringify({ error: 'unknown action' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });  },

  // ====== Cron Trigger: 每小时整点(UTC) 跑 process action ======
  // 替代之前误用的 GitHub Actions (HTTP 403 + Cloudflare challenge)
  // 选 CF cron 原因:
  //   1. Free tier 实际可用(每账号 5 个, CPU 10ms 限制, process 主要是 fetch 等待不算 CPU)
  //   2. Worker → 自家域名走 CF 内部 routing, 绕开 Bot Fight Mode challenge
  //   3. 0 漂移(精准整点), 0 外部依赖, 0 GitHub 配额消耗
  //   4. Mac cron 也可以删了
  // 调试: wrangler dev --test-scheduled
  //       访问 wrangler dev 暴露的 scheduled handler 触发路由(详见 CF 文档)
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const start = Date.now();
    const ts = new Date().toISOString();
    const cron = controller?.cron || 'unknown';

    // 多个 cron 表达式分发 (wrangler.toml [triggers].crons 数组)
    // 当前 2 个: `0 * * * *` (hourly process) + `0 3 * * *` (daily prune, 北京 11:00)
    if (cron === "0 3 * * *") {
      // daily prune: 删 30d 前的 log (失败降级)
      console.log(`[cron] prune triggered at ${ts}`);
      logEvent(env, "info", "[cron] prune triggered", { cron, ts }, "scheduler");
      try {
        const result = await pruneOldLogs(env, 30);
        console.log(`[cron] prune done deleted=${result.deleted} errors=${result.errors}`);
        logEvent(env, "info", "[cron] prune done", { deleted: result.deleted, errors: result.errors, retention_days: 30 }, "scheduler");
      } catch (e: any) {
        console.error(`[cron] prune failed err=${e?.message || e}`);
        logEvent(env, "error", "[cron] prune failed", { err: e?.message || String(e) }, "scheduler");
      }
      return;
    }

    // 默认 = hourly process
    console.log(`[cron] process triggered at ${ts} cron=${cron}`);
    logEvent(env, "info", "[cron] process triggered", { cron, ts }, "scheduler");
    try {
      // fetch 自家 Worker —— 走 CF 内部 routing
      // User-Agent 用 curl/8.7.1 绕开 CF Bot Fight Mode (kzclaw 2026-06-10 确定)
      // 历史教训: 'csnews-cron-trigger/1.0' 这种机器 UA 会被 Bot Fight Mode 误判为 bot → fetch 403
      // 验证: diag 跑 Python urllib (HTTP 403 code 1010) vs curl (HTTP 200) vs Mozilla (HTTP 200)
      // URL 从 env 读取 (wrangler.toml [vars].WORKER_SELF_URL), 不硬编码
      const url = `${env.WORKER_SELF_URL}?action=process`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${env.BEARER_TOKEN}`,
          'User-Agent': 'curl/8.7.1',
        },
      });
      const body = await res.text();
      const elapsed = Date.now() - start;
      console.log(`[cron] process done status=${res.status} elapsed=${elapsed}ms body=${body.slice(0, 500)}`);
      logEvent(env, "info", "[cron] process done", { status: res.status, elapsed_ms: elapsed, body_preview: body.slice(0, 200) }, "scheduler");
    } catch (e: any) {
      const elapsed = Date.now() - start;
      console.error(`[cron] process failed elapsed=${elapsed}ms err=${e?.message || e}`);
      logEvent(env, "error", "[cron] process failed", { elapsed_ms: elapsed, err: e?.message || String(e) }, "scheduler");
    }
  },
};
