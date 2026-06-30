// ============================================================
// endpoints-core.ts · v0.36.20 · csnews-audit 修复
// 12 个核心 action handler (pull / ping / model-test / ai-test / score /
// classify / batch-score / fission / save / list / embed / zaker-hot)
//
// 从 endpoints.ts 拆出 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长)
//
// 业务契约:
//   - 所有 handler 接收 (request, env, url, cors) 返回 Response
//   - CORS 头复用 auth.ts corsHeaders (跟 endpoints.ts 模式一致)
//   - 错误处理: catch → JSON { error: e.message }, status 500
// ============================================================

import { Env, getSupabaseHost, jsonResponse } from './shared';
import { NewsItem } from './types';
import { supabaseHeaders } from './utils';
import { handlePull } from './pull';
import { classify, classifyRule } from './classify';
import { classifyBySemantic, batchClassifyBySemantic } from './category-classify';
import { loadCategorySeeds, addSeedToCategory, removeSeedFromCategory } from './category-seeds';
import { scoreRule, AI_ROUTE_R_THRESHOLD } from './score';
import { insertNewsHotspot } from './news-process';
import { extractText, maybeFissionReport } from './utils';
import { shouldTriggerAiCall } from './ai-budget';
import type {
  LlamaAIResponse,
  BgeEmbeddingResponse,
  ZakerHotResponse,
  NewsHotspotRow,
} from './types';

// ===================== pull =====================

const CACHE_HEADERS: Record<string, string> = {
  news: 'public, max-age=120',
  topics: 'public, max-age=300',
  warnings: 'no-store',
  'fission-pending': 'public, max-age=60',
  stats: 'public, max-age=60',
};

export async function handlePullAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const result = await handlePull(env, url, ctx);
    const cacheControl = CACHE_HEADERS[result.type] || 'no-store';
    return jsonResponse(result, cors, { headers: { 'Cache-Control': cacheControl } });
  } catch (e: any) {
    const status = e.status || 500;
    return jsonResponse({ error: e.message || 'pull failed' }, cors, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

// ===================== ping =====================
export async function handlePingAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  return jsonResponse({ ok: true, ts: Date.now() }, cors);
}

// ===================== model-test =====================
// 注: extractText + maybeFissionReport 已抽到 utils.ts (避免循环依赖)
// 兜底: env.AI.run() 异常 (模型未启用 / quota 超 / 临时网络) 需降级而非 500
// 跟同文件 handleFissionAction (line 316) / utils.ts maybeFissionReport (line 44) try/catch 模式一致
export async function handleModelTestAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  // Phase 2 budget check (L2 AI 评分 · model-test 诊断 endpoint · 永远 allowed
  // per shouldTriggerAiCall design 但保留 hook 跟 utils.ts maybeFissionReport 一致)
  if (!(await shouldTriggerAiCall(env, 'L2'))) {
    return jsonResponse(
      { error: 'AI budget exceeded for L2', model: 'llama-3.1-8b-instruct-fp8' },
      cors,
      { status: 503 }
    );
  }
  try {
    // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
    // 模型: @cf/meta/llama-3.1-8b-instruct-fp8 (8B fp8 量化 · 替代已 deprecated 的 llama-3-8b-instruct)
    const r = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [{ role: 'user', content: '说一段话介绍自己' }],
      max_tokens: 100,
    })) as LlamaAIResponse;
    return jsonResponse(
      { ok: true, model: 'llama-3.1-8b-instruct-fp8', response: extractText(r).substring(0, 200) },
      cors
    );
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}

// ===================== ai-test =====================
export async function handleAiTestAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const title = url.searchParams.get('title') || 'OpenAI发布GPT-5,AI行业迎来新一轮革命';
  const report = await maybeFissionReport(title, env, 9.0); // test always uses high score
  return jsonResponse({ title, report }, cors);
}

// ===================== score =====================
export async function handleScoreAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const title = url.searchParams.get('title');
  if (!title) {
    return jsonResponse({ error: 'missing title param' }, cors, { status: 400 });
  }

  const rule = scoreRule(title);
  const category = await classify(title, env);
  const useAI = url.searchParams.get('ai') !== 'false';
  let aiReport = '';

  if (useAI) {
    aiReport = await maybeFissionReport(title, env, rule.score);
  }

  return jsonResponse(
    { title, score: rule.score, category, reason: rule.reason, ai_report: aiReport },
    cors
  );
}

// ===================== classify =====================
// 5 档 type:
//   - default / type=classify: 跑 bge-m3 semantic 自分类
//   - type=seeds: 读 R2 category-seeds.json
//   - type=add-seed: R2 持久化加 seed
//   - type=remove-seed: R2 持久化删 seed
//   - type=review: 自进化闭环 (分类错 review → seeds 自动更新)
export async function handleClassifyAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const type = url.searchParams.get('type') || 'classify';

  if (type === 'classify') {
    const title = url.searchParams.get('title');
    if (!title) {
      return jsonResponse({ error: 'missing title param' }, cors, { status: 400 });
    }
    const result = await classifyBySemantic(title, env);
    const kwCat = classifyRule(title);
    return jsonResponse(
      {
        title,
        type: 'classify',
        description: 'bge-m3 semantic 自分类',
        category: result.category,
        confidence: result.confidence,
        top_scores: result.top_scores,
        legacy_keyword_category: kwCat,
      },
      cors
    );
  }

  if (type === 'seeds') {
    const data = await loadCategorySeeds(env);
    return jsonResponse(
      {
        type: 'seeds',
        description: 'category seeds 增删入口 (R2 category-seeds.json · 0 硬编码 const)',
        categories: data.categories,
        updated_at: data.updated_at,
        updated_count: data.updated_count,
        total_categories: Object.keys(data.categories).length,
        total_seeds: Object.values(data.categories).reduce((sum, seeds) => sum + seeds.length, 0),
      },
      cors
    );
  }

  if (type === 'add-seed') {
    const category = url.searchParams.get('category');
    const seed = url.searchParams.get('seed');
    if (!category || !seed) {
      return jsonResponse({ error: 'missing category or seed param' }, cors, { status: 400 });
    }
    const data = await addSeedToCategory(env, category, seed);
    return jsonResponse(
      {
        type: 'add-seed',
        description: 'R2 持久化加 seed',
        category,
        seed,
        updated_count: data.updated_count,
        updated_at: data.updated_at,
      },
      cors
    );
  }

  if (type === 'remove-seed') {
    const category = url.searchParams.get('category');
    const seed = url.searchParams.get('seed');
    if (!category || !seed) {
      return jsonResponse({ error: 'missing category or seed param' }, cors, { status: 400 });
    }
    const data = await removeSeedFromCategory(env, category, seed);
    return jsonResponse(
      {
        type: 'remove-seed',
        description: 'R2 持久化删 seed',
        category,
        seed,
        updated_count: data.updated_count,
        updated_at: data.updated_at,
      },
      cors
    );
  }

  if (type === 'review') {
    const title = url.searchParams.get('title');
    const correctCategory = url.searchParams.get('correct_category');
    if (!title || !correctCategory) {
      return jsonResponse({ error: 'missing title or correct_category param' }, cors, {
        status: 400,
      });
    }
    const data = await addSeedToCategory(env, correctCategory, title);
    return jsonResponse(
      {
        type: 'review',
        description: '自进化闭环: 分类错 review → seeds 自动更新',
        title,
        correct_category: correctCategory,
        updated_count: data.updated_count,
        updated_at: data.updated_at,
      },
      cors
    );
  }

  return jsonResponse(
    {
      error: 'invalid_type',
      reason: `type 必须是 classify|seeds|add-seed|remove-seed|review 五选一, 当前 ${type}`,
    },
    cors,
    { status: 400 }
  );
}

// ===================== batch-score =====================
export async function handleBatchScoreAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  let body: { items: NewsItem[]; use_ai?: boolean } | null = null;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, cors, { status: 400 });
  }

  const items = body?.items || [];
  const useAI = body?.use_ai !== false;

  const results = await Promise.all(
    items.map(async (item) => {
      const rule = scoreRule(item.title);
      // optional summary, batch endpoint 调用方传才生效
      const category = await classify(item.title, env, item.summary);
      let aiReport = '';
      if (useAI) {
        aiReport = await maybeFissionReport(item.title, env, rule.score);
      }
      return {
        title: item.title,
        score: rule.score,
        category,
        reason: rule.reason,
        ai_report: aiReport,
      };
    })
  );

  return jsonResponse({ count: results.length, results }, cors);
}

// ===================== fission =====================
export async function handleFissionAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const seed = url.searchParams.get('seed') || url.searchParams.get('title');
  if (!seed) {
    return jsonResponse({ error: 'missing seed param' }, cors, { status: 400 });
  }
  const r = scoreRule(seed);
  if (r.score < AI_ROUTE_R_THRESHOLD) {
    return jsonResponse(
      {
        seed,
        queries: [],
        count: 0,
        skipped: true,
        reason: `R=${r.score} < ${AI_ROUTE_R_THRESHOLD}, AI跳过`,
      },
      cors
    );
  }
  // Phase 2 budget check (L5 裂变搜索 LLM · 真实 budget 控制 · 阈值 < shutdown 8K)
  if (!(await shouldTriggerAiCall(env, 'L5'))) {
    return jsonResponse(
      {
        seed,
        queries: [],
        count: 0,
        skipped: true,
        reason: 'AI budget exceeded for L5 (shutdown threshold)',
      },
      cors
    );
  }
  try {
    // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
    // 模型: @cf/meta/llama-3.1-8b-instruct-fp8 (8B fp8 · 替代 deprecated 的 llama-3-8b-instruct)
    const resp = (await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'user',
          content: `生成5个深度裂变搜索查询词(每个不超过15字),用|分隔:\n新闻:${seed}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    })) as LlamaAIResponse;
    const text = extractText(resp);
    const queries = text
      .split('|')
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && q.length <= 20);
    return jsonResponse({ seed, queries, count: queries.length }, cors);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}

// ===================== save =====================
export async function handleSaveAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const title = url.searchParams.get('title') || '';
  const category = url.searchParams.get('category') || '综合';
  const score = parseFloat(url.searchParams.get('score') || '5');
  const source = url.searchParams.get('source') || 'zaker';

  if (!title) {
    return jsonResponse({ error: 'missing title' }, cors, { status: 400 });
  }

  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = { id, title, category, score, source, created_at: new Date().toISOString() };
    const key = `news/${source}/${id}.json`;
    await env.csnews_raw.put(key, JSON.stringify(item), {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonResponse({ ok: true, key, item }, cors);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}

// ===================== list =====================
export async function handleListAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const prefix = url.searchParams.get('prefix') || 'news/zaker/';
  // 支持 ?limit=N (默认50, 上限200) 和 ?order=desc|asc (默认 desc, R2 list 默认字典序是 asc)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const order = (url.searchParams.get('order') || 'desc').toLowerCase();
  const list = await env.csnews_raw.list({ prefix });
  // R2 list() 不支持 order, 必须客户端排序
  const sorted = [...list.objects].sort((a, b) =>
    order === 'desc' ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)
  );
  const items = await Promise.all(
    sorted.slice(0, limit).map(async (obj) => {
      const body = await env.csnews_raw.get(obj.key);
      const text = await body?.text();
      try {
        return JSON.parse(text || '{}');
      } catch {
        return { key: obj.key };
      }
    })
  );
  return jsonResponse(
    {
      count: items.length,
      total: list.objects.length,
      truncated: list.objects.length > limit,
      order,
      items,
    },
    cors
  );
}

// ===================== embed =====================
export async function handleEmbedAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  const text = url.searchParams.get('text') || url.searchParams.get('title') || '';
  if (!text) {
    return jsonResponse({ error: 'missing text param' }, cors, { status: 400 });
  }

  // Phase 2 budget check (L3 bge-m3 embedding · 永远 allowed per shouldTriggerAiCall
  // design · 保留 hook 跟设计文档 L1-L3 全开对齐 + 未来切 model 留入口)
  if (!(await shouldTriggerAiCall(env, 'L3'))) {
    return jsonResponse({ error: 'AI budget exceeded for L3', model: '@cf/baai/bge-m3' }, cors, {
      status: 503,
    });
  }

  try {
    // env.AI.run() 运行时才解析 Workers AI 动态响应，形状不静态确定
    const resp = (await env.AI.run('@cf/baai/bge-m3', {
      text: [text],
    })) as BgeEmbeddingResponse;

    // bge-m3 返回格式: { shape: [n, dim], data: [...], response: string }
    const raw = resp as BgeEmbeddingResponse;
    let embedding: number[] = [];
    if (Array.isArray(raw?.data) && raw.data.length > 0) {
      const item = raw.data[0];
      if (Array.isArray(item?.embedding)) embedding = item.embedding;
      else if (Array.isArray(item)) embedding = item;
    }

    if (!embedding || embedding.length === 0) {
      return jsonResponse(
        { error: 'embedding empty', shape: raw?.shape, keys: raw ? Object.keys(raw) : [] },
        cors,
        { status: 500 }
      );
    }

    // 存 R2
    const key = `embeddings/${Date.now()}.json`;
    await env.csnews_raw.put(
      key,
      JSON.stringify({ text, embedding, dim: embedding.length, model: 'bge-m3' }),
      {
        httpMetadata: { contentType: 'application/json' },
      }
    );

    return jsonResponse(
      { text, dim: embedding.length, model: '@cf/baai/bge-m3', sample: embedding.slice(0, 5), key },
      cors
    );
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}

// ===================== zaker-hot =====================
export async function handleZakerHotAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>
): Promise<Response> {
  try {
    const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3', {
      signal: AbortSignal.timeout(10_000), // 10s 超时 (audit 4.3 安全审计)
    });
    // Zaker 外部三方 API 响应形状不归我们控制，保持 ZakerHotResponse 接口
    const json = (await r.json()) as ZakerHotResponse;
    const list: any[] = json?.data?.list || [];
    const results = [];

    for (const item of list.slice(0, 1)) {
      const title = item.title || '';
      if (!title) continue;

      const rule = scoreRule(title);
      // 传 item.summary 让 title+summary 混合 → 减少边界样本错位率
      const category = await classify(title, env, item.summary);

      // 跳过向量化和 R2, 只测 Supabase 写入
      await insertNewsHotspot(env, {
        title,
        url: item.url || '',
        source: 'zaker',
        category,
        hot_score: rule.score,
        published_at: item.publish_time || new Date().toISOString(),
        summary: (item.summary || '').substring(0, 200),
      });

      results.push({ title, category, score: rule.score });
    }

    return jsonResponse({ count: results.length, items: results }, cors);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}

// ===================== rescore =====================
// 批量重跑旧新闻分类
// 读 news_hotspots (分页处理 Supabase 1000 行/页限制), 用 batchClassifyBySemantic 算新分类,
// PATCH 写回 Supabase. dry_run 默认 true 防误操作.
export async function handleRescoreAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // 默认 dry_run=true (返统计, 不 UPDATE), 显式 dry_run=false 才 UPDATE
    const dryRun = url.searchParams.get('dry_run') !== 'false';
    // 默认 limit=100 (防止超时), limit=0 表示全部 (2,394+ 条)
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    // offset 用于分页 (PostgREST 默认 1000 行/页), 调用方可手动翻页
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // 1. 读 news_hotspots (分页)
    // Supabase PostgREST 单次 1000 行上限, 用 Range header 或 offset 翻页
    const effectiveLimit = limit > 0 ? limit : 1000;
    const effectiveOffset = offset > 0 ? offset : 0;
    const newsRes = await fetch(
      `${getSupabaseHost(env)}/rest/v1/news_hotspots?select=id,title,summary,category&order=created_at.desc`,
      {
        headers: {
          ...supabaseHeaders(env),
          'Range-Unit': 'items',
          Range: `${effectiveOffset}-${effectiveOffset + effectiveLimit - 1}`,
          Prefer: 'count=exact',
        },
      }
    );
    if (!newsRes.ok) {
      const errText = await newsRes.text();
      return jsonResponse({ error: 'supabase_read_failed', reason: errText.slice(0, 200) }, cors, {
        status: 500,
      });
    }
    const newsList = (await newsRes.json()) as NewsHotspotRow[];
    if (newsList.length === 0) {
      return jsonResponse(
        { type: 'rescore', total: 0, dry_run: dryRun, message: 'no news to rescore' },
        cors
      );
    }

    // 2. 准备 input texts (title + summary 混合, 跟新分类逻辑一致)
    const inputTexts = newsList.map((n) => `${n.title || ''} ${n.summary || ''}`.trim());
    // 3. 分批跑 batchClassifyBySemantic (Workers AI 上下文 60K token 上限, 全量 2,394 条超限)
    //    每批 300 条 ≈ 24K tokens (title 30-50 + summary 200 字 ≈ 80 tokens/条)
    const CHUNK_SIZE = 300;
    const batchResults: Array<{ category: string; confidence: number }> = [];
    for (let i = 0; i < inputTexts.length; i += CHUNK_SIZE) {
      const chunk = inputTexts.slice(i, i + CHUNK_SIZE);
      try {
        const chunkResults = await batchClassifyBySemantic(chunk, env);
        batchResults.push(...chunkResults);
      } catch (e: any) {
        // 单批失败: 用综合兜底, 不阻塞其他批
        for (let j = 0; j < chunk.length; j++) {
          batchResults.push({ category: '综合', confidence: 0 });
        }
      }
    }

    // 4. 对比新旧分类, 统计 changed / unchanged
    const diffs: any[] = [];
    let changed = 0,
      unchanged = 0,
      errors = 0;
    for (let i = 0; i < newsList.length; i++) {
      const n = newsList[i];
      const r = batchResults[i] || { category: '综合', confidence: 0 };
      const oldCat = n.category || '';
      const newCat = r.category;
      const isChanged = oldCat !== newCat;
      if (isChanged) changed++;
      else unchanged++;
      diffs.push({
        id: n.id,
        title: n.title,
        old: oldCat,
        new: newCat,
        confidence: r.confidence.toFixed(3),
        changed: isChanged,
      });
    }

    // 5. UPDATE (only if not dry_run)
    // 用 ctx.waitUntil 异步跑, 避免 CF Workers 单次 invocation 50 subrequests 上限
    // (574 PATCHes × 1 subrequest = 574 > 50)
    let updated = 0,
      updateErrors = 0;
    const errorSamples: string[] = [];
    let mode = dryRun ? 'preview' : 'started_async';
    if (!dryRun && ctx && typeof ctx.waitUntil === 'function') {
      const diffsToUpdate = diffs.filter((d) => d.changed);
      // 异步 UPDATE: 30 PATCHes/批, 不阻塞响应
      ctx.waitUntil(
        (async () => {
          const PATCH_BATCH = 30;
          for (let i = 0; i < diffsToUpdate.length; i += PATCH_BATCH) {
            const batch = diffsToUpdate.slice(i, i + PATCH_BATCH);
            for (const d of batch) {
              try {
                const patchRes = await fetch(
                  `${getSupabaseHost(env)}/rest/v1/news_hotspots?id=eq.${d.id}`,
                  {
                    method: 'PATCH',
                    headers: {
                      ...supabaseHeaders(env),
                      'Content-Type': 'application/json',
                      Prefer: 'return=representation',
                    },
                    body: JSON.stringify({ category: d.new }),
                  }
                );
                if (patchRes.ok) {
                  updated++;
                } else {
                  updateErrors++;
                  if (errorSamples.length < 3) {
                    const errText = await patchRes.text();
                    errorSamples.push(`${patchRes.status}: ${errText.slice(0, 150)}`);
                  }
                }
              } catch (e: any) {
                updateErrors++;
                if (errorSamples.length < 3) {
                  errorSamples.push(`exception: ${e?.message || e}`);
                }
              }
            }
          }
        })()
      );
    } else if (!dryRun) {
      mode = 'failed_no_ctx';
      errorSamples.push('ctx.waitUntil not available; cannot run async update');
    }

    return jsonResponse(
      {
        type: 'rescore',
        mode,
        dry_run: dryRun,
        total: newsList.length,
        changed,
        unchanged,
        errors,
        updated: dryRun ? 0 : updated,
        update_errors: dryRun ? 0 : updateErrors,
        error_samples: errorSamples.length > 0 ? errorSamples : undefined,
        sample: diffs.slice(0, 5),
        timestamp: new Date().toISOString(),
      },
      cors
    );
  } catch (e: any) {
    return jsonResponse({ error: e.message }, cors, { status: 500 });
  }
}
