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
import { handlePullAction, handleDiagAction, handlePingAction, handleModelTestAction, handleAiTestAction, handleScoreAction, handleClassifyAction, handleBatchScoreAction, handleFissionAction, handleSaveAction, handleListAction, handleEmbedAction, handleZakerHotAction, handleProcessAction, handleHealthAction, handleLogsAction, handleContentAction, handleTrendAction } from './endpoints';
import { logEvent } from './log';

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const authError = authRequest(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';

    // 写一条 endpoint-level log (fire-and-forget with ctx.waitUntil so R2 put completes)
    ctx.waitUntil(logEvent(env, "info", "endpoint called", { endpoint: action, method: request.method }, "dispatcher").catch(() => {}));

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
  if (action === 'process') return await handleProcessAction(request, env, url, cors, ctx);
  if (action === 'health') return await handleHealthAction(request, env, url, cors);
  if (action === 'logs') return await handleLogsAction(request, env, url, cors);
  if (action === 'content') return await handleContentAction(request, env, url, cors, ctx);
  if (action === 'trend') return await handleTrendAction(request, env, url, cors, ctx);
  return new Response(JSON.stringify({ error: 'unknown action' }), {
 status:400, headers: { 'Content-Type': 'application/json', ...cors }
 });  },

  // ====== Cron Trigger: 每小时整点(UTC) 跑 process action ======
  // v0.36.5 mini (KR0 · kzclaw 2026-06-14 01:17 确定):
  //   直接 inline 调 handleProcessAction, **不** fetch 自家 URL
  //   历史教训: v0.34-v0.36.4 四次修复全用 fetch(selfUrl) 走 CF 内部 routing
  //     → 9 个整点 cron 全 522 (error code: 522) + dispatcher log 0 记录 = fetch 没到 fetch handler
  //   v0.36.5 mini 拿掉 fetch, 直接函数调用, 0 网络层, 0 522 风险
  //   5 重安全网 (kzclaw 4 步铁律 + 第 5 重实测):
  //     1. tsc 0 error
  //     2. vitest 142 passed
  //     3. wrangler dry-run
  //     4. push origin main + CF auto-deploy OK
  //     5. **下个整点 cron + curl health 端点 last_process_at 更新到 cron 触发时间 + scheduler log status=200** (必做实测)
  // 选 CF cron 原因 (不变):
  //   1. Free tier 实际可用(每账号 5 个, CPU 10ms 限制, process 主要是 fetch 等待不算 CPU)
  //   2. 0 漂移(精准整点), 0 外部依赖, 0 GitHub 配额消耗
  // 调试: wrangler dev --test-scheduled
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const start = Date.now();
    const ts = new Date().toISOString();
    const cron = controller?.cron || 'unknown';
    console.log(`[cron] process triggered at ${ts} cron=${cron}`);
    ctx.waitUntil(logEvent(env, "info", "[cron] process triggered", { cron, ts }, "scheduler").catch(() => {}));
    try {
      // v0.36.5 mini: inline 调 handleProcessAction 函数
      // - 不 fetch selfUrl (之前 9 个整点 cron 522 的根因)
      // - 不需要 CORS 头 (cron 不发浏览器请求)
      // - Request + URL 用 dummy, 实际不被 process 逻辑用
      const dummyUrl = new URL("https://example.com/?action=process");
      const dummyRequest = new Request(dummyUrl.toString(), { method: "GET" });
      const res = await handleProcessAction(dummyRequest, env, dummyUrl, {}, ctx);
      const body = await res.text();
      const elapsed = Date.now() - start;
      const ok = res.status === 200;
      console.log(`[cron] process done status=${res.status} elapsed=${elapsed}ms body=${body.slice(0, 500)}`);
      ctx.waitUntil(logEvent(env, ok ? "info" : "error", "[cron] process done", { status: res.status, elapsed_ms: elapsed, body_preview: body.slice(0, 200) }, "scheduler").catch(() => {}));
    } catch (e: any) {
      const elapsed = Date.now() - start;
      console.error(`[cron] process failed elapsed=${elapsed}ms err=${e?.message || e}`);
      ctx.waitUntil(logEvent(env, "error", "[cron] process failed", { elapsed_ms: elapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
    }
  },
};
