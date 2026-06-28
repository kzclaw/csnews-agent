// ============================================================
// score-rule-weights.ts · O11 Feedback Loop Weight Tuning
// Purpose: Load / save / adjust hot-word weights per category
//          based on feedback loop accuracy calculations.
//
// Accuracy thresholds (O11 blueprint formula):
//   - accuracy < 0.6  → reduce weight × 0.9
//   - accuracy 0.6–0.8 → no change
//   - accuracy > 0.8  → encourage × 1.05
//
// Default hot-word list mirrors scoreRule() in score.ts.
// Custom weights stored in Supabase score_rule_weights table.
// ============================================================

import { Env, getSupabaseHost } from './shared';
import { logEvent } from './log';
import { supabaseHeaders } from './utils';

/**
 * Default hot-word weights (baseline — used when DB has no entry).
 * Format: hot_word → base weight multiplier.
 */
export const DEFAULT_HOT_WORD_WEIGHTS: Record<string, number> = {
  突发: 1.0,
  震惊: 1.0,
  重磅: 1.0,
  紧急: 1.0,
  首次: 1.0,
  史上: 1.0,
  最新: 1.0,
  突破: 1.0,
  革命: 1.0,
  创历史: 1.0,
};

// Supabase returns rows as { category, hot_word, weight, updated_at }
interface WeightRow {
  category: string;
  hot_word: string;
  weight: number;
  updated_at: string;
}

/**
 * Load weights for a category from Supabase score_rule_weights table.
 * Falls back to DEFAULT_HOT_WORD_WEIGHTS for any hot_word not in DB.
 *
 * @param env - Worker Env
 * @param category - Topic category
 * @returns Record<hot_word, weight>
 */
export async function loadWeights(env: Env, category: string): Promise<Record<string, number>> {
  // Start with defaults
  const weights: Record<string, number> = { ...DEFAULT_HOT_WORD_WEIGHTS };

  try {
    const host = getSupabaseHost(env);
    const res = await fetch(
      `${host}/rest/v1/score_rule_weights?category=eq.${encodeURIComponent(category)}&select=hot_word,weight`,
      { headers: supabaseHeaders(env) }
    );

    if (res.ok) {
      const rows: WeightRow[] = await res.json();
      for (const row of rows) {
        weights[row.hot_word] = row.weight;
      }
    }
    // On error: silently use defaults (DB may not have data yet)
  } catch {
    // DB unreachable: fall back to defaults
  }

  return weights;
}

/**
 * Save updated weights to Supabase score_rule_weights table.
 * Uses upsert to create-or-update per (category, hot_word) key.
 *
 * @param env - Worker Env
 * @param category - Topic category
 * @param weights - Record<hot_word, weight>
 */
export async function saveWeights(
  env: Env,
  category: string,
  weights: Record<string, number>
): Promise<void> {
  const host = getSupabaseHost(env);
  const rows = Object.entries(weights).map(([hot_word, weight]) => ({
    category,
    hot_word,
    weight,
    updated_at: new Date().toISOString(),
  }));

  const res = await fetch(`${host}/rest/v1/score_rule_weights`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`saveWeights failed HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
}

/**
 * Adjust weights for a category based on feedback accuracy.
 *
 * Blueprint formula:
 *   accuracy < 0.6  → reduce: weight × 0.9
 *   accuracy 0.6–0.8 → no change
 *   accuracy > 0.8   → encourage: weight × 1.05
 *
 * Each hot_word weight is independently adjusted.
 * Min weight = 0.1 (floor), Max weight = 3.0 (ceiling).
 * Adjusted weights are immediately saved to Supabase.
 *
 * @param env - Worker Env
 * @param category - Topic category
 * @param accuracy - Calculated accuracy for this category
 * @param currentWeights - Current weights loaded via loadWeights()
 */
export async function adjustWeights(
  env: Env,
  category: string,
  accuracy: number,
  currentWeights: Record<string, number>
): Promise<Record<string, number>> {
  const MIN_WEIGHT = 0.1;
  const MAX_WEIGHT = 3.0;

  let factor: number;
  if (accuracy < 0.6) {
    factor = 0.9; // reduce
  } else if (accuracy > 0.8) {
    factor = 1.05; // encourage
  } else {
    // 0.6–0.8: no change
    return currentWeights;
  }

  const adjusted: Record<string, number> = {};
  for (const [hotWord, weight] of Object.entries(currentWeights)) {
    const newWeight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, weight * factor));
    adjusted[hotWord] = Math.round(newWeight * 100) / 100; // 2 decimal places
  }

  await saveWeights(env, category, adjusted);
  await logEvent(
    env,
    'info',
    `[score-rule-weights] adjusted category=${category} accuracy=${accuracy} factor=${factor}`,
    undefined,
    'feedback'
  );

  return adjusted;
}
