/**
 * CSNEWS Agent · AI 降级策略 (Phase 3)
 *
 * 当 AI 预算超阈值时，实现优雅降级:
 * - 写 R2 占位文档 (ai-degraded/{date}/{id}.md)
 * - 标记 Supabase degraded=true
 *
 * Phase 1: AI 预算追踪 (ai-budget.ts)
 * Phase 2: 预算检查 hook (shouldTriggerAiCall)
 * Phase 3: 降级策略 (本文件) ← 当前
 */
import type { Env } from './shared';
import { supabaseFetch } from './shared';
import { getDailyUsage } from './ai-budget';

// ============================================================
// Types
// ============================================================

export type DegradationLevel = 'warning' | 'critical' | 'shutdown';

export interface DegradedInsight {
  triggered_at: string;  // ISO 8601
  level: DegradationLevel;
  neurons_used: number;
  reason: string;
  topic_title?: string;
  record_id: string;
}

// ============================================================
// Phase 3 core functions
// ============================================================

/**
 * 返回降级提示文案 (Phase 3 核心函数)
 *
 * @param level - 预算超限档位 (warning | critical | shutdown)
 * @returns 用户可见的降级说明文案
 *
 * 各档位说明:
 *   warning:   Neurons 用量 > 5K，AI 响应可能延迟
 *   critical:   Neurons 用量 > 7K，AI 响应降级
 *   shutdown:   Neurons 用量 > 8K，AI 功能暂停
 */
export function getDegradationMessage(level: string): string {
  const messages: Record<string, string> = {
    warning:
      'AI 预算接近上限，当前 AI 响应可能延迟。建议稍后再试或简化查询。',
    critical:
      'AI 预算已达临界值，部分 AI 功能已降级响应。内容基础处理仍在进行。',
    shutdown:
      'AI 预算已耗尽，今日 AI 功能暂时不可用。基础数据处理正常运行，明日恢复。',
  };
  return messages[level] ?? 'AI 预算超额，功能暂时降级。';
}

/**
 * 写 R2 占位文档 (Phase 3 核心函数)
 *
 * R2 路径: ai-degraded/{YYYY-MM-DD}/{record_id}.md
 *
 * @param env         - Worker Env (含 csnews_raw R2 binding + AI_USAGE_KV)
 * @param warning_id  - 记录 ID (作为文件名和内容标识)
 * @param level       - 降级档位 (warning | critical | shutdown)
 * @param topic_title - 可选，topic 标题
 * @returns void (写入失败静默，不阻断主流程)
 *
 * 占位文档内容包含:
 *   - 触发时间 (UTC)
 *   - 当前 Neurons 用量
 *   - 降级原因
 *   - topic 标题 (如有)
 */
export async function writeDegradedInsight(
  env: Env,
  warning_id: string,
  level: string,
  topic_title?: string
): Promise<void> {
  if (!env.csnews_raw) {
    console.warn('[degradation] csnews_raw binding missing, skip R2 write');
    return;
  }

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const neurons_used = await getDailyUsage(env);

  const insight: DegradedInsight = {
    triggered_at: now.toISOString(),
    level: level as DegradationLevel,
    neurons_used,
    reason: getDegradationMessage(level),
    topic_title,
    record_id: warning_id,
  };

  const markdown = [
    '# AI 降级占位文档',
    '',
    `> **⚠️ 此文档为 AI 降级占位，非完整洞察**`,
    '',
    `| 字段 | 值 |`,
    `|---|---|`,
    `| triggered_at | ${insight.triggered_at} |`,
    `| level | ${insight.level} |`,
    `| neurons_used | ${insight.neurons_used} |`,
    `| reason | ${insight.reason} |`,
    topic_title ? `| topic_title | ${topic_title} |` : null,
    `| record_id | ${insight.record_id} |`,
    '',
    '---',
    '',
    '*此占位文档由 CSNEWS Agent AI 预算降级系统自动生成*',
  ]
    .filter(Boolean)
    .join('\n');

  const r2Key = `ai-degraded/${dateStr}/${warning_id}.md`;

  try {
    await env.csnews_raw.put(r2Key, markdown, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    });
    console.log(`[degradation] wrote R2 placeholder: ${r2Key}`);
  } catch (err) {
    // R2 写入失败静默，不阻断主流程
    console.error(`[degradation] R2 write failed for ${r2Key}:`, err);
  }
}

/**
 * 标记 Supabase 记录为 degraded (Phase 3 核心函数)
 *
 * @param env      - Worker Env (含 SUPABASE_URL + SUPABASE_SERVICE_KEY)
 * @param record_id - 目标记录 UUID
 * @param table    - 目标表名 (warnings | fission_searches | knowledge)
 * @returns void (更新失败静默，不阻断主流程)
 *
 * 注意: 使用 service_role key 以绕过 RLS 限制。
 */
export async function markAsDegraded(
  env: Env,
  record_id: string,
  table: 'warnings' | 'fission_searches' | 'knowledge'
): Promise<void> {
  const allowedTables = ['warnings', 'fission_searches', 'knowledge'];
  if (!allowedTables.includes(table)) {
    console.warn(`[degradation] markAsDegraded: unknown table "${table}"`);
    return;
  }

  try {
    const res = await supabaseFetch(env, `/rest/v1/${table}?id=eq.${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ degraded: true }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[degradation] PATCH failed for ${table} id=${record_id}: ${errText}`);
      return;
    }

    console.log(`[degradation] marked ${table} id=${record_id} as degraded`);
  } catch (err) {
    console.error(`[degradation] markAsDegraded failed:`, err);
  }
}
