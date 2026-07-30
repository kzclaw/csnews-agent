/**
 * AI 预算降级策略 (Phase 3)
 *
 * 当 AI 调用因 Neurons 预算超限被 shouldTriggerAiCall 阻断时：
 *   - L4 warning: 标记 degraded=true + 写 R2 占位（manual review 队列）
 *   - L5 fission: 跳过 LLM + 写 R2 占位（bge-m3 相似替代业务下游）
 *   - L6 knowledge: 写空 insight + degraded=true（明天 retry）
 *
 * 集成点：
 *   - L4: news-process.ts 创建 warning 时（当前 budget 已超限则标记）
 *   - L5: endpoints-core.ts handleFissionAction (L5 hook 拦截后写 R2 占位)
 *   - L6: endpoints-trend.ts runKnowledgeGeneration (L6 hook 拦截后写 degraded record)
 *
 * Fail-soft: Supabase 未配置 / R2 写入失败 / Supabase PATCH 失败 → 降级行为静默跳过
 *           （业务核心流程不被降级标记阻塞）
 */

// ===========================
// Env 接口（兼容 Env + AiBudgetEnv 子集）
// ===========================

/**
 * ai-degradation 所需的最小 Env 子集。
 * Env（./shared.ts）已包含所有这些字段，这里显式列出便于理解 + contract test mock。
 */
export interface AiDegradationEnv {
  AI_USAGE_KV?: {
    get(key: string, type?: 'text'): Promise<string | null>;
  };
  AI_BUDGET_DAILY_LIMIT?: number;
  AI_BUDGET_WARNING_THRESHOLD?: number;
  AI_BUDGET_CRITICAL_THRESHOLD?: number;
  AI_BUDGET_SHUTDOWN_THRESHOLD?: number;
  /** R2 bucket（写降级占位 markdown） */
  csnews_raw?: {
    put(
      key: string,
      value: string,
      options?: { httpMetadata?: { contentType: string } }
    ): Promise<void>;
  };
  /** Supabase (写 degraded=true 标记) */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

// ===========================
// 类型定义
// ===========================

export type DegradationLevel = 'L4' | 'L5' | 'L6';
export type DegradationTable = 'warnings' | 'knowledge';

/**
 * 降级 R2 占位的可选 context（写入 markdown frontmatter）
 */
export interface DegradedR2Context {
  topic_key?: string;
  warning_type?: string;
  severity?: string;
  seed?: string;
  notes?: string;
}

/**
 * markAsDegraded 的 extra fields（PATCH 时一并写入 Supabase）
 */
export interface MarkDegradedExtra {
  /** R2 markdown key (warnings 表的 report_r2_key 字段) */
  r2Key?: string;
  /** 空 insight 文本（knowledge 表的 insight 字段） */
  insight?: string;
  /** confidence 数值（knowledge 表，0 表示最低置信） */
  confidence?: number;
}

// ===========================
// 降级文案生成
// ===========================

/**
 * 返回用户/日志可见的降级说明文案。
 * 集成点用它写 logEvent / 返 skipped response。
 *
 * @param level  降级触发的 AI 层级
 * @param reason  可选自定义原因（默认 "AI budget exceeded"）
 */
export function getDegradationMessage(
  level: DegradationLevel,
  reason: string = 'AI budget exceeded'
): string {
  return `${reason} for ${level} threshold`;
}

// ===========================
// R2 占位写入
// ===========================

/**
 * 写降级占位 markdown 到 R2，返 r2_key。
 * R2 path 前缀按 level:
 *   - L4 → ai-degraded/{date}/{recordId}.md
 *   - L5 → fission-degraded/{date}/{recordId}.md
 *   - L6 → knowledge-degraded/{date}/{recordId}.md
 *
 * Fail-soft: csnews_raw 未配置 → 仍返 r2_key（path 形式），但 R2 没真写入。
 */
export async function writeDegradedR2(
  env: AiDegradationEnv,
  level: DegradationLevel,
  recordId: string,
  context: DegradedR2Context = {}
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();

  const prefix =
    level === 'L4' ? 'ai-degraded' : level === 'L5' ? 'fission-degraded' : 'knowledge-degraded';

  const r2Key = `${prefix}/${date}/${recordId}.md`;

  // 拉取当前 budget 状态写入 frontmatter（async, 失败不阻断降级流程）
  let budgetLine = '';
  try {
    // cast: Env 是 AiBudgetEnv 超集 · getBudgetStatus 接受 AiBudgetEnv
    const { getBudgetStatus } = await import('./ai-budget');
    const status = await getBudgetStatus(env as unknown as Parameters<typeof getBudgetStatus>[0]);
    budgetLine = `AI budget ${status.status} · 已用 ${status.used} Neurons (${status.pct}%) · 上限 ${status.limit}`;
  } catch {
    budgetLine = 'AI budget unknown (read failed)';
  }

  // context 行（按字段顺序输出，缺失字段不出现）
  const contextLines: string[] = [];
  if (context.topic_key) contextLines.push(`- **Topic**: ${context.topic_key}`);
  if (context.warning_type) contextLines.push(`- **Warning 类型**: ${context.warning_type}`);
  if (context.severity) contextLines.push(`- **Severity**: ${context.severity}`);
  if (context.seed) contextLines.push(`- **Seed**: ${context.seed}`);
  if (context.notes) contextLines.push(`- **Notes**: ${context.notes}`);

  // 降级行为说明（按 level）
  const behaviorLine =
    level === 'L4'
      ? 'Warning 未走 LLM 深度分析 · 等待 manual review'
      : level === 'L5'
        ? 'Fission 跳过 LLM · 用关键词 + bge-m3 相似替代'
        : 'Knowledge 写空 insight · 标记 degraded=true · 明天 retry';

  const markdown = `# ${level} Degraded Insight

> **降级原因**: ${budgetLine}
> **触发时间**: ${ts}
> **Record ID**: ${recordId}
> **降级级别**: ${level}

## Context

${contextLines.length > 0 ? contextLines.join('\n') : '_无额外 context_'}

## Degradation Behavior

${behaviorLine}

---

_由 CSNEWS Agent Phase 3 自动降级于 ${ts}_
`;

  // 写入 R2（csnews_raw 未配置时跳过，返 path 让 caller 仍可追踪）
  if (env.csnews_raw) {
    try {
      await env.csnews_raw.put(r2Key, markdown, {
        httpMetadata: { contentType: 'text/markdown' },
      });
    } catch {
      // R2 写入失败不阻断流程 · caller 自己处理
    }
  }

  return r2Key;
}

// ===========================
// Supabase degraded=true 标记
// ===========================

/**
 * 用 PATCH 把 Supabase 表某条记录的 degraded 字段设为 true。
 * 同时支持写入 extra fields（r2_key / insight / confidence）。
 *
 * 业务价值：业务下游（如 manual review queue / 业务统计）可以通过
 *   `?degraded=true` 过滤出"今天因 budget 超限被降级的 records"。
 *
 * Fail-soft: Supabase 未配置 / PATCH 失败 → 返 false，caller 自行处理。
 *
 * @param env  Worker env
 * @param table  Supabase 表名（warnings / knowledge · fission_searches 属于 csnews-fission worker 不在本范围）
 * @param recordId  record ID（warnings.id / knowledge.id）
 * @param extra  可选 extra fields
 * @returns 成功 true / 失败 false
 */
export async function markAsDegraded(
  env: AiDegradationEnv,
  table: DegradationTable,
  recordId: string,
  extra: MarkDegradedExtra = {}
): Promise<boolean> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return false;
  }

  const body: Record<string, unknown> = { degraded: true };
  if (extra.r2Key) body.report_r2_key = extra.r2Key;
  if (extra.insight) body.insight = extra.insight;
  if (typeof extra.confidence === 'number') body.confidence = extra.confidence;

  try {
    const { supabaseFetch } = await import('./shared');
    const res = await supabaseFetch(
      env as unknown as Parameters<typeof supabaseFetch>[0],
      `/rest/v1/${table}?id=eq.${recordId}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[ai-degradation] markAsDegraded ${table}#${recordId} failed HTTP ${res.status}: ${errText.slice(0, 200)}`
      );
      return false;
    }
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ai-degradation] markAsDegraded ${table}#${recordId} threw: ${msg}`);
    return false;
  }
}

// ===========================
// 集成 helper · L6 一站式降级
// ===========================

/**
 * L6 knowledge 降级一体化 helper（Phase 3 设计意图）：
 * - 写 R2 knowledge-degraded/{date}/{topic_id}.md 占位
 * - 写 Supabase knowledge 表 degraded=true + 空 insight
 *
 * 用于 runKnowledgeGeneration L6 hook 拦截后的 fallback 流程。
 * 设计参考：Phase 3 设计文档 "L6 knowledge: 写空 insight 'AI budget exceeded, retry next day'"
 */
export async function writeDegradedKnowledge(
  env: AiDegradationEnv,
  topicId: string,
  warningId: string,
  context: { topic_key?: string; warning_type?: string; severity?: string } = {}
): Promise<{ r2Key: string; marked: boolean }> {
  const r2Key = await writeDegradedR2(env, 'L6', `${topicId}-${warningId}`, {
    ...context,
    notes: 'L6 knowledge degraded · retry next day',
  });

  // 尝试 markAsDegraded · 失败不影响 r2Key 返值
  let marked = false;
  try {
    marked = await markAsDegraded(env, 'knowledge', warningId, {
      r2Key,
      insight: 'AI budget exceeded, retry next day',
      confidence: 0,
    });
  } catch {
    marked = false;
  }

  return { r2Key, marked };
}

// ===========================
// 集成 helper · L5 一站式降级
// ===========================

/**
 * L5 fission 降级一体化 helper（Phase 3 设计意图）：
 * - 写 R2 fission-degraded/{date}/{seed_id}.md 占位
 * - 不改 fission_searches 表（属于 csnews-fission worker 项目）
 *
 * 用于 handleFissionAction L5 hook 拦截后的 fallback 流程。
 * 设计参考：Phase 3 设计文档 "L5 裂变: 跳过 LLM · 用关键词 + bge-m3 相似替代"
 */
export async function writeDegradedFission(
  env: AiDegradationEnv,
  seedId: string,
  context: { seed?: string; notes?: string } = {}
): Promise<string> {
  return writeDegradedR2(env, 'L5', seedId, context);
}

// ===========================
// 集成 helper · L4 一站式降级（warnings）
// ===========================

/**
 * L4 warning 降级一体化 helper（Phase 3 设计意图）：
 * - 写 R2 ai-degraded/{date}/{warning_id}.md 占位
 * - 写 Supabase warnings 表 degraded=true
 *
 * 用于 news-process.ts 创建 warning 时，如果当前 budget 已超限：
 *   标记 warning degraded=true，等待 manual review 队列。
 */
export async function writeDegradedWarning(
  env: AiDegradationEnv,
  warningId: string,
  context: { topic_key?: string; warning_type?: string; severity?: string } = {}
): Promise<{ r2Key: string; marked: boolean }> {
  const r2Key = await writeDegradedR2(env, 'L4', warningId, context);
  let marked = false;
  try {
    marked = await markAsDegraded(env, 'warnings', warningId, { r2Key });
  } catch {
    marked = false;
  }
  return { r2Key, marked };
}
