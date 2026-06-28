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
 * Decide whether a title warrants a full Workers AI call.
 * Returns true when rule score meets or exceeds the routing threshold.
 */
export function shouldTriggerAiCall(score: number): boolean {
  return score >= AI_ROUTE_R_THRESHOLD;
}
