/**
 * CSNEWS Agent · 主 Worker (v0.36.10 · KR0 · Foundation 0 第 1 步)
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * KR0 拆 index.ts 后:
 *   - 20 action handler 已抽到 src/endpoints.ts (v0.33+sweep) · v0.36.20 再拆 4 子文件
 *   - 调度逻辑已抽到 src/dispatch.ts (v0.36.10 KR0)
 *   - cron handler 已抽到 src/scheduled.ts (v0.36.10 KR0)
 *   - 鉴权 + CORS 已抽到 src/auth.ts (v0.33+sweep T000)
 *   - News Self Growth 8 核心函数已抽到 src/news-process.ts (v0.33+sweep T000)
 *   - 评分规则已抽到 src/score.ts (v0.33+sweep T000)
 *
 * 主 Worker 剩: 鉴权 (authRequest) + 2 行 dispatch (fetch + scheduled)
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 *
 * 详见：tasks/csnews-agent-okr.md KR0
 */
import { Env } from './shared';
import { authRequest } from './auth';
import { handleCorsPreflight, dispatchAction } from './dispatch';
import { scheduledProcess } from './scheduled';

export default {
  // ====== HTTP fetch handler (v0.33 确定主入口) ======
  // 流程: CORS preflight → auth (Bearer Token) → 20 action dispatch
  // 所有 handler 已抽到 src/endpoints.ts, 调度逻辑已抽到 src/dispatch.ts
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsPreflight = handleCorsPreflight(request);
    if (corsPreflight) return corsPreflight;

    const authError = authRequest(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';
    return await dispatchAction(env, ctx, action, request);
  },

  // ====== Cron Trigger: 每小时整点(UTC) 跑 process action + runKnowledgeAccumulation =====
  // v0.36.5 mini (KR0): inline 调 handleProcessAction, **不** fetch 自家 URL
  // v0.36.7 (KR0): process 跑完 inline 调 runKnowledgeAccumulation 累积 job
  // v0.36.10 (KR0): scheduled 整段抽到 src/scheduled.ts
  // 选 CF cron 原因 (不变):
  //   1. Free tier 实际可用(每账号 5 个, CPU 10ms 限制, process 主要是 fetch 等待不算 CPU)
  //   2. 0 漂移(精准整点), 0 外部依赖, 0 GitHub 配额消耗
  // 调试: wrangler dev --test-scheduled
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledProcess(env, ctx, controller);
  },
};
