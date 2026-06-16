/**
 * CSNEWS Agent · 实体处理 (v0.36.11)
 *
 * kzclaw 16:28 确定: 0 硬编码, 纯自适应/自学习/自进化
 * kzclaw 16:33 确定推 · 0 DDL = entity 表暂存 R2, 待kzclaw 5h 配额期外拍 schema migration
 *
 * 业务流程:
 *   1. 读 R2 entity-candidates.json (kzclaw review 后)
 *   2. 启发式 type 推断 (已内联到 entity-selflearn)
 *   3. 暂存 R2 entity-finalized.json (kzclaw 5h 配额期外拍 schema migration 后写 Supabase)
 *
 * kzclaw 0 维护 = review 错词 = R2 entity-candidates.json
 * kzclaw 0 DDL 5h 配额期外 = entity 表 schema 拍后启用 writeEntitiesToSupabase
 */
import { Env } from './shared';
import { ENTITY_CANDIDATES_R2_KEY, type EntityCandidate } from './entity-selflearn';

export const ENTITY_FINALIZED_R2_KEY = 'entity-finalized.json';

export interface EntityFinalized {
  name: string;
  type: 'person' | 'org' | 'place';
  confidence: number;
  source: 'selflearn' | 'review';
  first_seen: string;
  last_seen: string;
  mention_count: number;
}

/**
 * 读 R2 已kzclaw review 过的 candidates
 */
export async function loadReviewedCandidates(env: Env): Promise<EntityFinalized[]> {
  const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
  if (!obj) return [];
  const json = await obj.json<{ candidates: EntityFinalized[] }>();
  return json.candidates || [];
}

/**
 * 主函数: kzclaw 5h 配额期外 16:33 实施 (entity 表暂存 R2)
 */
export async function runEntityProcess(env: Env): Promise<{ written: number; errors: number; finalized: number }> {
  let reviewed: EntityFinalized[] = [];
  try {
    reviewed = await loadReviewedCandidates(env);
  } catch (e: any) {
    console.error(`[entity-process] loadReviewedCandidates failed: ${e?.message || e}`);
    return { written: 0, errors: 1, finalized: 0 };
  }

  if (reviewed.length === 0) {
    return { written: 0, errors: 0, finalized: 0 };
  }

  try {
    // kzclaw 0 DDL 5h 配额期外 = entity 表暂存 R2 entity-finalized.json
    // kzclaw 5h 配额期外拍 schema migration 后启用 writeEntitiesToSupabase
    await env.csnews_raw.put(ENTITY_FINALIZED_R2_KEY, JSON.stringify({
      generated_at: new Date().toISOString(),
      entities: reviewed,
    }, null, 2));
    return { written: 0, errors: 0, finalized: reviewed.length };
  } catch (e: any) {
    console.error(`[entity-process] R2 put failed: ${e?.message || e}`);
    return { written: 0, errors: 1, finalized: 0 };
  }
}
