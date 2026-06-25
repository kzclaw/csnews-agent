/**
 * CSNEWS Agent · 事件关系检测 - Semantic
 *
 * 检测规则: embedding cosine 相似度 > 阈值 → 建 semantic 关系
 * sub_type: 'related'
 *
 * 生产路径: 使用 exec RPC 执行 pgvector SQL
 * 备选路径: 通过 REST API 拉取 events + TypeScript 计算
 */
import { Env, supabaseFetch } from './shared';
import { logEvent } from './log';

export interface SemanticRelation {
  from_event_id: string;
  to_event_id: string;
  similarity: number;
}

/**
 * 运行 semantic 关系检测 (生产路径: exec RPC)
 * @param threshold cosine 相似度阈值 (默认 0.7)
 * @returns 检测到的新关系数量
 */
export async function detectSemanticRelations(
  env: Env,
  threshold = 0.7
): Promise<{
  detected: number;
  errors: number;
}> {
  const sql = `
    INSERT INTO event_relation (from_event_id, to_event_id, relation_type, sub_type, weight, evidence, detected_by)
    SELECT
      e1.id,
      e2.id,
      'semantic',
      'related',
      1 - (e1.embedding <=> e2.embedding),
      jsonb_build_object('similarity', 1 - (e1.embedding <=> e2.embedding)),
      'sql_batch'
    FROM events e1, events e2
    WHERE e1.id < e2.id
      AND 1 - (e1.embedding <=> e2.embedding) > ${threshold}
      AND NOT EXISTS (
        SELECT 1 FROM event_relation er
        WHERE er.from_event_id = e1.id
          AND er.to_event_id = e2.id
          AND er.relation_type = 'semantic'
      )
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
      await logEvent(env, 'error', `[event-semantic-detector] exec failed: ${res.status} ${text}`, undefined, 'event');
      return { detected: 0, errors: 1 };
    }

    const data = await res.json();
    const count = Array.isArray(data) ? data.length : 0;
    await logEvent(env, 'info', `[event-semantic-detector] detected ${count} semantic relations (threshold=${threshold})`, undefined, 'event');
    return { detected: count, errors: 0 };
  } catch (e: any) {
    await logEvent(env, 'error', `[event-semantic-detector] error: ${e?.message || e}`, undefined, 'event');
    return { detected: 0, errors: 1 };
  }
}

/**
 * 获取 semantic pairs (预览模式)
 */
export async function getSemanticPairs(
  env: Env,
  threshold = 0.7
): Promise<SemanticRelation[]> {
  const sql = `
    SELECT
      e1.id AS from_event_id,
      e2.id AS to_event_id,
      1 - (e1.embedding <=> e2.embedding) AS similarity
    FROM events e1, events e2
    WHERE e1.id < e2.id
      AND 1 - (e1.embedding <=> e2.embedding) > ${threshold}
    ORDER BY similarity DESC;
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
    await logEvent(env, 'error', `[event-semantic-detector] error: ${e?.message || e}`, undefined, 'event');
    return [];
  }
}
