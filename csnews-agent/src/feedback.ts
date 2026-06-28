// ============================================================
// feedback.ts · O11 Feedback Loop Worker Implementation
// Purpose: Self-calibrating scoring accuracy via 24/48/72h
//          warning复查 + accuracy-based weight adjustment.
//
// Cron trigger: scheduledFeedback() — CF Cron Trigger (方案 B)
// Debug: handleFeedbackCheckAction() — ?action=feedback-check
//
// Business rules:
//   - 24h: skip judgment (pending)
//   - 48h: preliminary — score_now >= score_at_creation → validated
//   - 72h: final — score_now >= score_at_creation → validated / else dismissed
//   - accuracy = correct / total (per category)
//   - accuracy < 0.6 → reduce weight × 0.9
//   - accuracy 0.6–0.8 → no change
//   - accuracy > 0.8 → encourage × 1.05
//   - scoreRule hot-word weights loaded from score_rule_weights table
// ============================================================

import { Env, getSupabaseHost, supabaseFetch } from './shared';
import { supabaseHeaders } from './utils';
import { logEvent } from './log';
import { loadWeights, adjustWeights } from './score-rule-weights';

/**
 * R2 path for per-category accuracy history.
 */
function accuracyR2Key(category: string): string {
  return `feedback/accuracy/${category}.json`;
}

interface WarningRow {
  id: string;
  topic_id: string;
  category: string | null;
  feedback_status: string | null;
  created_at: string;
}

interface TopicRow {
  id: string;
  score: number | null;
}

interface FeedbackResult {
  processed: number;
  validated: number;
  dismissed: number;
  pending: number;
  errors: number;
  categoryAccuracy: Record<string, { accuracy: number; correct: number; total: number }>;
}

/**
 * Pull open warnings that need feedback check, grouped by hours-elapsed checkpoint.
 * Queries: feedback_status IS NULL or 'pending' AND status='open'
 */
async function fetchOpenWarnings(
  env: Env
): Promise<{ warning: WarningRow; hoursElapsed: number; checkHour: 24 | 48 | 72 }[]> {
  const now = Date.now();
  const host = getSupabaseHost(env);

  // Fetch all open warnings with null/pending feedback_status
  const res = await fetch(
    `${host}/rest/v1/warnings?status=eq.open&or=(feedback_status.is.null,feedback_status.eq.pending)&select=id,topic_id,category,feedback_status,created_at&limit=1000`,
    { headers: supabaseHeaders(env) }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fetchOpenWarnings failed HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const warnings: WarningRow[] = await res.json();
  const results: { warning: WarningRow; hoursElapsed: number; checkHour: 24 | 48 | 72 }[] = [];

  for (const warning of warnings) {
    const createdMs = Date.parse(warning.created_at);
    if (!Number.isFinite(createdMs)) continue;

    const hoursElapsed = (now - createdMs) / 3_600_000;

    // Only process at exact checkpoint hours (24 / 48 / 72)
    let checkHour: 24 | 48 | 72 | null = null;
    if (hoursElapsed >= 24 && hoursElapsed < 30) checkHour = 24;
    else if (hoursElapsed >= 48 && hoursElapsed < 54) checkHour = 48;
    else if (hoursElapsed >= 72) checkHour = 72;

    if (checkHour !== null) {
      results.push({ warning, hoursElapsed, checkHour });
    }
  }

  return results;
}

/**
 * Fetch current topic score from Supabase.
 */
async function fetchTopicScore(env: Env, topicId: string): Promise<number> {
  const host = getSupabaseHost(env);
  const res = await fetch(`${host}/rest/v1/topics?id=eq.${topicId}&select=score&limit=1`, {
    headers: supabaseHeaders(env),
  });
  if (!res.ok) return 0;
  const rows: TopicRow[] = await res.json();
  return rows[0]?.score ?? 0;
}

/**
 * Call record_feedback RPC and return the parsed result.
 */
async function callRecordFeedbackRpc(
  env: Env,
  warningId: string,
  checkHour: number,
  topicScoreNow: number
): Promise<{
  feedback_status: string | null;
  accuracy: number | null;
  correct: number;
  total: number;
}> {
  const host = getSupabaseHost(env);
  const body = JSON.stringify({
    p_warning_id: warningId,
    p_check_hour: checkHour,
    p_topic_score_now: topicScoreNow,
  });

  const res = await fetch(`${host}/rest/v1/rpc/record_feedback`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`record_feedback RPC failed HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const rows: Array<{
    feedback_status: string | null;
    accuracy: number | null;
    correct: number;
    total: number;
  }> = await res.json();
  return rows[0] ?? { feedback_status: null, accuracy: null, correct: 0, total: 0 };
}

/**
 * Write accuracy history to R2 for a given category.
 */
async function writeAccuracyToR2(
  env: Env,
  category: string,
  accuracy: number,
  correct: number,
  total: number
): Promise<void> {
  const key = accuracyR2Key(category);
  const entry = {
    category,
    accuracy,
    correct,
    total,
    written_at: new Date().toISOString(),
  };
  try {
    await env.csnews_raw.put(key, JSON.stringify(entry, null, 2));
  } catch (e: any) {
    await logEvent(
      env,
      'error',
      `[feedback] R2 write failed key=${key} err=${e?.message || e}`,
      undefined,
      'feedback'
    );
  }
}

/**
 * Main feedback check runner — called by both scheduledFeedback() and handleFeedbackCheckAction().
 *
 * Flow:
 *   1. Fetch open warnings needing feedback check (24/48/72h checkpoints)
 *   2. For each warning:
 *      a. Fetch current topic_score from Supabase
 *      b. Call record_feedback RPC (writes feedback_status + returns accuracy)
 *      c. If check_hour = 72 and accuracy < 0.6 → adjustWeights()
 *      d. Write accuracy history to R2
 *   3. Return summary
 */
export async function runFeedbackCheck(env: Env): Promise<FeedbackResult> {
  const start = Date.now();
  const checkpoints = await fetchOpenWarnings(env);

  const result: FeedbackResult = {
    processed: 0,
    validated: 0,
    dismissed: 0,
    pending: 0,
    errors: 0,
    categoryAccuracy: {},
  };

  // Track per-category accuracy across all processed warnings
  const categoryCorrect: Record<string, number> = {};
  const categoryTotal: Record<string, number> = {};

  for (const { warning, checkHour } of checkpoints) {
    try {
      const topicScoreNow = await fetchTopicScore(env, warning.topic_id);
      const rpcResult = await callRecordFeedbackRpc(env, warning.id, checkHour, topicScoreNow);

      const { feedback_status, accuracy, correct, total } = rpcResult;
      const category = warning.category ?? 'unknown';

      // Update counters
      result.processed++;
      if (feedback_status === 'validated') result.validated++;
      else if (feedback_status === 'dismissed') result.dismissed++;
      else result.pending++;

      // Accumulate category stats for accuracy calculation
      if (feedback_status === 'validated' || feedback_status === 'dismissed') {
        categoryCorrect[category] =
          (categoryCorrect[category] ?? 0) + (feedback_status === 'validated' ? 1 : 0);
        categoryTotal[category] = (categoryTotal[category] ?? 0) + 1;
      }

      // At 72h final checkpoint: trigger weight adjustment if accuracy < 0.6
      if (checkHour === 72 && accuracy !== null && accuracy < 0.6) {
        const weights = await loadWeights(env, category);
        await adjustWeights(env, category, accuracy, weights);
        await logEvent(
          env,
          'info',
          `[feedback] weight adjusted category=${category} accuracy=${accuracy} (<0.6 threshold)`,
          undefined,
          'feedback'
        );
      }

      // Write per-checkpoint accuracy to R2
      if (accuracy !== null) {
        await writeAccuracyToR2(env, category, accuracy, correct, total);
      }

      // Update categoryAccuracy for response
      result.categoryAccuracy[category] = { accuracy: accuracy ?? 0, correct, total };
    } catch (e: any) {
      await logEvent(
        env,
        'error',
        `[feedback] processing warning ${warning.id} failed: ${e?.message || e}`,
        undefined,
        'feedback'
      );
      result.errors++;
    }
  }

  const elapsed = Date.now() - start;
  await logEvent(
    env,
    'info',
    `[feedback] runFeedbackCheck done processed=${result.processed} validated=${result.validated} dismissed=${result.dismissed} pending=${result.pending} errors=${result.errors} elapsed=${elapsed}ms`,
    undefined,
    'feedback'
  );

  return result;
}

/**
 * HTTP endpoint handler for ?action=feedback-check (manual/debug trigger).
 * Does NOT use ctx.waitUntil (synchronous, suitable for on-demand invocation).
 */
export async function handleFeedbackCheckAction(
  env: Env
): Promise<{ ok: boolean; result: FeedbackResult; elapsed_ms: number }> {
  const start = Date.now();
  try {
    const result = await runFeedbackCheck(env);
    return { ok: true, result, elapsed_ms: Date.now() - start };
  } catch (e: any) {
    return {
      ok: false,
      result: {
        processed: 0,
        validated: 0,
        dismissed: 0,
        pending: 0,
        errors: 1,
        categoryAccuracy: {},
      },
      elapsed_ms: Date.now() - start,
    };
  }
}

// ============================================================
// scheduledFeedback · CF Cron Trigger Entry Point
// ============================================================

interface ScheduledController {
  cron: string;
}

/**
 * Cloudflare Cron Trigger handler — exported for wrangler.toml cron binding.
 *
 * Signature: (env, ctx, controller) → Promise<void>
 * Uses ctx.waitUntil so the worker doesn't terminate before runFeedbackCheck completes.
 * Silently catches all errors (DB unreachable, network issues) to avoid cron retries.
 */
export async function scheduledFeedback(
  env: Env,
  _ctx: ExecutionContext,
  _controller?: ScheduledController
): Promise<void> {
  try {
    await runFeedbackCheck(env);
  } catch (e: any) {
    // Intentionally swallowed — cron trigger must not re-throw
    await logEvent(
      env,
      'error',
      '[feedback] scheduledFeedback caught error:',
      { err: e?.message || e },
      'feedback'
    );
  }
}
