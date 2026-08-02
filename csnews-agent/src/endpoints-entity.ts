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

import { Env, jsonResponse } from './shared';
import type { EntityType } from './types';
import { runEntitySelfLearn, ENTITY_CANDIDATES_R2_KEY } from './entity-selflearn';
import { logEvent } from './log';
import { runEntityProcess, ENTITY_FINALIZED_R2_KEY } from './entity-process';
import { loadNoiseAnchors, saveNoiseAnchors } from './entity-noise-filter';
import { runEventProcess, EVENT_CLUSTERS_R2_KEY } from './event-process';
import { recordReview, loadThresholdHistory } from './event-threshold';
import { runEventClustering, type EventCluster } from './event-cluster';
import {
  checkRateLimit,
  rateLimitResponse,
  readR2JsonOrNull,
  readCandidatesJson,
  writeCandidatesJson,
} from './utils';

// 反爬限流配置 (跟 content/trend/knowledge handler 命名一致 · 60 req/min per IP · 独立 KV prefix)
// 写死 60 不走 validation 常量: 实体处理器无需独立 validation 文件, 抽常量到本文件顶部即可
const ENTITY_RATE_LIMIT_PER_MIN = 60;
const EVENT_RATE_LIMIT_PER_MIN = 60;

// ===================== entity (Entity Engine) =====================
// 11 档 type:
//   - candidates: 读 R2 entity-candidates.json
//   - selflearn: 触发 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type)
//   - process: 触发 runEntityProcess (暂存 R2 entity-finalized.json)
//   - finalized: 读 R2 entity-finalized.json
//   - noise-anchors: 读 R2 entity-noise-anchors.json
//   - noise: 读 R2 entity-candidates.json 的 noise 分组
//   - approve: review 批准 entity → 触发 event re-clustering
//   - reject: review 拒绝 entity → 触发 event re-clustering
//   - noise-add: review 标记为 noise → 触发 event re-clustering
//   - noise-remove: review 取消 noise 标记 → 触发 event re-clustering
//   - reclassify: review 手动改实体 type (person/org/place/time/concept) → 触发 event re-clustering
// ===================== entity review actions (auto re-clustering) =====================
const triggerEventRecluster = async (env: Env): Promise<void> => {
  try {
    await runEventProcess(env);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await logEvent(
      env,
      'error',
      `[handleEntityAction] event re-clustering failed: ${msg}`,
      undefined,
      'entity'
    );
  }
};

// Helper: find entity in candidates/noise, apply mutations, write back, re-cluster
// Eliminates duplicate boilerplate from approve / reject / noise-add / noise-remove
async function applyEntityReviewMutation(
  env: Env,
  entityName: string,
  cors: Record<string, string>,
  opts: {
    findMode: 'either' | 'noise' | 'candidates';
    mutate: (json: { candidates: any[]; noise: any[] }) => { candidates: any[]; noise: any[] };
    errorIfNotFound: string;
    successType: string;
    successDescription: string;
  }
): Promise<Response> {
  const json = await readCandidatesJson(env);
  const inNoise = json.noise?.findIndex((e: any) => e.name === entityName) ?? -1;
  const inCandidates = json.candidates?.findIndex((e: any) => e.name === entityName) ?? -1;

  const found =
    opts.findMode === 'either'
      ? inNoise >= 0 || inCandidates >= 0
      : opts.findMode === 'noise'
        ? inNoise >= 0
        : inCandidates >= 0;

  if (!found) {
    return jsonResponse({ error: 'not_found', reason: opts.errorIfNotFound }, cors, {
      status: 404,
    });
  }

  const { candidates: newCandidates, noise: newNoise } = opts.mutate(json);
  await writeCandidatesJson(env, { ...json, candidates: newCandidates, noise: newNoise });
  triggerEventRecluster(env).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[entity] triggerEventRecluster failed: ${msg}`);
  });

  return jsonResponse(
    {
      type: opts.successType,
      description: opts.successDescription,
      entity: entityName,
      reclustering: 'triggered',
    },
    cors
  );
}

// ---- entity read-only handlers (shared R2 read pattern) ----
async function entityReadHandler(
  env: Env,
  type: string,
  cors: Record<string, string>
): Promise<Response> {
  try {
    if (type === 'candidates') {
      const json = await readR2JsonOrNull<{
        candidates: any[];
        generated_at: string;
        total_news: number;
      }>(env, ENTITY_CANDIDATES_R2_KEY);
      if (!json)
        return jsonResponse(
          {
            type,
            description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn, 或自学习 0 候选)',
            candidates: [],
            total: 0,
          },
          cors
        );
      return jsonResponse(
        {
          type,
          description: 'R2 entity-candidates.json 入口',
          generated_at: json.generated_at,
          total_news: json.total_news,
          total: json.candidates?.length || 0,
          candidates: json.candidates || [],
        },
        cors
      );
    }
    if (type === 'finalized') {
      const json = await readR2JsonOrNull<{ entities: any[]; generated_at: string }>(
        env,
        ENTITY_FINALIZED_R2_KEY
      );
      if (!json)
        return jsonResponse(
          {
            type,
            description: 'R2 entity-finalized.json 不存在 (尚未运行 process)',
            entities: [],
            total: 0,
          },
          cors
        );
      return jsonResponse(
        {
          type,
          description: 'review 后入库的实体 (R2 entity-finalized.json)',
          generated_at: json.generated_at,
          total: json.entities?.length || 0,
          entities: json.entities || [],
        },
        cors
      );
    }
    if (type === 'noise') {
      const json = await readR2JsonOrNull<{
        noise: any[];
        noise_threshold: number;
        noise_anchors_count: number;
        noise_scores: any[];
        generated_at: string;
      }>(env, ENTITY_CANDIDATES_R2_KEY);
      if (!json)
        return jsonResponse(
          {
            type,
            description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn)',
            noise: [],
            total: 0,
          },
          cors
        );
      return jsonResponse(
        {
          type,
          description: 'noise 分组 (review 入口)',
          generated_at: json.generated_at,
          noise_threshold: json.noise_threshold,
          noise_anchors_count: json.noise_anchors_count,
          total: json.noise?.length || 0,
          noise: json.noise || [],
          noise_scores: json.noise_scores || [],
        },
        cors
      );
    }
    return jsonResponse({ error: 'internal_error' }, cors, { status: 500 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: 'r2_read_failed', reason: msg }, cors, {
      status: 500,
    });
  }
}

export async function handleEntityAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  const type = url.searchParams.get('type') || 'candidates';
  const validTypes = [
    'candidates',
    'selflearn',
    'process',
    'finalized',
    'noise-anchors',
    'noise',
    'approve',
    'reject',
    'noise-add',
    'noise-remove',
    'reclassify',
  ];
  if (!validTypes.includes(type)) {
    return jsonResponse(
      {
        error: 'invalid_type',
        reason: `type 必须是 candidates|selflearn|process|finalized|noise-anchors|noise|approve|reject|noise-add|noise-remove|reclassify 十一选一, 当前 ${type}`,
      },
      cors,
      { status: 400 }
    );
  }

  // 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded } = await checkRateLimit(
    env,
    ctx,
    `entity_rate:${ip}`,
    ENTITY_RATE_LIMIT_PER_MIN
  );
  if (exceeded) return rateLimitResponse(cors, ENTITY_RATE_LIMIT_PER_MIN);

  // Read-only handlers (R2 read via readR2JsonOrNull)
  if (type === 'candidates' || type === 'finalized' || type === 'noise') {
    return entityReadHandler(env, type, cors);
  }

  // Process triggers
  if (type === 'selflearn') {
    const result = await runEntitySelfLearn(env);
    return jsonResponse(
      {
        type: 'selflearn',
        description:
          '跑 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type + semantic noise filter)',
        total_news: result.total,
        embedded: result.embedded,
        candidates: result.candidates.length,
        noise_filtered: result.noise_filtered,
        noise_anchors_count: result.noise_anchors_count,
        top_candidates: result.candidates.slice(0, 10),
      },
      cors
    );
  }

  if (type === 'process') {
    const result = await runEntityProcess(env);
    return jsonResponse(
      {
        type: 'process',
        description: '暂存 R2 entity-finalized.json, 等 quota-period-out 决策 schema migration',
        finalized: result.finalized,
        written: result.written,
        errors: result.errors,
      },
      cors
    );
  }

  if (type === 'noise-anchors') {
    try {
      const data = await loadNoiseAnchors(env);
      return jsonResponse(
        {
          type: 'noise-anchors',
          description: 'anchors 增删入口 (R2 entity-noise-anchors.json · 0 硬编码 const)',
          anchors: data.anchors,
          threshold: data.threshold,
          total: data.anchors.length,
          updated_at: data.updated_at,
        },
        cors
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ error: 'r2_read_failed', reason: msg }, cors, {
        status: 500,
      });
    }
  }

  // Review mutations (all share readCandidatesJson + writeCandidatesJson + triggerEventRecluster)
  const entityName = url.searchParams.get('name');
  if (!entityName) {
    return jsonResponse({ error: 'missing_param', reason: 'name 是必填参数' }, cors, {
      status: 400,
    });
  }

  if (type === 'approve') {
    return applyEntityReviewMutation(env, entityName, cors, {
      findMode: 'either',
      mutate: (json) => {
        const inNoise = json.noise?.findIndex((e: any) => e.name === entityName) ?? -1;
        const inCandidates = json.candidates?.findIndex((e: any) => e.name === entityName) ?? -1;
        // 2026-07-03 UX fix: approve 后 从 candidates/noise 移除 (user 不 再 想看)
        // 之前 buggy 行为: map 跟 push,  保留 在 candidates 列表 · user 采纳后 仍 显示 同 名字
        // 现在 改: inNoise < 0 (典型 candidate case) → filter 移除; inNoise >= 0 (noise case) → 推回 candidates (作为 approved 实体)
        const noiseEntry = inNoise >= 0 && json.noise ? json.noise[inNoise] : null;
        return {
          candidates:
            inNoise >= 0 && noiseEntry
              ? [
                  ...(json.candidates?.filter((_: any, i: number) => i !== inCandidates) || []),
                  {
                    name: entityName,
                    type: noiseEntry.type,
                    confidence: 0.9,
                    source: 'review' as const,
                    first_seen: noiseEntry.first_seen,
                    last_seen: new Date().toISOString(),
                    mention_count: noiseEntry.mention_count || 1,
                  },
                ]
              : json.candidates?.filter((_: any, i: number) => i !== inCandidates) || [],
          noise:
            inNoise >= 0 ? json.noise?.filter((_: any, i: number) => i !== inNoise) : json.noise,
        };
      },
      errorIfNotFound: `实体 "${entityName}" 不存在`,
      successType: 'approve',
      successDescription: 'review 批准 entity → 触发 event re-clustering',
    });
  }

  if (type === 'reject') {
    return applyEntityReviewMutation(env, entityName, cors, {
      findMode: 'either',
      mutate: (json) => {
        const rejInCandidates = json.candidates?.findIndex((e: any) => e.name === entityName) ?? -1;
        const rejInNoise = json.noise?.findIndex((e: any) => e.name === entityName) ?? -1;
        return {
          candidates: json.candidates?.filter((_: any, i: number) => i !== rejInCandidates) || [],
          noise: json.noise?.filter((_: any, i: number) => i !== rejInNoise) || [],
        };
      },
      errorIfNotFound: `实体 "${entityName}" 不存在`,
      successType: 'reject',
      successDescription: 'review 拒绝 entity → 触发 event re-clustering',
    });
  }

  if (type === 'noise-add') {
    const json = await readCandidatesJson(env);
    const inCandidates = json.candidates.findIndex((e: any) => e.name === entityName);
    const inNoise = json.noise.findIndex((e: any) => e.name === entityName);
    if (inCandidates === -1)
      return jsonResponse({ error: 'not_found', reason: `候选实体 "${entityName}" 不存在` }, cors, {
        status: 404,
      });
    if (inNoise >= 0)
      return jsonResponse(
        { error: 'already_noise', reason: `实体 "${entityName}" 已在 noise 列表` },
        cors,
        { status: 409 }
      );
    // 2026-07-03 UX fix: noise-add 同步 写入 entity-noise-anchors.json.anchors
    // 之前 buggy 行为: 只 写 candidates.noise 数组,  但 viewer 底部 "噪音词 Anchors" panel 是 从 entity-noise-anchors.json 读
    // → user 添加 noise 后 底部 看不 到新增 · 跟 Bug 2 一致
    // 现在 改: 从 candidates 移除 + 写 entity-noise-anchors.json (底部 panel 看到) + 保留 candidates.noise 旧 行为 (算法 用)
    await writeCandidatesJson(env, {
      ...json,
      candidates: json.candidates.filter((_: any, i: number) => i !== inCandidates),
      noise: [
        ...(json.noise || []),
        {
          ...json.candidates[inCandidates],
          first_seen: json.candidates[inCandidates].first_seen || new Date().toISOString(),
        },
      ],
    });
    // 同步 写入 entity-noise-anchors.json.anchors (user 看到 底部 panel 新增)
    const anchorsData = await loadNoiseAnchors(env);
    if (!anchorsData.anchors.includes(entityName)) {
      anchorsData.anchors.push(entityName);
      anchorsData.updated_at = new Date().toISOString();
      await saveNoiseAnchors(env, anchorsData);
    }
    triggerEventRecluster(env).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[entity] triggerEventRecluster failed: ${msg}`);
    });
    return jsonResponse(
      {
        type: 'noise-add',
        description: 'review 标记 entity 为 noise → 触发 event re-clustering + 同步 写入 anchors',
        entity: entityName,
        reclustering: 'triggered',
      },
      cors
    );
  }

  if (type === 'noise-remove') {
    // 2026-07-03 UX fix: 先 check entity-noise-anchors.json.anchors (底部 ✕ 按钮 entry point)
    // 之前 buggy 行为: 只 check candidates.noise 数组,  user 点 底部 ✕ 报 NOT_FOUND (Bug 3)
    // 现在 改:
    //   1. 先 check entity-noise-anchors.json.anchors (底部 panel 来源) → 找到 则 从 anchors 移除 + 加回 candidates
    //   2. fall back check candidates.noise (旧 路径) → 找到 则 恢复 candidates
    //   3. 都没 找到 → 404

    // 1. check entity-noise-anchors.json.anchors
    const anchorsData = await loadNoiseAnchors(env);
    const inAnchors = anchorsData.anchors.indexOf(entityName);
    if (inAnchors >= 0) {
      anchorsData.anchors = anchorsData.anchors.filter((_, i) => i !== inAnchors);
      anchorsData.updated_at = new Date().toISOString();
      await saveNoiseAnchors(env, anchorsData);
      // 同步 恢复 到 candidates (user 可 重新 审核)
      const json = await readCandidatesJson(env);
      const inCandidates = json.candidates?.findIndex((e: any) => e.name === entityName) ?? -1;
      if (inCandidates === -1) {
        // candidates 还没 该 实体 · 重新 加入 minimal entry (selflearn 重 run 时会 补充 full data)
        await writeCandidatesJson(env, {
          ...json,
          candidates: [
            ...(json.candidates || []),
            {
              name: entityName,
              type: 'unknown',
              confidence: 0.5,
              source: 'selflearn',
              first_seen: new Date().toISOString(),
            },
          ],
        });
      }
      triggerEventRecluster(env).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[entity] triggerEventRecluster failed: ${msg}`);
      });
      return jsonResponse(
        {
          type: 'noise-remove',
          description: 'review 取消 noise 标记 (from anchors) → 触发 event re-clustering',
          entity: entityName,
          reclustering: 'triggered',
        },
        cors
      );
    }

    // 2. fall back: check candidates.noise (auto-detected noise)
    const json = await readCandidatesJson(env);
    const inNoise = json.noise?.findIndex((e: any) => e.name === entityName) ?? -1;
    if (inNoise === -1)
      return jsonResponse(
        { error: 'not_found', reason: `noise 列表中没有 "${entityName}"` },
        cors,
        { status: 404 }
      );
    const restoredEntity = { ...json.noise[inNoise], source: 'selflearn', confidence: 0.5 };
    await writeCandidatesJson(env, {
      ...json,
      noise: json.noise.filter((_: any, i: number) => i !== inNoise),
      candidates: [...(json.candidates || []), restoredEntity],
    });
    triggerEventRecluster(env).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[entity] triggerEventRecluster failed: ${msg}`);
    });
    return jsonResponse(
      {
        type: 'noise-remove',
        description: 'review 取消 noise 标记 (from candidates.noise) → 触发 event re-clustering',
        entity: entityName,
        reclustering: 'triggered',
      },
      cors
    );
  }

  // v0.37.87: 手动改实体 type (纠正 inferEntityType 误判, 如 "8月" 误归 person → 改 time)
  // 复用 applyEntityReviewMutation (findMode either: candidates / noise 都能改)
  // noise 中的实体改 type 后移回 candidates (用户手动改分类 = 认为该实体有价值, 不该留在噪音区)
  if (type === 'reclassify') {
    const newType = url.searchParams.get('newType');
    const validNewTypes: EntityType[] = ['person', 'org', 'place', 'time', 'concept'];
    if (!newType || !(validNewTypes as string[]).includes(newType)) {
      return jsonResponse(
        {
          error: 'invalid_type',
          reason: `newType 必须是 person|org|place|time|concept 五选一, 当前 ${newType || '(空)'}`,
        },
        cors,
        { status: 400 }
      );
    }
    return applyEntityReviewMutation(env, entityName, cors, {
      findMode: 'either',
      mutate: (json) => {
        const inCandidates = json.candidates?.findIndex((e: any) => e.name === entityName) ?? -1;
        const inNoise = json.noise?.findIndex((e: any) => e.name === entityName) ?? -1;
        const reclassifyOne = (e: any) => ({
          ...e,
          type: newType,
          last_seen: new Date().toISOString(),
        });
        return {
          candidates:
            inCandidates >= 0
              ? json.candidates.map((e: any, i: number) =>
                  i === inCandidates ? reclassifyOne(e) : e
                )
              : inNoise >= 0 && json.noise
                ? [...(json.candidates || []), reclassifyOne(json.noise[inNoise])]
                : json.candidates || [],
          noise: inNoise >= 0 ? json.noise?.filter((_: any, i: number) => i !== inNoise) : json.noise,
        };
      },
      errorIfNotFound: `实体 "${entityName}" 不存在`,
      successType: 'reclassify',
      successDescription: `review 手动改实体 type 为 ${newType} → 触发 event re-clustering`,
    });
  }

  return jsonResponse({ error: 'internal_error' }, cors, { status: 500 });
}

// ===================== event (Event Graph) =====================
// 5 档 type:
//   - clusters: 读 R2 event-clusters.json
//   - cluster: 跑 runEventClustering (Jaccard + threshold 自适应)
//   - process: 跑 runEventProcess (暂存 R2)
//   - review: review 错/对 → threshold 自动微调 (±0.05)
//   - threshold: 读 threshold history
export async function handleEventAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  const type = url.searchParams.get('type') || 'clusters';
  const validTypes = ['clusters', 'cluster', 'process', 'review', 'threshold'];
  if (!validTypes.includes(type)) {
    return jsonResponse(
      {
        error: 'invalid_type',
        reason: `type 必须是 clusters|cluster|process|review|threshold 五选一, 当前 ${type}`,
      },
      cors,
      { status: 400 }
    );
  }

  // 反爬限流 (单 IP 60 req/min)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded } = await checkRateLimit(env, ctx, `event_rate:${ip}`, EVENT_RATE_LIMIT_PER_MIN);
  if (exceeded) return rateLimitResponse(cors, EVENT_RATE_LIMIT_PER_MIN);

  if (type === 'clusters') {
    try {
      const json = await readR2JsonOrNull<{
        clusters: EventCluster[];
        threshold: number;
        generated_at: string;
      }>(env, EVENT_CLUSTERS_R2_KEY);
      if (!json)
        return jsonResponse(
          {
            type: 'clusters',
            description: 'R2 event-clusters.json 不存在 (尚未运行 cluster 或 process)',
            clusters: [],
            total: 0,
          },
          cors
        );
      return jsonResponse(
        {
          type: 'clusters',
          description: 'R2 event-clusters.json 入口',
          generated_at: json.generated_at,
          threshold: json.threshold,
          total: json.clusters?.length || 0,
          clusters: json.clusters || [],
        },
        cors
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ error: 'r2_read_failed', reason: msg }, cors, {
        status: 500,
      });
    }
  }

  if (type === 'cluster') {
    const entities = await (await import('./entity-process')).loadReviewedCandidates(env);
    const result = await runEventClustering(env, entities);
    return jsonResponse(
      {
        type: 'cluster',
        description: '跑 runEventClustering (Jaccard entity_overlap + threshold 自适应)',
        threshold: result.threshold,
        jaccard_pairs: result.jaccard_pairs,
        total: result.clusters.length,
        clusters: result.clusters,
      },
      cors
    );
  }

  if (type === 'process') {
    const result = await runEventProcess(env);
    return jsonResponse(
      {
        type: 'process',
        description: '暂存 R2 event-clusters.json, 等 quota-period-out 决策 schema migration',
        clusters: result.clusters,
        threshold: result.threshold,
        written: result.written,
        errors: result.errors,
      },
      cors
    );
  }

  if (type === 'review') {
    const review = url.searchParams.get('review') || 'correct';
    const clusterId = url.searchParams.get('cluster_id') || undefined;
    const reason = url.searchParams.get('reason') || undefined;
    if (review !== 'correct' && review !== 'incorrect') {
      return jsonResponse(
        {
          error: 'invalid_review',
          reason: `review 必须是 correct|incorrect 二选一, 当前 ${review}`,
        },
        cors,
        { status: 400 }
      );
    }
    const updated = await recordReview(env, review, clusterId, reason);
    return jsonResponse(
      {
        type: 'review',
        description: 'review 反馈 → threshold 自动微调 (闭环)',
        review,
        old_threshold: updated.history[updated.history.length - 1]?.old_value,
        new_threshold: updated.current,
        history_length: updated.history.length,
      },
      cors
    );
  }

  if (type === 'threshold') {
    const history = await loadThresholdHistory(env);
    return jsonResponse(
      {
        type: 'threshold',
        description: 'review 反馈驱动的 threshold 调优历史',
        current: history.current,
        history_length: history.history.length,
        history: history.history,
        updated_at: history.updated_at,
      },
      cors
    );
  }

  return jsonResponse({ error: 'internal_error' }, cors, { status: 500 });
}
