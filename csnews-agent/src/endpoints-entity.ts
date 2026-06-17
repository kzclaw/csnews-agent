// ============================================================
// endpoints-entity.ts · v0.36.20 · csnews-audit 修复
// 2 个 action handler: entity / event
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - entity: Entity Engine (candidates / selflearn / process / finalized / noise)
//   - event: Event Graph (clusters / cluster / process / review / threshold)
// 反爬: 单 IP 60 req/min
// 鉴权: index.ts fetch handler 入口统一 authRequest
// ============================================================

import { Env } from './shared';
import { runEntitySelfLearn, ENTITY_CANDIDATES_R2_KEY } from './entity-selflearn';
import { runEntityProcess, ENTITY_FINALIZED_R2_KEY } from './entity-process';
import { ENTITY_NOISE_ANCHORS_R2_KEY, loadNoiseAnchors, NOISE_THRESHOLD_DEFAULT } from './entity-noise-filter';
import { runEventProcess, EVENT_CLUSTERS_R2_KEY, EVENT_CLUSTERS_INDEX_R2_KEY } from './event-process';
import { recordReview, loadThresholdHistory, getCurrentThreshold } from './event-threshold';
import { runEventClustering, type EventCluster } from './event-cluster';
import { checkRateLimit, rateLimitResponse, readR2Json } from './utils';

// ===================== entity (Entity Engine) =====================
// 6 档 type:
//   - candidates: 读 R2 entity-candidates.json
//   - selflearn: 触发 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type)
//   - process: 触发 runEntityProcess (暂存 R2 entity-finalized.json)
//   - finalized: 读 R2 entity-finalized.json
//   - noise-anchors: 读 R2 entity-noise-anchors.json
//   - noise: 读 R2 entity-candidates.json 的 noise 分组
export async function handleEntityAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验
  const type = url.searchParams.get('type') || 'candidates';
  const validTypes = ['candidates', 'selflearn', 'process', 'finalized', 'noise-anchors', 'noise'];
  if (!validTypes.includes(type)) {
    return new Response(JSON.stringify({
      error: 'invalid_type',
      reason: `type 必须是 candidates|selflearn|process|finalized|noise-anchors|noise 六选一, 当前 ${type}`,
    }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: entityExceeded } = await checkRateLimit(env, ctx, `entity_rate:${ip}`, 60);
  if (entityExceeded) return rateLimitResponse(cors, 60);

  // 3. 根据 type 查数据
  if (type === 'candidates') {
    // 读 R2 entity-candidates.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'candidates',
          description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn, 或自学习 0 候选)',
          candidates: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ candidates: any[]; generated_at: string; total_news: number }>();
      return new Response(JSON.stringify({
        type: 'candidates',
        description: 'R2 entity-candidates.json 入口',
        generated_at: json.generated_at,
        total_news: json.total_news,
        total: json.candidates?.length || 0,
        candidates: json.candidates || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'selflearn') {
    // 触发 runEntitySelfLearn (n-gram + bge-m3 + noise filter)
    const result = await runEntitySelfLearn(env);
    return new Response(JSON.stringify({
      type: 'selflearn',
      description: '跑 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type + semantic noise filter)',
      total_news: result.total,
      embedded: result.embedded,
      candidates: result.candidates.length,
      noise_filtered: result.noise_filtered,
      noise_anchors_count: result.noise_anchors_count,
      top_candidates: result.candidates.slice(0, 10),
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'process') {
    // 暂存 R2 entity-finalized.json
    const result = await runEntityProcess(env);
    return new Response(JSON.stringify({
      type: 'process',
      description: '暂存 R2 entity-finalized.json, 等 quota-period-out 决策 schema migration',
      finalized: result.finalized,
      written: result.written,
      errors: result.errors,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'finalized') {
    // 读 R2 entity-finalized.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_FINALIZED_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'finalized',
          description: 'R2 entity-finalized.json 不存在 (尚未运行 process)',
          entities: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ entities: any[]; generated_at: string }>();
      return new Response(JSON.stringify({
        type: 'finalized',
        description: 'review 后入库的实体 (R2 entity-finalized.json)',
        generated_at: json.generated_at,
        total: json.entities?.length || 0,
        entities: json.entities || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise-anchors') {
    // 读 R2 entity-noise-anchors.json
    try {
      const data = await loadNoiseAnchors(env);
      return new Response(JSON.stringify({
        type: 'noise-anchors',
        description: 'anchors 增删入口 (R2 entity-noise-anchors.json · 0 硬编码 const)',
        anchors: data.anchors,
        threshold: data.threshold,
        total: data.anchors.length,
        updated_at: data.updated_at,
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise') {
    // 读 R2 entity-candidates.json 的 noise 分组
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'noise',
          description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn)',
          noise: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ noise: any[]; noise_threshold: number; noise_anchors_count: number; noise_scores: any[]; generated_at: string }>();
      return new Response(JSON.stringify({
        type: 'noise',
        description: 'noise 分组 (review 入口) — review 工作流从打错变成确认正确',
        generated_at: json.generated_at,
        noise_threshold: json.noise_threshold,
        noise_anchors_count: json.noise_anchors_count,
        total: json.noise?.length || 0,
        noise: json.noise || [],
        noise_scores: json.noise_scores || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  // unreachable
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500, headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ===================== event (Event Graph) =====================
// 5 档 type:
//   - clusters: 读 R2 event-clusters.json
//   - cluster: 跑 runEventClustering (Jaccard + threshold 自适应)
//   - process: 跑 runEventProcess (暂存 R2)
//   - review: review 错/对 → threshold 自动微调 (±0.05)
//   - threshold: 读 threshold history
export async function handleEventAction(request: Request, env: Env, url: URL, cors: Record<string, string>, ctx: ExecutionContext): Promise<Response> {
  // 1. 输入校验
  const type = url.searchParams.get('type') || 'clusters';
  const validTypes = ['clusters', 'cluster', 'process', 'review', 'threshold'];
  if (!validTypes.includes(type)) {
    return new Response(JSON.stringify({
      error: 'invalid_type',
      reason: `type 必须是 clusters|cluster|process|review|threshold 五选一, 当前 ${type}`,
    }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 2. 反爬限流 (单 IP 60 req/min)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: eventExceeded } = await checkRateLimit(env, ctx, `event_rate:${ip}`, 60);
  if (eventExceeded) return rateLimitResponse(cors, 60);

  // 3. 根据 type 处理
  if (type === 'clusters') {
    // 读 R2 event-clusters.json
    try {
      const obj = await env.csnews_raw.get(EVENT_CLUSTERS_R2_KEY);
      if (!obj) {
        return new Response(JSON.stringify({
          type: 'clusters',
          description: 'R2 event-clusters.json 不存在 (尚未运行 cluster 或 process)',
          clusters: [],
          total: 0,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const json = await obj.json<{ clusters: EventCluster[]; threshold: number; generated_at: string }>();
      return new Response(JSON.stringify({
        type: 'clusters',
        description: 'R2 event-clusters.json 入口',
        generated_at: json.generated_at,
        threshold: json.threshold,
        total: json.clusters?.length || 0,
        clusters: json.clusters || [],
      }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'cluster') {
    // 跑 runEventClustering (实时)
    const entities = await (await import('./entity-process')).loadReviewedCandidates(env);
    const result = await runEventClustering(env, entities);
    return new Response(JSON.stringify({
      type: 'cluster',
      description: '跑 runEventClustering (Jaccard entity_overlap + threshold 自适应)',
      threshold: result.threshold,
      jaccard_pairs: result.jaccard_pairs,
      total: result.clusters.length,
      clusters: result.clusters,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'process') {
    // 暂存 R2 event-clusters.json
    const result = await runEventProcess(env);
    return new Response(JSON.stringify({
      type: 'process',
      description: '暂存 R2 event-clusters.json, 等 quota-period-out 决策 schema migration',
      clusters: result.clusters,
      threshold: result.threshold,
      written: result.written,
      errors: result.errors,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'review') {
    // review 反馈 → threshold 自动微调 (闭环)
    const review = url.searchParams.get('review') || 'correct';
    const clusterId = url.searchParams.get('cluster_id') || undefined;
    const reason = url.searchParams.get('reason') || undefined;

    if (review !== 'correct' && review !== 'incorrect') {
      return new Response(JSON.stringify({
        error: 'invalid_review',
        reason: `review 必须是 correct|incorrect 二选一, 当前 ${review}`,
      }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const updated = await recordReview(env, review, clusterId, reason);
    return new Response(JSON.stringify({
      type: 'review',
      description: 'review 反馈 → threshold 自动微调 (闭环)',
      review,
      old_threshold: updated.history[updated.history.length - 1]?.old_value,
      new_threshold: updated.current,
      history_length: updated.history.length,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (type === 'threshold') {
    // 读 threshold history
    const history = await loadThresholdHistory(env);
    return new Response(JSON.stringify({
      type: 'threshold',
      description: 'review 反馈驱动的 threshold 调优历史',
      current: history.current,
      history_length: history.history.length,
      history: history.history,
      updated_at: history.updated_at,
    }), {
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // unreachable
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500, headers: { 'Content-Type': 'application/json', ...cors },
  });
}
