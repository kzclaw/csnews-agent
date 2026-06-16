/**
 * CSNEWS Agent · Cron Trigger Handler (v0.36.10 · KR0 · Foundation 0 第 1 步)
 *
 * 唯一目标：守住"scheduled handler 整点 cron 行为就是这样"（业务契约）
 *
 * v0.33 确定 Foundation 0 第 1 步: index.ts 拆模块化
 *   - scheduled handler 整段抽到本文件
 *
 * 业务红线:
 *   - v0.36.5 mini (KR0): inline 调 handleProcessAction, **不** fetch selfUrl
 *     (历史教训: v0.34-v0.36.4 fetch(selfUrl) 走 CF 内部 routing 9 整点全 522)
 *   - v0.36.7 (KR0): process 跑完 inline 调 runKnowledgeAccumulation
 *     ("快赢"哲学: 0 DDL · 全 R2 · 失败不阻塞 process 200)
 *   - 所有 log 用 ctx.waitUntil 异步持久化 (fire-and-forget, R2 失败不阻塞)
 *   - scheduler log 失败不阻塞 process (v0.36.5 mini 确定 try/catch 兜底)
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */

import { Env } from './shared';
import { logEvent } from './log';
import { handleProcessAction, runKnowledgeAccumulation } from './endpoints';

/**
 * 整点 cron 触发后的完整流程
 *
 * 流程:
 *   1. 写 [cron] process triggered log
 *   2. inline 调 handleProcessAction (v0.36.5 mini 修, 不 fetch selfUrl)
 *   3. 写 [cron] process done/error log
 *   4. inline 调 runKnowledgeAccumulation (v0.36.7 KR0 加)
 *   5. 写 [cron] knowledge accumulation done/error log
 *
 * 失败处理:
 *   - process 抛错 → log error + 不阻塞 (v0.36.5 mini 确定)
 *   - knowledge 抛错 → log error + 不阻塞 (process 200 仍返回)
 *   - log 写失败 → catch 兜底 (v0.33+sweep 确定)
 */
export async function scheduledProcess(
  env: Env,
  ctx: ExecutionContext,
  controller: ScheduledController,
): Promise<void> {
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

    // v0.36.7 (KR0): process 跑完 inline 调 runKnowledgeAccumulation 累积 job
    // "快赢"哲学: 0 Supabase DDL · 全 R2 持久化 · 0 5h 配额期打扰
    // 跟 process 走同 ctx.waitUntil, 累积失败不阻塞 process 200 (早晨日报金句是 nice-to-have, 失败可次日累积)
    const knowledgeStart = Date.now();
    try {
      const knowledgeRes = await runKnowledgeAccumulation(env, ctx);
      const knowledgeElapsed = Date.now() - knowledgeStart;
      console.log(`[cron] knowledge accumulation done written=${knowledgeRes.written} errors=${knowledgeRes.errors} elapsed=${knowledgeElapsed}ms`);
      ctx.waitUntil(logEvent(env, "info", "[cron] knowledge accumulation done", { written: knowledgeRes.written, errors: knowledgeRes.errors, elapsed_ms: knowledgeElapsed }, "scheduler").catch(() => {}));
    } catch (e: any) {
      const knowledgeElapsed = Date.now() - knowledgeStart;
      console.error(`[cron] knowledge accumulation failed elapsed=${knowledgeElapsed}ms err=${e?.message || e}`);
      ctx.waitUntil(logEvent(env, "error", "[cron] knowledge accumulation failed", { elapsed_ms: knowledgeElapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
    }
  } catch (e: any) {
    const elapsed = Date.now() - start;
    console.error(`[cron] process failed elapsed=${elapsed}ms err=${e?.message || e}`);
    ctx.waitUntil(logEvent(env, "error", "[cron] process failed", { elapsed_ms: elapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
  }
}
