// ============================================================
// endpoints-entity.ts · v0.36.22 · entity review 闭环
// 2 个 action handler: entity / event
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - entity: Entity Engine (candidates / selflearn / process / finalized / noise / approve / reject / noise-add / noise-remove)
//   - event: Event Graph (clusters / cluster / process / review / threshold)
// 反爬: 单 IP 60 req/min
// 鉴权: index.ts fetch handler 入口统一 authRequest
// ============================================================

import { Env } from './shared';
import { runEntitySelfLearn, ENTITY_CANDIDATES_R2_KEY } from './entity-selflearn';
import { runEntityProcess, ENTITY_FINALIZED_R2_KEY } from './entity-process';
import {
  ENTITY_NOISE_ANCHORS_R2_KEY,
  loadNoiseAnchors,
  NOISE_THRESHOLD_DEFAULT,
} from './entity-noise-filter';
import {
  runEventProcess,
  EVENT_CLUSTERS_R2_KEY,
  EVENT_CLUSTERS_INDEX_R2_KEY,
} from './event-process';
import { recordReview, loadThresholdHistory, getCurrentThreshold } from './event-threshold';
import { runEventClustering, type EventCluster } from './event-cluster';
import { checkRateLimit, rateLimitResponse, readR2Json } from './utils';

// 反爬限流配置 (跟 content/trend/knowledge handler 命名一致 · 60 req/min per IP · 独立 KV prefix)
// 写死 60 不走 validation 常量: 实体处理器无需独立 validation 文件, 抽常量到本文件顶部即可
const ENTITY_RATE_LIMIT_PER_MIN = 60;
const EVENT_RATE_LIMIT_PER_MIN = 60;

// ===================== entity (Entity Engine) =====================
// 10 档 type:
//   - candidates: 读 R2 entity-candidates.json
//   - selflearn: 触发 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type)
//   - process: 触发 runEntityProcess (暂存 R2 entity-finalized.json)
//   - finalized: 读 R2 entity-finalized.json
//   - noise-anchors: 读 R2 entity-noise-anchors.json
//   - noise: 读 R2 entity-candidates.json 的 noise 分组
//   - approve: 批准候选实体 → 从 R2 entity-candidates.json 移到 entity-finalized.json
//   - reject: 拒绝候选实体 → 从 R2 entity-candidates.json 删除
//   - noise-add: 将某 entity 加入 semantic noise anchors (R2 entity-noise-anchors.json)
//   - noise-remove: 从 noise anchors 移除

// UUID v4 格式校验
function isValidUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

// 读 R2 noise anchors (用于 approve/reject/noise-add/noise-remove 辅助)
async function readNoiseAnchors(
  env: Env
): Promise<{ anchors: string[]; threshold: number; updated_at: string }> {
  return loadNoiseAnchors(env);
}

// 写 R2 noise anchors (atomic rewrite)
async function writeNoiseAnchors(
  env: Env,
  anchors: string[],
  threshold: number
): Promise<void> {
  await env.csnews_raw.put(
    ENTITY_NOISE_ANCHORS_R2_KEY,
    JSON.stringify(
      {
        anchors,
        threshold,
        updated_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

export async function handleEntityAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 输入校验
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
  ];
  if (!validTypes.includes(type)) {
    return new Response(
      JSON.stringify({
        error: 'invalid_type',
        reason: `type 必须是 candidates|selflearn|process|finalized|noise-anchors|noise|approve|reject|noise-add|noise-remove 十选一, 当前 ${type}`,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  // approve/reject/noise-add/noise-remove 需 id 参数
  const id = url.searchParams.get('id');
  if (['approve', 'reject', 'noise-add', 'noise-remove'].includes(type)) {
    if (!id) {
      return new Response(
        JSON.stringify({
          error: 'missing_id',
          reason: 'id 参数必填 (UUID v4)',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    }
    if (!isValidUuidV4(id)) {
      return new Response(
        JSON.stringify({
          error: 'invalid_id',
          reason: 'id 必须是有效 UUID v4 格式',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    }
  }

  // 2. 反爬限流 (单 IP 60 req/min, 独立 KV prefix)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: entityExceeded } = await checkRateLimit(
    env,
    ctx,
    `entity_rate:${ip}`,
    ENTITY_RATE_LIMIT_PER_MIN
  );
  if (entityExceeded) return rateLimitResponse(cors, ENTITY_RATE_LIMIT_PER_MIN);

  // 3. 根据 type 查数据
  if (type === 'candidates') {
    // 读 R2 entity-candidates.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            type: 'candidates',
            description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn, 或自学习 0 候选)',
            candidates: [],
            total: 0,
          }),
          {
            headers: { 'Content-Type': 'application/json', ...cors },
          }
        );
      }
      const json = await obj.json<{
        candidates: any[];
        generated_at: string;
        total_news: number;
      }>();
      return new Response(
        JSON.stringify({
          type: 'candidates',
          description: 'R2 entity-candidates.json 入口',
          generated_at: json.generated_at,
          total_news: json.total_news,
          total: json.candidates?.length || 0,
          candidates: json.candidates || [],
        }),
        {
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'selflearn') {
    // 触发 runEntitySelfLearn (n-gram + bge-m3 + noise filter)
    const result = await runEntitySelfLearn(env);
    return new Response(
      JSON.stringify({
        type: 'selflearn',
        description:
          '跑 runEntitySelfLearn (n-gram 频率 + bge-m3 相似度去重 + 启发式 type + semantic noise filter)',
        total_news: result.total,
        embedded: result.embedded,
        candidates: result.candidates.length,
        noise_filtered: result.noise_filtered,
        noise_anchors_count: result.noise_anchors_count,
        top_candidates: result.candidates.slice(0, 10),
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (type === 'process') {
    // 暂存 R2 entity-finalized.json
    const result = await runEntityProcess(env);
    return new Response(
      JSON.stringify({
        type: 'process',
        description: '暂存 R2 entity-finalized.json, 等 quota-period-out 决策 schema migration',
        finalized: result.finalized,
        written: result.written,
        errors: result.errors,
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (type === 'finalized') {
    // 读 R2 entity-finalized.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_FINALIZED_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            type: 'finalized',
            description: 'R2 entity-finalized.json 不存在 (尚未运行 process)',
            entities: [],
            total: 0,
          }),
          {
            headers: { 'Content-Type': 'application/json', ...cors },
          }
        );
      }
      const json = await obj.json<{ entities: any[]; generated_at: string }>();
      return new Response(
        JSON.stringify({
          type: 'finalized',
          description: 'review 后入库的实体 (R2 entity-finalized.json)',
          generated_at: json.generated_at,
          total: json.entities?.length || 0,
          entities: json.entities || [],
        }),
        {
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise-anchors') {
    // 读 R2 entity-noise-anchors.json
    try {
      const data = await loadNoiseAnchors(env);
      return new Response(
        JSON.stringify({
          type: 'noise-anchors',
          description: 'anchors 增删入口 (R2 entity-noise-anchors.json · 0 硬编码 const)',
          anchors: data.anchors,
          threshold: data.threshold,
          total: data.anchors.length,
          updated_at: data.updated_at,
        }),
        {
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise') {
    // 读 R2 entity-candidates.json 的 noise 分组
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            type: 'noise',
            description: 'R2 entity-candidates.json 不存在 (尚未运行 selflearn)',
            noise: [],
            total: 0,
          }),
          {
            headers: { 'Content-Type': 'application/json', ...cors },
          }
        );
      }
      const json = await obj.json<{
        noise: any[];
        noise_threshold: number;
        noise_anchors_count: number;
        noise_scores: any[];
        generated_at: string;
      }>();
      return new Response(
        JSON.stringify({
          type: 'noise',
          description: 'noise 分组 (review 入口) — review 工作流从打错变成确认正确',
          generated_at: json.generated_at,
          noise_threshold: json.noise_threshold,
          noise_anchors_count: json.noise_anchors_count,
          total: json.noise?.length || 0,
          noise: json.noise || [],
          noise_scores: json.noise_scores || [],
        }),
        {
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  // ----- 新增 review 闭环 4 档 type -----

  if (type === 'approve') {
    // 批准候选实体 → 从 R2 entity-candidates.json 移到 entity-finalized.json
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 不存在 (id=${id})`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const json = await obj.json<{
        candidates: any[];
        generated_at: string;
        total_news: number;
        noise_threshold: number;
        noise_anchors_count: number;
        noise: any[];
        noise_scores: any[];
      }>();

      const candidates = json.candidates || [];
      const idx = candidates.findIndex((c) => c.uuid === id);
      if (idx === -1) {
        // 候选实体不在 candidates 里，查 noise 分组
        const noiseIdx = (json.noise || []).findIndex((n) => n.uuid === id);
        if (noiseIdx !== -1) {
          return new Response(
            JSON.stringify({
              error: 'entity_in_noise',
              reason: `该实体 (id=${id}) 在 noise 分组, 请先 noise-add 再 approve`,
            }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 中找不到 id=${id}`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      // 从 candidates 数组移除 (splice in-place)
      const [approved] = candidates.splice(idx, 1);

      // 追加到 finalized.json (原子读写: 先读后写)
      let finalizedEntities: any[] = [];
      try {
        const finalizedObj = await env.csnews_raw.get(ENTITY_FINALIZED_R2_KEY);
        if (finalizedObj) {
          const finalizedJson = await finalizedObj.json<{ entities: any[] }>();
          finalizedEntities = finalizedJson.entities || [];
        }
      } catch {
        // finalized.json 不存在则从空开始
      }

      finalizedEntities.push({
        uuid: approved.uuid,
        name: approved.name,
        type: approved.type,
        confidence: approved.confidence,
        source: 'review',
        first_seen: approved.first_seen,
        last_seen: new Date().toISOString(),
        mention_count: 1,
      });

      // 原子重写 candidates.json (移除已批准)
      await env.csnews_raw.put(
        ENTITY_CANDIDATES_R2_KEY,
        JSON.stringify(
          {
            generated_at: json.generated_at,
            total_news: json.total_news,
            noise_threshold: json.noise_threshold,
            noise_anchors_count: json.noise_anchors_count,
            candidates,
            noise: json.noise || [],
            noise_scores: json.noise_scores || [],
          },
          null,
          2
        )
      );

      // 原子重写 finalized.json
      await env.csnews_raw.put(
        ENTITY_FINALIZED_R2_KEY,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            entities: finalizedEntities,
          },
          null,
          2
        )
      );

      // 重算聚类
      await runEventProcess(env);

      return new Response(
        JSON.stringify({
          type: 'approve',
          description: '批准候选实体并写入 R2 entity-finalized.json',
          approved: { uuid: approved.uuid, name: approved.name, type: approved.type },
          candidates_remaining: candidates.length,
        }),
        { headers: { 'Content-Type': 'application/json', ...cors } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_write_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'reject') {
    // 拒绝候选实体 → 从 R2 entity-candidates.json 删除
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 不存在 (id=${id})`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const json = await obj.json<{
        candidates: any[];
        generated_at: string;
        total_news: number;
        noise_threshold: number;
        noise_anchors_count: number;
        noise: any[];
        noise_scores: any[];
      }>();

      const candidates = json.candidates || [];
      const idx = candidates.findIndex((c) => c.uuid === id);
      if (idx === -1) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 中找不到 id=${id}`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      const [rejected] = candidates.splice(idx, 1);

      // 原子重写 candidates.json (移除已拒绝)
      await env.csnews_raw.put(
        ENTITY_CANDIDATES_R2_KEY,
        JSON.stringify(
          {
            generated_at: json.generated_at,
            total_news: json.total_news,
            noise_threshold: json.noise_threshold,
            noise_anchors_count: json.noise_anchors_count,
            candidates,
            noise: json.noise || [],
            noise_scores: json.noise_scores || [],
          },
          null,
          2
        )
      );

      // 重算聚类
      await runEventProcess(env);

      return new Response(
        JSON.stringify({
          type: 'reject',
          description: '拒绝候选实体并从 R2 entity-candidates.json 删除',
          rejected: { uuid: rejected.uuid, name: rejected.name },
          candidates_remaining: candidates.length,
        }),
        { headers: { 'Content-Type': 'application/json', ...cors } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_write_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise-add') {
    // 将某 entity 加入 semantic noise anchors
    // id = entity uuid, 需从 candidates/noise 里找到该 entity 的 name
    try {
      const obj = await env.csnews_raw.get(ENTITY_CANDIDATES_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 不存在 (id=${id})`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const json = await obj.json<{
        candidates: any[];
        noise: any[];
      }>();

      // 在 candidates 或 noise 里找该 uuid
      const allEntities = [...(json.candidates || []), ...(json.noise || [])];
      const entity = allEntities.find((e) => e.uuid === id);
      if (!entity) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-candidates.json 中找不到 id=${id}`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      // 读 noise anchors
      const noiseData = await readNoiseAnchors(env);

      // 重复检查
      if (noiseData.anchors.includes(entity.name)) {
        return new Response(
          JSON.stringify({
            type: 'noise-add',
            description: '该实体 name 已存在于 noise anchors, 无需重复添加',
            name: entity.name,
            anchors_count: noiseData.anchors.length,
          }),
          { headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      const newAnchors = [...noiseData.anchors, entity.name];
      await writeNoiseAnchors(env, newAnchors, noiseData.threshold);

      // 重算聚类
      await runEventProcess(env);

      return new Response(
        JSON.stringify({
          type: 'noise-add',
          description: '将实体 name 加入 R2 entity-noise-anchors.json',
          name: entity.name,
          anchors_count: newAnchors.length,
        }),
        { headers: { 'Content-Type': 'application/json', ...cors } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_write_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'noise-remove') {
    // 从 noise anchors 移除
    try {
      const noiseData = await readNoiseAnchors(env);
      const idx = noiseData.anchors.indexOf(id!); // id 参数是 anchor name (非 uuid)
      if (idx === -1) {
        return new Response(
          JSON.stringify({
            error: 'entity_not_found',
            reason: `R2 entity-noise-anchors.json 中找不到 name=${id}`,
          }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      const newAnchors = [...noiseData.anchors];
      newAnchors.splice(idx, 1);
      await writeNoiseAnchors(env, newAnchors, noiseData.threshold);

      // 重算聚类
      await runEventProcess(env);

      return new Response(
        JSON.stringify({
          type: 'noise-remove',
          description: '从 R2 entity-noise-anchors.json 移除',
          removed: id,
          anchors_remaining: newAnchors.length,
        }),
        { headers: { 'Content-Type': 'application/json', ...cors } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_write_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  // unreachable
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
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
  // 1. 输入校验
  const type = url.searchParams.get('type') || 'clusters';
  const validTypes = ['clusters', 'cluster', 'process', 'review', 'threshold'];
  if (!validTypes.includes(type)) {
    return new Response(
      JSON.stringify({
        error: 'invalid_type',
        reason: `type 必须是 clusters|cluster|process|review|threshold 五选一, 当前 ${type}`,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  // 2. 反爬限流 (单 IP 60 req/min)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded: eventExceeded } = await checkRateLimit(
    env,
    ctx,
    `event_rate:${ip}`,
    EVENT_RATE_LIMIT_PER_MIN
  );
  if (eventExceeded) return rateLimitResponse(cors, EVENT_RATE_LIMIT_PER_MIN);

  // 3. 根据 type 处理
  if (type === 'clusters') {
    // 读 R2 event-clusters.json
    try {
      const obj = await env.csnews_raw.get(EVENT_CLUSTERS_R2_KEY);
      if (!obj) {
        return new Response(
          JSON.stringify({
            type: 'clusters',
            description: 'R2 event-clusters.json 不存在 (尚未运行 cluster 或 process)',
            clusters: [],
            total: 0,
          }),
          {
            headers: { 'Content-Type': 'application/json', ...cors },
          }
        );
      }
      const json = await obj.json<{
        clusters: EventCluster[];
        threshold: number;
        generated_at: string;
      }>();
      return new Response(
        JSON.stringify({
          type: 'clusters',
          description: 'R2 event-clusters.json 入口',
          generated_at: json.generated_at,
          threshold: json.threshold,
          total: json.clusters?.length || 0,
          clusters: json.clusters || [],
        }),
        {
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'r2_read_failed', reason: e?.message || e }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  }

  if (type === 'cluster') {
    // 跑 runEventClustering (实时)
    const entities = await (await import('./entity-process')).loadReviewedCandidates(env);
    const result = await runEventClustering(env, entities);
    return new Response(
      JSON.stringify({
        type: 'cluster',
        description: '跑 runEventClustering (Jaccard entity_overlap + threshold 自适应)',
        threshold: result.threshold,
        jaccard_pairs: result.jaccard_pairs,
        total: result.clusters.length,
        clusters: result.clusters,
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (type === 'process') {
    // 暂存 R2 event-clusters.json
    const result = await runEventProcess(env);
    return new Response(
      JSON.stringify({
        type: 'process',
        description: '暂存 R2 event-clusters.json, 等 quota-period-out 决策 schema migration',
        clusters: result.clusters,
        threshold: result.threshold,
        written: result.written,
        errors: result.errors,
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (type === 'review') {
    // review 反馈 → threshold 自动微调 (闭环)
    const review = url.searchParams.get('review') || 'correct';
    const clusterId = url.searchParams.get('cluster_id') || undefined;
    const reason = url.searchParams.get('reason') || undefined;

    if (review !== 'correct' && review !== 'incorrect') {
      return new Response(
        JSON.stringify({
          error: 'invalid_review',
          reason: `review 必须是 correct|incorrect 二选一, 当前 ${review}`,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    }

    const updated = await recordReview(env, review, clusterId, reason);
    return new Response(
      JSON.stringify({
        type: 'review',
        description: 'review 反馈 → threshold 自动微调 (闭环)',
        review,
        old_threshold: updated.history[updated.history.length - 1]?.old_value,
        new_threshold: updated.current,
        history_length: updated.history.length,
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (type === 'threshold') {
    // 读 threshold history
    const history = await loadThresholdHistory(env);
    return new Response(
      JSON.stringify({
        type: 'threshold',
        description: 'review 反馈驱动的 threshold 调优历史',
        current: history.current,
        history_length: history.history.length,
        history: history.history,
        updated_at: history.updated_at,
      }),
      {
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  // unreachable
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
