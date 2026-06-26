// ============================================================
// 标题评分 + 路由阈值常量
// ============================================================
//用途：标题评分（热词/超热/数字/长度）+3 个路由阈值常量
// + hashStr工具（用于 topic_key 生成）
//
// NOTE: scoreRule max=9.1 (5.5 base + 2.0 superHot + 0.5 num + 0.3 len + 0.3 ! + 0.5 hotCount>=3)
//
// O11 Feedback Loop integration (v0.36.22):
//   scoreRuleWithWeights() uses dynamic hot-word weights from score_rule_weights table.
//   scoreRule() stays fast (sync, defaults) for backward compat.

import type { Env } from './shared';
import { DEFAULT_HOT_WORD_WEIGHTS } from './score-rule-weights';

// R threshold for Workers AI routing (Neurons saving)
// NOTE: scoreRule max=9.1 (5.5 base + 2.0 superHot + 0.5 num + 0.3 len + 0.3 ! + 0.5 hotCount>=3)
//       threshold must be <= 9.1 to be reachable
export const AI_ROUTE_R_THRESHOLD = 7.0;
export const TOPIC_MATCH_THRESHOLD = 0.72;
export const R2_DUP_THRESHOLD = 0.88;

//简单字符串哈希(用于 topic_key 生成)
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// Default hot-word list (mirrored in score-rule-weights.ts DEFAULT_HOT_WORD_WEIGHTS)
const DEFAULT_HOT_WORDS = [
  '突发',
  '震惊',
  '重磅',
  '紧急',
  '首次',
  '史上',
  '最新',
  '突破',
  '革命',
  '创历史',
];
const SUPER_HOT_WORDS = ['紧急', '突发', '重磅', '震惊', '史上最强', '首款'];

/**
 * Core scoring helper — uses given weight map (or defaults).
 * Exported for testability; used by scoreRule() and scoreRuleWithWeights().
 */
export function applyScore(
  title: string,
  weights: Record<string, number>
): { score: number; matchedHotWords: string[]; superHot: boolean } {
  const matchedHotWords = DEFAULT_HOT_WORDS.filter((w) => title.includes(w));
  const superHot = SUPER_HOT_WORDS.some((w) => title.includes(w));

  const hotBase = superHot ? 2.0 : matchedHotWords.length > 0 ? 1.2 : 0;
  const numBonus = /\d+/.test(title) ? 0.5 : 0;
  const lenBonus = title.length > 20 && title.length < 35 ? 0.3 : 0;
  const exclaimBonus = /[!?！？?]/.test(title) ? 0.3 : 0;
  const multiHotBonus = matchedHotWords.length >= 3 ? 0.5 : matchedHotWords.length >= 2 ? 0.3 : 0;

  // Dynamic weight: apply per-hot-word multiplier from DB weights
  let dynamicWeight = 1.0;
  if (matchedHotWords.length > 0) {
    const avgWeight =
      matchedHotWords.reduce((sum, w) => sum + (weights[w] ?? 1.0), 0) / matchedHotWords.length;
    dynamicWeight = avgWeight;
  }

  let score = 5.5 + hotBase * dynamicWeight + numBonus + lenBonus + exclaimBonus + multiHotBonus;
  score = Math.min(10, Math.round(score * 10) / 10);
  return { score, matchedHotWords, superHot };
}

// ============================================================
//评分规则 (同步，默认权重，保持向后兼容)
// ============================================================
/**
 * Score a news title using default hot-word weights.
 * O11 Feedback Loop: prefer scoreRuleWithWeights() for dynamic weights.
 */
export function scoreRule(title: string): { score: number; reason: string; isHigh: boolean } {
  const { score, matchedHotWords, superHot } = applyScore(title, DEFAULT_HOT_WORD_WEIGHTS);
  const hasNum = /\d+/.test(title);
  const len = title.length;
  return {
    score,
    reason: `热词:${matchedHotWords.length > 0} 超热:${superHot}数字:${hasNum} 长:${len} 多热:${matchedHotWords.length}`,
    isHigh: score >= AI_ROUTE_R_THRESHOLD,
  };
}

// ============================================================
// O11 Feedback Loop: 动态权重评分 (需要 Env 从 DB 读权重)
// ============================================================
/**
 * Score a news title using category-specific dynamic weights from score_rule_weights table.
 * Loads weights via env from Supabase (async).
 *
 * Falls back to DEFAULT_HOT_WORD_WEIGHTS if DB has no entry for the category.
 */
export async function scoreRuleWithWeights(
  title: string,
  category: string,
  env: Env
): Promise<{ score: number; reason: string; isHigh: boolean }> {
  const { loadWeights } = await import('./score-rule-weights');
  const weights = await loadWeights(env, category);
  const { score, matchedHotWords, superHot } = applyScore(title, weights);
  const hasNum = /\d+/.test(title);
  const len = title.length;
  return {
    score,
    reason: `热词:${matchedHotWords.length > 0} 超热:${superHot}数字:${hasNum} 长:${len} 多热:${matchedHotWords.length} [dynamic@${category}]`,
    isHigh: score >= AI_ROUTE_R_THRESHOLD,
  };
}
