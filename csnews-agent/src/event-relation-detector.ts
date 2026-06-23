/**
 * CSNEWS Agent · 事件关系检测 - 主入口
 *
 * 整合 temporal / semantic / causal 三种关系检测
 * 每日 cron 触发一次
 */
import { Env } from './shared';
import { detectTemporalRelations } from './event-temporal-detector';
import { detectSemanticRelations } from './event-semantic-detector';
import { detectCausalRelations } from './event-causal-detector';

export interface RelationDetectionResult {
  temporal: { detected: number; errors: number };
  semantic: { detected: number; errors: number };
  causal: { detected: number; errors: number };
  total: number;
  errors: number;
}

/**
 * 运行全量事件关系检测
 * @param env Env
 * @param semanticThreshold cosine 相似度阈值 (默认 0.7)
 */
export async function runRelationDetection(
  env: Env,
  semanticThreshold = 0.7
): Promise<RelationDetectionResult> {
  console.log('[event-relation-detector] starting relation detection...');

  // 1. Temporal detection
  const temporal = await detectTemporalRelations(env);

  // 2. Semantic detection
  const semantic = await detectSemanticRelations(env, semanticThreshold);

  // 3. Causal detection
  const causal = await detectCausalRelations(env);

  const result: RelationDetectionResult = {
    temporal,
    semantic,
    causal,
    total: temporal.detected + semantic.detected + causal.detected,
    errors: temporal.errors + semantic.errors + causal.errors,
  };

  console.log(`[event-relation-detector] done: temporal=${temporal.detected}, semantic=${semantic.detected}, causal=${causal.detected}, errors=${result.errors}`);

  return result;
}
