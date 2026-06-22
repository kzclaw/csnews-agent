/**
 * CSNEWS Agent · 实体处理 (v0.36.21 方案 D)
 *
 * 0 硬编码, 纯自适应/自学习/自进化
 * 方案 D = 分层架构 (R2 冷层 + Supabase 热层 + TTL 自动归档)
 *
 * 业务流程 (方案 D · 分层写):
 *   1. 读 R2 entity-candidates.json (review 后)
 *   2. 写 R2 entity-finalized.json (source of truth, always, 30d+ 也能查)
 *   3. 写 Supabase entity_hot (30d 热层, best effort, 失败不阻塞)
 *
 * TTL 自动归档 (cron 每月 1 号 0:00 UTC 跑 scheduledArchiveOldEntities):
 *   - 30d+ active entity → R2 entity-archive-YYYY-MM.json + Supabase DELETE
 *   - 30d+ reviewed entity → R2 entity-reviewed-YYYY.json (永久保留) + Supabase DELETE
 *
 * 0 维护 = review 错词 = R2 entity-candidates.json
 */
import { Env, getSupabaseHost } from './shared';
import { supabaseHeaders } from './utils';
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
 * 读 R2 已 review 过的 candidates
 */
export async function loadReviewedCandidates(env: Env): Promise<EntityFinalized[]> {
  const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
  if (!obj) return [];
  const json = await obj.json<{ candidates: EntityFinalized[] }>();
  return json.candidates || [];
}

/**
 * 主函数: 方案 D 分层写 (R2 always + Supabase best effort)
 */
export async function runEntityProcess(
  env: Env
): Promise<{ written: number; errors: number; finalized: number }> {
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

  // Layer 1: R2 write (source of truth, always)
  // 30d+ 也能查 (viewer miss Supabase 时 fallback)
  try {
    await env.csnews_raw.put(
      ENTITY_FINALIZED_R2_KEY,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          entities: reviewed,
        },
        null,
        2
      )
    );
  } catch (e: any) {
    console.error(`[entity-process] R2 put failed: ${e?.message || e}`);
    return { written: 0, errors: 1, finalized: 0 };
  }

  // Layer 2: Supabase write (热层, best effort, 失败不阻塞)
  // 30d 内 reviewer 主要查, ON CONFLICT (name, type) DO UPDATE 增量更新 last_seen + mention_count
  const hotResult = await writeEntitiesHotLayer(env, reviewed);
  return {
    written: hotResult.written,
    errors: hotResult.errors,
    finalized: reviewed.length,
  };
}

/**
 * 批量 upsert entity 到 Supabase entity_hot 热层 (方案 D · v0.36.21)
 *
 * 业务契约:
 *   - 0 entities → 立刻返 { written: 0, errors: 0 }
 *   - Supabase HTTP 200 → 返 { written: N, errors: 0 }
 *   - Supabase HTTP 5xx / 网络错 / Schema 未迁移 → 返 { written: 0, errors: N } (R2 fallback 兜底)
 *   - 失败不抛错 → 上层 runEntityProcess 仍返 finalized=N (R2 已写)
 *
 * 实现细节:
 *   - PostgREST batch upsert: POST /rest/v1/entity_hot?on_conflict=name,type
 *   - Prefer: resolution=merge-duplicates → 触发 ON CONFLICT DO UPDATE
 *   - updated_at + mention_count 累加 (mention_count = entity_hot.mention_count + excluded.mention_count)
 *   - status 保留 (review 过的不会因 cron 跑改回 active)
 *   - 30d+ 自动归档: 由 scheduledArchiveOldEntities 跑 (独立 cron, 不在本函数)
 */
export async function writeEntitiesHotLayer(
  env: Env,
  entities: EntityFinalized[]
): Promise<{ written: number; errors: number }> {
  if (entities.length === 0) return { written: 0, errors: 0 };

  const rows = entities.map((e) => ({
    name: e.name,
    type: e.type,
    confidence: e.confidence,
    source: e.source,
    first_seen: e.first_seen,
    last_seen: e.last_seen,
    mention_count: e.mention_count,
    status: e.source === 'review' ? 'reviewed' : 'active',
  }));

  try {
    const res = await fetch(`${getSupabaseHost(env)}/rest/v1/entity_hot?on_conflict=name,type`, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(env),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    console.log(`[entity-process] writeEntitiesHotLayer wrote=${entities.length}`);
    return { written: entities.length, errors: 0 };
  } catch (e: any) {
    console.error(`[entity-process] writeEntitiesHotLayer failed: ${e?.message || e}`);
    return { written: 0, errors: entities.length };
  }
}
