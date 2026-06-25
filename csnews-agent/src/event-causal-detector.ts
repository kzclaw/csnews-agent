/**
 * CSNEWS Agent · 事件关系检测 - Causal
 *
 * 检测规则: from_event 含 head_kw, to_event 含 tail_kw, 时间窗口 < max_hours
 * 使用 causal_rules 表的 5 条预置规则
 * sub_type: policy_market | announcement_reaction | investigation_response | sanction_reaction | earnings_investigation
 */
import { Env, supabaseFetch } from './shared';
import { logEvent } from './log';

export interface CausalRelation {
  from_event_id: string;
  to_event_id: string;
  relation: string;
  matched_head: string;
  matched_tail: string;
  hours_diff: number;
}

/**
 * 运行 causal 关系检测
 * @returns 检测到的新关系数量
 */
export async function detectCausalRelations(env: Env): Promise<{
  detected: number;
  errors: number;
}> {
  const sql = `
    WITH candidate_pairs AS (
      SELECT
        e1.id AS from_id,
        e1.title AS from_title,
        e2.id AS to_id,
        e2.title AS to_title,
        EXTRACT(EPOCH FROM (e2.published_at - e1.published_at))/3600 AS hours_diff,
        r.relation,
        r.head_kw,
        r.tail_kw
      FROM events e1, events e2, causal_rules r
      WHERE e1.id < e2.id
        AND e2.published_at > e1.published_at
        AND e2.published_at - e1.published_at <= (r.max_hours || ' hours')::interval
        AND r.active = TRUE
    ),
    matched AS (
      SELECT
        from_id,
        to_id,
        hours_diff,
        relation,
        (SELECT kw FROM unnest(head_kw) kw WHERE from_title LIKE '%' || kw || '%' LIMIT 1) AS matched_head,
        (SELECT kw FROM unnest(tail_kw) kw WHERE to_title LIKE '%' || kw || '%' LIMIT 1) AS matched_tail
      FROM candidate_pairs
      WHERE
        (SELECT COUNT(*) FROM unnest(head_kw) kw WHERE from_title LIKE '%' || kw || '%') > 0
        AND (SELECT COUNT(*) FROM unnest(tail_kw) kw WHERE to_title LIKE '%' || kw || '%') > 0
    )
    INSERT INTO event_relation (from_event_id, to_event_id, relation_type, sub_type, weight, evidence, detected_by)
    SELECT
      from_id,
      to_id,
      'causal',
      relation,
      0.75,
      jsonb_build_object(
        'rule', relation,
        'matched_head', matched_head,
        'matched_tail', matched_tail,
        'hours_diff', ROUND(hours_diff, 1)
      ),
      'rule_template'
    FROM matched
    ON CONFLICT (from_event_id, to_event_id, relation_type) DO NOTHING
    RETURNING from_event_id;
  `;

  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ p_sql: sql }),
    });

    if (!res.ok) {
      const text = await res.text();
      await logEvent(env, 'error', `[event-causal-detector] exec failed: ${res.status} ${text}`, undefined, 'event');
      return { detected: 0, errors: 1 };
    }

    const data = await res.json();
    const count = Array.isArray(data) ? data.length : 0;
    await logEvent(env, 'info', `[event-causal-detector] detected ${count} causal relations`, undefined, 'event');
    return { detected: count, errors: 0 };
  } catch (e: any) {
    await logEvent(env, 'error', `[event-causal-detector] error: ${e?.message || e}`, undefined, 'event');
    return { detected: 0, errors: 1 };
  }
}

/**
 * 获取 causal pairs (预览模式)
 */
export async function getCausalPairs(env: Env): Promise<CausalRelation[]> {
  const sql = `
    WITH candidate_pairs AS (
      SELECT
        e1.id AS from_event_id,
        e1.title AS from_title,
        e2.id AS to_event_id,
        e2.title AS to_title,
        EXTRACT(EPOCH FROM (e2.published_at - e1.published_at))/3600 AS hours_diff,
        r.relation,
        r.head_kw,
        r.tail_kw
      FROM events e1, events e2, causal_rules r
      WHERE e1.id < e2.id
        AND e2.published_at > e1.published_at
        AND e2.published_at - e1.published_at <= (r.max_hours || ' hours')::interval
        AND r.active = TRUE
    )
    SELECT
      from_event_id,
      to_event_id,
      hours_diff,
      relation,
      (SELECT kw FROM unnest(head_kw) kw WHERE from_title LIKE '%' || kw || '%' LIMIT 1) AS matched_head,
      (SELECT kw FROM unnest(tail_kw) kw WHERE to_title LIKE '%' || kw || '%' LIMIT 1) AS matched_tail
    FROM candidate_pairs
    WHERE
      (SELECT COUNT(*) FROM unnest(head_kw) kw WHERE from_title LIKE '%' || kw || '%') > 0
      AND (SELECT COUNT(*) FROM unnest(tail_kw) kw WHERE to_title LIKE '%' || kw || '%') > 0
    ORDER BY hours_diff ASC;
  `;

  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ p_sql: sql }),
    });

    if (!res.ok) return [];
    return await res.json();
  } catch (e: any) {
    await logEvent(env, 'error', `[event-causal-detector] error: ${e?.message || e}`, undefined, 'event');
    return [];
  }
}
