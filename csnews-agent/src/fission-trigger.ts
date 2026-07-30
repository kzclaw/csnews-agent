/**
 * CSNEWS Agent · Fission 触发器 (v0.37.36 Service Bindings)
 *
 * v0.37.36 拍板:
 *   - 触发 时机: 主 worker 跑完 process 后 立即 触发 (不 等 整点)
 *   - 同步 方式: 主 worker 等 fission 跑完 再 返回 (确保 fission 成功)
 *   - 失败 处理: fission 失败 不 报错,  log 记录,  6h cron 兜底
 *
 * CF Free Plan cron 限制 5/账号 已 满:
 *   - csnews-agent 4 + csnews-fission 1 = 5
 *   - 不能 加 cron (要触发 立即 fission,  必走 Service Bindings)
 *   - Service Bindings 不 占 cron quota (account-level 资源)
 *
 * 类型 Env.FISSION 是 CSnewsAgentService 范式 类型绑定 (env.FISSION.fetch)
 */
import { Env } from './shared';
import { logEvent } from './log';

export interface FissionTriggerResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * 触发 fission (Service Bindings sync · 主 worker 等 fission 跑完 返)
 *
 * 失败 处理 (决策 2): try/catch + logEvent + 不 propagate · 6h cron 兜底
 *
 * @param env Cloudflare Workers env (含 FISSION Service Binding)
 * @param seedTopics 需要 fission 的 topic 列表 (titles / keys) · 多条 用 | 分隔
 * @param reason 触发 原因 (e.g. 'post-process-immediate', 'manual', 'fallback')
 */
export async function triggerFission(
  env: Env,
  seedTopics: string[],
  reason: string,
  topicIds?: string[]
): Promise<FissionTriggerResult> {
  if (seedTopics.length === 0) {
    return { ok: false, skipped: true, reason: 'no seed topics' };
  }

  const seed = seedTopics.join(' | ');
  // v0.37.79 fix: 传 topic_ids 参数 (csnews-fission fission-manual 用其直接查 topic, 不再依赖 score=eq.9)
  const topicIdsParam = topicIds && topicIds.length > 0 ? `&topic_ids=${encodeURIComponent(topicIds.join(','))}` : '';
  const url = `https://fission.local/?action=fission-manual&seed=${encodeURIComponent(seed)}&reason=${encodeURIComponent(reason)}${topicIdsParam}`;
  const request = new Request(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.BEARER_TOKEN}`,
      'X-Fission-Source': 'csnews-agent',
      'X-Fission-Reason': reason,
    },
  });

  try {
    // v0.37.80 fix: Service Binding fetch 需显式加 auth header
    if (!('FISSION' in env) || !(env as any).FISSION) {
      await logEvent(env, 'warn', '[fission-trigger] FISSION binding not available, skipping', undefined, 'trigger');
      return { ok: false, skipped: true, reason: 'FISSION binding not configured' };
    }
    const start = Date.now();
    const resp = await (env as any).FISSION.fetch(request);
    const elapsed = Date.now() - start;
    const body = await resp.text();

    if (!resp.ok) {
      await logEvent(
        env,
        'error',
        `[fission-trigger] HTTP ${resp.status} for ${seedTopics.length} topics in ${elapsed}ms (reason=${reason}): ${body.slice(0, 200)}`,
        undefined,
        'trigger'
      );
      return { ok: false, status: resp.status, body, error: `fission HTTP ${resp.status}` };
    }

    await logEvent(
      env,
      'info',
      `[fission-trigger] HTTP ${resp.status} OK for ${seedTopics.length} topics in ${elapsed}ms (reason=${reason})`,
      undefined,
      'trigger'
    );
    return { ok: true, status: resp.status, body };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 决策 2: 失败 fallback → 6h cron 兜底 (不 propagate error to user)
    await logEvent(
      env,
      'error',
      `[fission-trigger] throw for ${seedTopics.length} topics (reason=${reason}): ${msg}. 6h cron fallback will retry.`,
      undefined,
      'trigger'
    );
    return { ok: false, error: msg };
  }
}

/**
 * 简化 wrapper: 从 topic 列表 提取 name/title 数组
 */
export async function triggerFissionFromTopics(
  env: Env,
  topics: Array<{ name?: string; title?: string; topic_key?: string; topic_id?: string }>,
  reason: string
): Promise<FissionTriggerResult> {
  const seeds = topics
    .map((t) => t.name || t.title || t.topic_key || '')
    .filter((s) => s.length > 0);
  const topicIds = topics
    .map((t) => t.topic_id || '')
    .filter((id) => id.length > 0);
  return triggerFission(env, seeds, reason, topicIds);
}
