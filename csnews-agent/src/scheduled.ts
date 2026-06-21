/**
 * CSNEWS Agent · Cron Trigger Handler
 *
 * 唯一目标：守住"scheduled handler 整点 cron 行为就是这样"（业务契约）
 *
 * 拆模块化: scheduled handler 整段抽到本文件
 *
 * 业务红线:
 *   - v0.36.5 mini: inline 调 handleProcessAction, **不** fetch selfUrl
 *     (历史教训: v0.34-v0.36.4 fetch(selfUrl) 走 CF 内部 routing 9 整点全 522)
 *   - v0.36.7: process 跑完 inline 调 runKnowledgeAccumulation
 *     ("快赢"哲学: 0 DDL · 全 R2 · 失败不阻塞 process 200)
 *   - 所有 log 用 ctx.waitUntil 异步持久化 (fire-and-forget, R2 失败不阻塞)
 *   - scheduler log 失败不阻塞 process (v0.36.5 mini 确定 try/catch 兜底)
 *

 */

import { Env, getSupabaseHost } from './shared';
import { supabaseHeaders } from './utils';
import { logEvent } from './log';
import { handleProcessAction, runKnowledgeAccumulation } from './endpoints';
import { runEntitySelfLearn } from './entity-selflearn';
import { runEntityProcess } from './entity-process';
import { runEventProcess } from './event-process';

/**
 * 整点 cron 触发后的完整流程
 *
 * 流程:
 *   1. 写 [cron] process triggered log
 *   2. inline 调 handleProcessAction (v0.36.5 mini 修, 不 fetch selfUrl)
 *   3. 写 [cron] process done/error log
 *   4. inline 调 runKnowledgeAccumulation (v0.36.7 加)
 *   5. 写 [cron] knowledge accumulation done/error log
 *
 * 失败处理:
 *   - process 抛错 → log error + 不阻塞 (v0.36.5 mini 确定)
 *   - knowledge 抛错 → log error + 不阻塞 (process 200 仍返回)
 *   - log 写失败 → catch 兜底
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

    // v0.36.7: process 跑完 inline 调 runKnowledgeAccumulation 累积 job
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

/**
 * 每日 03:30 UTC cron 触发 event 聚类 + 写 R2 event-clusters.json (v0.36.21)
 *
 * 流程:
 *   1. 写 [cron] event triggered log
 *   2. inline 调 runEventProcess (读 entity-finalized.json + Jaccard 聚类 + 写 event-clusters.json)
 *   3. 写 [cron] event process done/error log
 *
 * 失败处理:
 *   - process 抛错 → log error + 不阻塞
 *   - log 写失败 → catch 兜底
 *
 * 频率:每日 1 次 (依赖 entity finalized 必须 entity 跑完, 错开 entity 30min)
 * 0 Neurons (Jaccard 是数学运算, 不调 AI)
 */
export async function scheduledEvent(
  env: Env,
  ctx: ExecutionContext,
  controller: ScheduledController,
): Promise<void> {
  const start = Date.now();
  const ts = new Date().toISOString();
  const cron = controller?.cron || 'unknown';

  console.log(`[cron] event triggered at ${ts} cron=${cron}`);
  ctx.waitUntil(logEvent(env, "info", "[cron] event triggered", { cron, ts }, "scheduler").catch(() => {}));

  try {
    // 读 entity-finalized.json (依赖 entity cron 03:00 已跑完)
    // Jaccard 聚类 + 写 R2 event-clusters.json + event-clusters-index.json
    const result = await runEventProcess(env);
    const elapsed = Date.now() - start;
    console.log(`[cron] event process done clusters=${result.clusters} threshold=${result.threshold} written=${result.written} errors=${result.errors} elapsed=${elapsed}ms`);
    ctx.waitUntil(logEvent(env, "info", "[cron] event process done", {
      clusters: result.clusters,
      threshold: result.threshold,
      written: result.written,
      errors: result.errors,
      elapsed_ms: elapsed,
    }, "scheduler").catch(() => {}));
  } catch (e: any) {
    const elapsed = Date.now() - start;
    console.error(`[cron] event process failed elapsed=${elapsed}ms err=${e?.message || e}`);
    ctx.waitUntil(logEvent(env, "error", "[cron] event process failed", { elapsed_ms: elapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
  }
}

/**
 * 每月 1 号 0:00 UTC cron 触发 entity 热层归档 (方案 D · v0.36.21)
 *
 * 流程:
 *   1. 写 [cron] archive triggered log
 *   2. 查 Supabase entity_hot 30d+ 老 entity (active + reviewed 分类)
 *   3. active 30d+ → R2 entity-archive-YYYY-MM.json (合并到本月 archive)
 *   4. reviewed 30d+ → R2 entity-reviewed-YYYY.json (合并到本月 reviewed, 永久保留)
 *   5. Supabase DELETE (所有 30d+ 都删, 已经在 R2 兜底)
 *   6. 写 [cron] archive done/error log
 *
 * 失败处理:
 *   - Supabase SELECT 失败 → log error + 不删
 *   - R2 archive 写失败 → log error + 不删
 *   - Supabase DELETE 失败 → log error + 0 数据丢失 (下次 cron 重试)
 *
 * 频率: 每月 1 次 (数据量稳态 150-300 行, 1 个月归档一次够)
 * 0 Neurons (纯 SQL + R2 操作)
 */
export async function scheduledArchiveOldEntities(
  env: Env,
  ctx: ExecutionContext,
  controller: ScheduledController,
): Promise<void> {
  const start = Date.now();
  const ts = new Date().toISOString();
  const cron = controller?.cron || 'unknown';

  console.log(`[cron] archive triggered at ${ts} cron=${cron}`);
  ctx.waitUntil(logEvent(env, "info", "[cron] archive triggered", { cron, ts }, "scheduler").catch(() => {}));

  try {
    // Step 1: 查 30d+ entity_hot (cutoff = now - 30 days)
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const selectRes = await fetch(
      `${getSupabaseHost(env)}/rest/v1/entity_hot?created_at=lt.${cutoff}&limit=1000`,
      {
        headers: supabaseHeaders(env),
      },
    );
    if (!selectRes.ok) {
      const errText = await selectRes.text();
      throw new Error(`SELECT failed HTTP ${selectRes.status}: ${errText.slice(0, 200)}`);
    }
    const oldEntities = (await selectRes.json()) as Array<{
      id: string;
      name: string;
      type: string;
      status: string;
      // ... 其他字段
    }>;

    if (oldEntities.length === 0) {
      const elapsed = Date.now() - start;
      console.log(`[cron] archive done no_old_entities elapsed=${elapsed}ms`);
      ctx.waitUntil(logEvent(env, "info", "[cron] archive done", { active: 0, reviewed: 0, deleted: 0, elapsed_ms: elapsed }, "scheduler").catch(() => {}));
      return;
    }

    // Step 2: 分类 active vs reviewed
    const active = oldEntities.filter((e) => e.status === 'active');
    const reviewed = oldEntities.filter((e) => e.status === 'reviewed');
    const yyyymm = new Date().toISOString().slice(0, 7);

    // Step 3: active → R2 entity-archive-YYYY-MM.json (合并到本月 archive)
    if (active.length > 0) {
      const archiveKey = `entity-archive-${yyyymm}.json`;
      let archiveData: { generated_at: string; entities: any[] } = { generated_at: ts, entities: [] };
      try {
        const existing = await env.csnews_raw.get(archiveKey);
        if (existing) {
          const parsed = await existing.json<{ generated_at: string; entities: any[] }>();
          if (Array.isArray(parsed.entities)) archiveData = parsed;
        }
      } catch {
        // R2 读失败用空 archive (不影响, 本次 active 仍写)
      }
      archiveData.entities = [...(archiveData.entities || []), ...active];
      archiveData.generated_at = ts;
      await env.csnews_raw.put(archiveKey, JSON.stringify(archiveData, null, 2));
      console.log(`[cron] archive wrote ${active.length} active to ${archiveKey}`);
    }

    // Step 4: reviewed → R2 entity-reviewed-YYYY.json (合并到本月 reviewed, 永久保留)
    if (reviewed.length > 0) {
      const reviewedKey = `entity-reviewed-${yyyymm}.json`;
      let reviewedData: { generated_at: string; entities: any[] } = { generated_at: ts, entities: [] };
      try {
        const existing = await env.csnews_raw.get(reviewedKey);
        if (existing) {
          const parsed = await existing.json<{ generated_at: string; entities: any[] }>();
          if (Array.isArray(parsed.entities)) reviewedData = parsed;
        }
      } catch {
        // 同上
      }
      reviewedData.entities = [...(reviewedData.entities || []), ...reviewed];
      reviewedData.generated_at = ts;
      await env.csnews_raw.put(reviewedKey, JSON.stringify(reviewedData, null, 2));
      console.log(`[cron] archive wrote ${reviewed.length} reviewed to ${reviewedKey}`);
    }

    // Step 5: Supabase DELETE (分批删除, 每次最多 500 条, 已经在 R2 兜底)
    const ids = oldEntities.map((e) => e.id);
    const BATCH_SIZE = 500;
    let totalDeleted = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const deleteRes = await fetch(
        `${getSupabaseHost(env)}/rest/v1/entity_hot?id=in.(${batch.join(',')})&limit=${BATCH_SIZE}`,
        {
          method: 'DELETE',
          headers: supabaseHeaders(env),
        },
      );
      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        throw new Error(`DELETE failed HTTP ${deleteRes.status}: ${errText.slice(0, 200)}`);
      }
      const deletedCount = parseInt(deleteRes.headers.get('content-length') || '0', 10);
      totalDeleted += deletedCount > 0 ? deletedCount : batch.length;
    }

    const elapsed = Date.now() - start;
    console.log(`[cron] archive done active=${active.length} reviewed=${reviewed.length} deleted=${totalDeleted} elapsed=${elapsed}ms`);
    ctx.waitUntil(logEvent(env, "info", "[cron] archive done", {
      active: active.length,
      reviewed: reviewed.length,
      deleted: totalDeleted,
      elapsed_ms: elapsed,
    }, "scheduler").catch(() => {}));
  } catch (e: any) {
    const elapsed = Date.now() - start;
    console.error(`[cron] archive failed elapsed=${elapsed}ms err=${e?.message || e}`);
    ctx.waitUntil(logEvent(env, "error", "[cron] archive failed", { elapsed_ms: elapsed, err: e?.message || String(e) }, "scheduler").catch(() => {}));
  }
}
