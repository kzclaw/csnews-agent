// ============================================================
// AI processing — title scoring, classification, routing threshold
// ============================================================

import { Env } from './shared';
import { scoreRule, scoreRuleWithWeights, AI_ROUTE_R_THRESHOLD } from './score';
import { classify } from './classify';

/** Score a news title using default weights. Returns { score, reason, isHigh }. */
export function scoreTitle(title: string): { score: number; reason: string; isHigh: boolean } {
  return scoreRule(title);
}

/**
 * Score a news title using category-specific dynamic weights from the database.
 * Falls back to default weights if DB lookup fails.
 */
export async function scoreTitleWithWeights(
  title: string,
  category: string,
  env: Env
): Promise<{ score: number; reason: string; isHigh: boolean }> {
  return scoreRuleWithWeights(title, category, env);
}

/**
 * Classify a news title using semantic embedding similarity.
 * Optionally pass item summary for better classification accuracy.
 */
export async function classifyTitle(title: string, env: Env, summary?: string): Promise<string> {
  return classify(title, env, summary);
}

/**
 * Decide whether a title's rule score is high enough to warrant a full
 * Workers AI call (L2 scoring).
 *
 * Returns true when rule score meets or exceeds AI_ROUTE_R_THRESHOLD.
 *
 * NOTE: Name renamed from shouldTriggerAiCall → shouldTriggerAiRouting in
 * v0.37.9 to avoid collision with src/ai-budget.ts shouldTriggerAiCall
 * (which is the budget-check hook for the Neurons budget control feature).
 * The two functions answer different questions:
 *   - shouldTriggerAiRouting(score) → is this title hot enough to deserve LLM?
 *   - shouldTriggerAiCall(env, level) → is there budget left for this AI level?
 *
 * As of v0.37.9 this function has no in-tree callers; callers inline the
 * comparison `rScore >= AI_ROUTE_R_THRESHOLD` directly. Kept exported for
 * future use and for any external scripts that may import it.
 */
export function shouldTriggerAiRouting(score: number): boolean {
  return score >= AI_ROUTE_R_THRESHOLD;
}
