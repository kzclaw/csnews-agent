/**
 * CSNEWS Agent · Event Stage Lifecycle (v0.36.13)
 *
 * Event Lifecycle 5-Stage transition engine.
 * Stages: detected → confirmed → growing → hot → archived
 *
 * Transition rules (unidirectional):
 *   detected  → confirmed:  news_count >= 2
 *   confirmed → growing:    news_count > 5 OR velocity > 0
 *   growing  → hot:        velocity ≈ 0 AND news_count > 20
 *   hot      → archived:   news_count < 5 for 24h (last_active_at)
 *
 * Archived is terminal — no backward transitions.
 *
 * SQL: supabase/migrations/20260630_o3kr5_event_stage_rpc.sql
 */
import { Env, supabaseFetch, safeJson } from './shared';
import { logEvent } from './log';

export type EventStage = 'detected' | 'confirmed' | 'growing' | 'hot' | 'archived';

export interface TransitionResult {
  topic_id: string;
  old_stage: EventStage | null;
  new_stage: EventStage | null;
  changed: boolean;
}

/**
 * Invoke update_topic_event_stage RPC.
 * Returns the new event_stage (may equal old stage if no transition).
 * Returns null if topic not found.
 *
 * Transition logic lives server-side in the SQL function so we avoid
 * multiple round-trips (news_count query + velocity query + update).
 */
export async function transitionEventStage(
  env: Env,
  topicId: string
): Promise<TransitionResult> {
  try {
    const res = await supabaseFetch(
      env,
      '/rest/v1/rpc/update_topic_event_stage',
      {
        method: 'POST',
        body: JSON.stringify({ p_topic_id: topicId }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      await logEvent(
        env,
        'warn',
        `[event-stage] RPC failed for topic ${topicId}: ${err}`,
        undefined,
        'event'
      );
      return { topic_id: topicId, old_stage: null, new_stage: null, changed: false };
    }

    const data = (await safeJson(res)) as string | null;
    const newStage = data as EventStage | null;

    // We don't know the old stage from the RPC return value alone,
    // so we fetch it as part of the transition result by reading the topic.
    // To avoid extra round-trip, we query topics for the old stage in the same call.
    const topicRes = await supabaseFetch(
      env,
      `/rest/v1/topics?id=eq.${topicId}&select=event_stage`,
      { method: 'GET' }
    );

    let oldStage: EventStage | null = null;
    if (topicRes.ok) {
      const rows = (await safeJson(topicRes)) as Array<{ event_stage: EventStage }>;
      if (rows && rows.length > 0) {
        oldStage = rows[0].event_stage;
      }
    }

    return {
      topic_id: topicId,
      old_stage: oldStage,
      new_stage: newStage,
      changed: newStage !== null && newStage !== oldStage,
    };
  } catch (e: any) {
    await logEvent(
      env,
      'error',
      `[event-stage] transitionEventStage exception for topic ${topicId}: ${e?.message || e}`,
      undefined,
      'event'
    );
    return { topic_id: topicId, old_stage: null, new_stage: null, changed: false };
  }
}

/**
 * Batch-transition event stages for all topic IDs in a cluster.
 * Returns transition results with stage changes.
 */
export async function transitionEventStageBatch(
  env: Env,
  topicIds: string[]
): Promise<TransitionResult[]> {
  const results: TransitionResult[] = [];
  // Process sequentially to avoid overwhelming the database.
  // The RPC is lightweight (single UPDATE or read-only scan).
  for (const topicId of topicIds) {
    const result = await transitionEventStage(env, topicId);
    results.push(result);
  }
  return results;
}
