/**
 * CSNEWS Agent · 事件关系检测 - Temporal
 *
 * 检测规则: 两个 events 时间差 < 24h → 建 temporal 关系
 * sub_type: 'simultaneous' (<1h) | 'follow_up' (1-24h)
 */
import { Env, supabaseFetch } from './shared';

export interface TemporalRelation {
  from_event_id: string;
  to_event_id: string;
  hours_diff: number;
  sub_type: 'simultaneous' | 'follow_up';
}

interface Event {
  id: string;
  title: string;
  published_at: string;
}

/**
 * 运行 temporal 关系检测
 * 1. 通过 REST API 拉 events
 * 2. 本地计算 temporal pairs
 * 3. 批量写入 event_relation
 * @returns 检测到的新关系数量
 */
export async function detectTemporalRelations(env: Env): Promise<{
  detected: number;
  errors: number;
}> {
  // Step 1: fetch events
  const res = await supabaseFetch(env, '/rest/v1/events?select=id,published_at&published_at=not.is.null&order=published_at.desc', {
    headers: { 'Prefer': 'count=exact' },
  });

  if (!res.ok) {
    console.error(`[event-temporal-detector] fetch failed: ${res.status}`);
    return { detected: 0, errors: 1 };
  }

  const events: Event[] = await res.json();
  if (events.length < 2) {
    console.log('[event-temporal-detector] < 2 events, skipping');
    return { detected: 0, errors: 0 };
  }

  // Step 2: compute temporal pairs locally
  const pairs: TemporalRelation[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const e1 = events[i];
      const e2 = events[j];
      const diffMs = new Date(e2.published_at).getTime() - new Date(e1.published_at).getTime();
      const diffHours = diffMs / (1000 * 3600);

      if (diffHours >= 0 && diffHours < 24) {
        pairs.push({
          from_event_id: e1.id,
          to_event_id: e2.id,
          hours_diff: diffHours,
          sub_type: diffHours < 1 ? 'simultaneous' : 'follow_up',
        });
      }
    }
  }

  if (pairs.length === 0) {
    console.log('[event-temporal-detector] no temporal pairs found');
    return { detected: 0, errors: 0 };
  }

  // Step 3: fetch existing relations to avoid duplicates
  const existingRes = await supabaseFetch(
    env,
    `/rest/v1/event_relation?relation_type=eq.temporal&select=from_event_id,to_event_id`,
    { headers: { 'Prefer': 'count=exact' } }
  );
  const existing = new Set<string>();
  if (existingRes.ok) {
    const existingData: Array<{ from_event_id: string; to_event_id: string }> = await existingRes.json();
    for (const r of existingData) {
      existing.add(`${r.from_event_id}:${r.to_event_id}`);
    }
  }

  // Step 4: batch insert new relations
  let inserted = 0;
  for (const pair of pairs) {
    const key = `${pair.from_event_id}:${pair.to_event_id}`;
    if (existing.has(key)) continue;

    const insertRes = await supabaseFetch(env, '/rest/v1/event_relation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        from_event_id: pair.from_event_id,
        to_event_id: pair.to_event_id,
        relation_type: 'temporal',
        sub_type: pair.sub_type,
        weight: 1.0,
        evidence: { hours_diff: Math.round(pair.hours_diff * 100) / 100 },
        detected_by: 'sql_batch',
      }),
    });

    if (insertRes.ok || insertRes.status === 409) {
      inserted++;
    } else {
      console.error(`[event-temporal-detector] insert failed: ${insertRes.status}`);
    }
  }

  console.log(`[event-temporal-detector] detected ${inserted} new temporal relations`);
  return { detected: inserted, errors: 0 };
}

/**
 * 获取 temporal pairs (预览模式,不写入)
 */
export async function getTemporalPairs(env: Env): Promise<TemporalRelation[]> {
  const res = await supabaseFetch(env, '/rest/v1/events?select=id,published_at&published_at=not.is.null&order=published_at.desc', {
    headers: { 'Prefer': 'count=exact' },
  });

  if (!res.ok) return [];
  const events: Event[] = await res.json();
  const pairs: TemporalRelation[] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const e1 = events[i];
      const e2 = events[j];
      const diffHours = (new Date(e2.published_at).getTime() - new Date(e1.published_at).getTime()) / (1000 * 3600);

      if (diffHours >= 0 && diffHours < 24) {
        pairs.push({
          from_event_id: e1.id,
          to_event_id: e2.id,
          hours_diff: diffHours,
          sub_type: diffHours < 1 ? 'simultaneous' : 'follow_up',
        });
      }
    }
  }

  return pairs;
}
