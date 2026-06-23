/**
 * CSNEWS Fission Worker · 裂变触发器
 *
 * 职责：定时扫描 explosive stage + score=9 的 topic，触发裂变流程
 *
 * 裂变触发条件（SPEC.md Section 1.2）：
 *   - topic score = 9（第三次达到升级阈值）
 *   - topic stage = 'explosive'
 *
 * 触发后：
 *   - score 重置为 0，stage 保持 explosive
 *   - 生成裂变报告（搜索词生成 → 并行搜索 → 合并 → 报告写入 R2）
 *   - topics 表更新 fission_count / fission_triggered_at
 *
 * Phase 1：骨架搭建（本文件），核心逻辑 placeholder
 */
import { Env, getSupabaseHost } from './shared';
import { supabaseHeaders } from './utils';

export interface FissionTopic {
  id: string;
  title: string;
  stage: string;
  score: number;
  fission_count: number;
  fission_triggered_at: string | null;
}

export interface FissionResult {
  topic_id: string;
  queries: string[];
  report_content: string;
  r2_key: string;
  fission_type: string;
  status: 'completed' | 'failed';
  triggered_at: string;
}

/**
 * 查询满足裂变条件的 topic
 * 条件：score = 9 AND stage = 'explosive'
 */
export async function findFissionTopics(env: Env): Promise<FissionTopic[]> {
  const supabaseUrl = getSupabaseHost(env);
  const sql = `
    SELECT id, title, stage, score,
           COALESCE(fission_count, 0) as fission_count,
           fission_triggered_at
    FROM topics
    WHERE score = 9
      AND stage = 'explosive'
    LIMIT 10
  `;

  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    console.error('[fission] findFissionTopics failed:', await res.text());
    return [];
  }

  const data = await res.json();
  return data.result || [];
}

/**
 * 重置 topic 的 score 为 0（裂变触发后）
 */
export async function resetTopicScore(env: Env, topicId: string): Promise<void> {
  const supabaseUrl = getSupabaseHost(env);
  const now = new Date().toISOString();

  const res = await fetch(`${supabaseUrl}/rest/v1/topics?id=eq.${topicId}`, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      score: 0,
      fission_triggered_at: now,
      fission_count: 1, // 后续应改成 +1，需先查当前值
    }),
  });

  if (!res.ok) {
    console.error('[fission] resetTopicScore failed for topic:', topicId, await res.text());
  }
}

/**
 * 记录裂变报告到 Supabase（fission_reports 表）
 */
export async function recordFissionReport(
  env: Env,
  result: FissionResult
): Promise<void> {
  const supabaseUrl = getSupabaseHost(env);

  const res = await fetch(`${supabaseUrl}/rest/v1/fission_reports`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(env.SUPABASE_SERVICE_KEY),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      topic_id: result.topic_id,
      queries: result.queries,
      report_content: result.report_content,
      r2_key: result.r2_key,
      fission_type: result.fission_type,
      status: result.status,
      triggered_at: result.triggered_at,
      completed_at: result.status === 'completed' ? new Date().toISOString() : null,
    }),
  });

  if (!res.ok) {
    console.error('[fission] recordFissionReport failed:', await res.text());
  }
}

/**
 * 执行单个 topic 的裂变流程
 * Phase 1：骨架 + placeholder 逻辑，后续补完搜索和报告生成
 */
export async function runFissionForTopic(
  env: Env,
  topic: FissionTopic
): Promise<void> {
  console.log(`[fission] processing topic=${topic.id} title="${topic.title}"`);

  try {
    // TODO Phase 2：LLM 生成 5 个搜索词
    const queries: string[] = [];
    // const queries = await generateSearchQueries(env, topic.title);

    // TODO Phase 2：并行搜索（ZAKER + Tavily）

    // TODO Phase 2：合并结果 + 向量查重

    // TODO Phase 2：LLM 生成报告正文

    const reportContent = `# 裂变报告 placeholder\n\nTopic: ${topic.title}\nFission count: ${topic.fission_count + 1}\n\n[Phase 2: 完整报告生成逻辑待实现]`;

    const now = new Date().toISOString();
    const r2Key = `fission/${now.slice(0, 7)}/${topic.id}/${now}.json`;

    // 写报告到 R2
    const reportJson = JSON.stringify({
      topic_id: topic.id,
      topic_title: topic.title,
      queries,
      report_content: reportContent,
      triggered_at: now,
      fission_type: 'expansion',
    }, null, 2);

    await env.csnews_raw.put(r2Key, reportContent, {
      httpMetadata: { contentType: 'text/markdown' },
    });

    // 记录到 Supabase
    await recordFissionReport(env, {
      topic_id: topic.id,
      queries,
      report_content: reportContent,
      r2_key: r2Key,
      fission_type: 'expansion',
      status: 'completed',
      triggered_at: now,
    });

    // 重置 topic score
    await resetTopicScore(env, topic.id);

    console.log(`[fission] done topic=${topic.id} r2_key=${r2Key}`);
  } catch (err) {
    console.error(`[fission] error for topic=${topic.id}:`, err);
    // 失败时仍记录一条 failed 记录
    await recordFissionReport(env, {
      topic_id: topic.id,
      queries: [],
      report_content: `Fission failed: ${String(err)}`,
      r2_key: '',
      fission_type: 'expansion',
      status: 'failed',
      triggered_at: new Date().toISOString(),
    });
  }
}

/**
 * 主入口：扫描所有满足条件的 topic 并执行裂变
 */
export async function runFissionTrigger(env: Env): Promise<void> {
  console.log('[fission] scanning for explosive topics with score=9...');

  const topics = await findFissionTopics(env);

  if (topics.length === 0) {
    console.log('[fission] no topics match fission criteria, skipping');
    return;
  }

  console.log(`[fission] found ${topics.length} topics to fission`);

  for (const topic of topics) {
    await runFissionForTopic(env, topic);
  }
}
