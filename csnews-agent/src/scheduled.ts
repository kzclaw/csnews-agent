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
import { runEntitySelfLearn } from './entity-selflearn';
import { runEntityProcess } from './entity-process';

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

/**
 * 每日 03:00 UTC cron 触发 entity 自学习 + 写 R2 finalized (v0.36.21)
 *
 * 流程:
 *   1. 写 [cron] entity triggered log
 *   2. inline 调 runEntitySelfLearn (n-gram + bge-m3 + noise filter)
 *   3. 写 [cron] entity selflearn done/error log
 *   4. inline 调 runEntityProcess (读 candidates + 写 entity-finalized.json)
 *   5. 写 [cron] entity process done/error log
 *
 * 失败处理:
 *   - selflearn 抛错 → log error + 仍尝试 process (process 0 Neurons)
 *   - process 抛错 → log error + 不阻塞
 *   - log 写失败 → catch 兜底
 *
 * 频率:每日 1 次 (bge-m3 embedding 重, Neurons ~5K/天 ≤ 10K Free 配额)
 * 跟 process 整点错开, 避免 Neurons spike 同时打
 */
export async function scheduledEntity(
  env: Env,
  ctx: ExecutionContext,
  controller: ScheduledController,
): Promise<void> {
  const start = Date.now();
  const ts = new Date().toISOString();
  const cron = controller?.cron || 'unknown';

  console.log(`[cron] entity triggered at ${ts} cron=${cron}`);
  ctx.waitUntil(logEvent(env, "info", "[cron] entity triggered", { cron, ts }, "scheduler").catch(() => {}));

  // Phase 1: selflearn (n-gram + bge-m3 + noise filter)
  const selfLearnStart = Date.now();
  let selfLearnResult: { candidates: any[]; total: number; embedded: number; noise_filtered: number; noise_anchors_count: number } = { candidates: [], total: 0, embedded: 0, noise_filtered: 0, noise_anchors_count: 0 };
  try {
    selfLearnResult = await runEntitySelfLearn(env);
    const selfLearnElapsed = Date.now() - selfLearnStart;
    console.log(`[cron] entity selflearn done total=${selfLearnResult.total} candidates=${selfLearnResult.candidates.length} noise_filtered=${selfLearnResult.noise_filtered} elapsed=${selfLearnElapsed}ms`);
    ctx.waitUntil(logEvent(env, "info", "[cron] entity selflearn done", {
      total: selfLearnResult.total,
      candidates: selfLearnResult.candidates.length,
      noise_filtered: selfLearnResult.noise_filtered,
      noise_anchors_count: selfLearnResult.noise_anchors_count,
      elapsed_ms: selfLearnElapsed,
    }, "scheduler").catch(() => {}));
  } catch (e: any) {
    const selfLearnElapsed = Date.now() - selfLearnStart;
    console.error(`[cron] entity selflearn failed elapsed=${selfLearnElapsed}ms err=${e?.message || e}`);
    ctx.waitUntil(logEvent(env, "error", "[cron] entity selflearn failed", { elapsed_ms: selfLearnElapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
    // selflearn 失败仍尝试 process (process 0 Neurons, 不浪费)
  }

  // Phase 2: process (读 candidates + 写 R2 entity-finalized.json)
  const processStart = Date.now();
  try {
    const processResult = await runEntityProcess(env);
    const processElapsed = Date.now() - processStart;
    console.log(`[cron] entity process done finalized=${processResult.finalized} written=${processResult.written} errors=${processResult.errors} elapsed=${processElapsed}ms`);
    ctx.waitUntil(logEvent(env, "info", "[cron] entity process done", {
      finalized: processResult.finalized,
      written: processResult.written,
      errors: processResult.errors,
      elapsed_ms: processElapsed,
    }, "scheduler").catch(() => {}));
  } catch (e: any) {
    const processElapsed = Date.now() - processStart;
    console.error(`[cron] entity process failed elapsed=${processElapsed}ms err=${e?.message || e}`);
    ctx.waitUntil(logEvent(env, "error", "[cron] entity process failed", { elapsed_ms: processElapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
  }

  const totalElapsed = Date.now() - start;
  console.log(`[cron] entity done total_elapsed=${totalElapsed}ms`);
}
