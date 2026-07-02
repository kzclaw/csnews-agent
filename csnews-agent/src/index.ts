/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 */

import type {
  AiTextResponse,
  AiEmbeddingResponse,
  ZakerHotResponse,
  ZakerHotItem,
  CleanupStaleResult,
  SimilarNewsItem,
  UpdateTopicScoreResult,
  TrendSnapshotResult,
  TopicRecord,
} from './types-supabase';
import { dispatchAction } from './dispatch';
import { jsonResponse } from './shared';
import { logEvent } from './log';
import {
  scheduledProcess,
  scheduledEntity,
  scheduledArchiveOldEntities,
  scheduledFeedback,
  scheduledReset,
} from './scheduled';
interface Env {
  AI: Ai;
  csnews_raw: R2Bucket;
  BEARER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  /**
   * Worker 自身的公开 URL。
   */
  WORKER_SELF_URL: string;
  /**
   * Worker 版本标识 (例如 "v0.37.20").
   * v0.37.20 (CEO 拍板): 版本号来源改成 wrangler.toml [vars] WORKER_VERSION 字段
   * 直接读 env.WORKER_VERSION. 顶层 .husky/pre-commit hook 自动 bump tag
   * (commit 后 wrangler.toml 字段值 == tag 名 == HEAD commit, 永不漂移).
   * 删 v0.37.17 KV 注入路径 (token 缺 KV Write 权限, 路径走不通).
   */
  WORKER_VERSION?: string;
  /**
   * KV namespace 存 AI Neurons 用量 (Phase 1).
   */
  AI_USAGE_KV?: KVNamespace;
  /**
   * AI 预算阈值 env vars (Phase 1).
   */
  AI_BUDGET_DAILY_LIMIT?: number;
  AI_BUDGET_WARNING_THRESHOLD?: number;
  AI_BUDGET_CRITICAL_THRESHOLD?: number;
  AI_BUDGET_SHUTDOWN_THRESHOLD?: number;
}

function getSupabaseHost(env: Env) {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}

// Supabase fetch wrapper
async function supabaseFetch(env: Env, path: string, options?: RequestInit) {
  const res = await fetch(`${getSupabaseHost(env)}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  return res;
}

// 安全的 JSON 解析
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text || !text.trim()) return null; // 空响应返回 null 而非 {}
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ====== News Self Growth 核心逻辑 ======

// 清理过期话题簇(跟进7天/重要14天/爆炸28天)
async function cleanupStaleTopics(env: Env): Promise<CleanupStaleResult> {
  const raw = (await (
    await supabaseFetch(env, '/rest/v1/rpc/cleanup_stale_topics', {
      method: 'POST',
    })
  ).json()) as unknown as { data: CleanupStaleResult[] } | null;
  if (!raw) return { deleted_topic_count: 0, deleted_news_count: 0 };
  return raw.data?.[0] ?? { deleted_topic_count: 0, deleted_news_count: 0 };
}

// 向量查重:查相似新闻
async function findSimilarNews(
  env: Env,
  embedding: number[],
  threshold = 0.88,
  matchCount = 5
): Promise<SimilarNewsItem[]> {
  const res = await supabaseFetch(env, '/rest/v1/rpc/find_similar_news', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: embedding, threshold, match_count: matchCount }),
  });
  const data = (await safeJson(res)) as unknown as SimilarNewsItem[];
  return data || [];
}

// 更新话题簇积分
async function updateTopicScore(
  env: Env,
  topicId: string,
  delta = 1
): Promise<UpdateTopicScoreResult> {
  const res = await supabaseFetch(env, '/rest/v1/rpc/update_topic_score', {
    method: 'POST',
    body: JSON.stringify({ p_topic_id: topicId, p_score_delta: delta }),
  });
  const data = (await safeJson(res)) as unknown as UpdateTopicScoreResult[];
  return (
    data?.[0] ?? { new_score: 0, new_level: 'follow', upgraded: false, fission_triggered: false }
  );
}

// 记录 TIE-lite 趋势快照并按规则触发 warning，不调用 LLM
async function recordTrendSnapshot(env: Env, topicId: string): Promise<TrendSnapshotResult | null> {
  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/record_trend_snapshot', {
      method: 'POST',
      body: JSON.stringify({ p_topic_id: topicId }),
    });
    const data = (await safeJson(res)) as unknown as TrendSnapshotResult[];
    return Array.isArray(data) ? (data[0] ?? null) : null;
  } catch {
    return null;
  }
}

// 插入话题簇
async function createTopic(
  env: Env,
  topicKey: string,
  level = 'follow',
  firstNewsId?: string
): Promise<TopicRecord> {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await supabaseFetch(env, '/rest/v1/topics', {
    method: 'POST',
    body: JSON.stringify({ id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId }),
  });
  return { id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId };
}

// 插入新闻记录
async function insertNewsHotspot(
  env: Env,
  news: {
    title: string;
    url?: string;
    source?: string;
    category?: string;
    hot_score?: number;
    published_at?: string;
    summary?: string;
    embedding?: number[];
    r2_key?: string;
    topic_id?: string;
    level?: string;
    score?: number;
    is_stored_r2?: boolean;
  }
): Promise<string | null> {
  // 生成确定性 UUID(基于 title + timestamp),避免响应体被 Cloudflare 截断
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newsWithId = { id, ...news };
  await supabaseFetch(env, '/rest/v1/news_hotspots', {
    method: 'POST',
    body: JSON.stringify(newsWithId),
  });
  return id;
}

// 关联新闻-话题
async function joinTopicMember(
  env: Env,
  newsId: string,
  topicId: string,
  role = 'follow'
): Promise<boolean> {
  const res = await supabaseFetch(env, '/rest/v1/news_topic_members', {
    method: 'POST',
    body: JSON.stringify({ news_id: newsId, topic_id: topicId, role }),
    headers: { Prefer: 'return=representation' },
  });
  const raw = await res.text();
  return !!(raw && raw.trim() && raw !== '[]');
}

// R2 存储(去重存储层)
async function saveToR2(env: Env, prefix: string, data: object): Promise<string> {
  const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await env.csnews_raw.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return key;
}

// 简单字符串哈希(用于 topic_key 生成)
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
}

// ============================================================
// 安全中间件
// ============================================================
function authRequest(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (token !== env.BEARER_TOKEN) {
    return jsonResponse({ error: 'Unauthorized' }, {}, { status: 401 });
  }
  return null;
}

function corsHeaders(origin?: string | null) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ============================================================
// 规则引擎分类
// ============================================================
const CATEGORY_KW: Record<string, string[]> = {
  科技: [
    '技术发布',
    '算法突破',
    '开源',
    '漏洞修复',
    '系统升级',
    '产品迭代',
    '发布会',
    '数字化',
    '智能化',
    '云计算',
    '数据中心',
    '机器人',
    '工业自动化',
    '自动驾驶',
    '网络安全',
    '数据泄露',
    '跨境市场',
    '融资上市',
    '裁员',
    'OpenAI',
    'Anthropic',
    'Google DeepMind',
    'Meta AI',
    'xAI',
    'Midjourney',
    '豆包',
    'Kimi',
    '通义',
    '文心',
    '智谱',
    '百川',
    'MiniMax',
    '月之暗面',
    '字节',
    '腾讯',
    '阿里',
    '百度',
    '京东',
    '美团',
    '拼多多',
    '小米',
    '荣耀',
    'oppo',
    'vivo',
    '英特尔',
    '英伟达',
    'AMD',
    '高通',
    '苹果',
    '三星',
    'AI',
    '大模型',
    '人工智能',
    'ChatGPT',
    '芯片',
    '软件',
    '硬件',
  ],
  财经: [
    '股市',
    '指数',
    '大盘',
    '涨停',
    '跌停',
    '牛市',
    '熊市',
    '加印',
    '降息',
    '利率',
    '汇率',
    'GDP',
    'CPI',
    '信贷',
    '贷款',
    '基金',
    '理财',
    '保险',
    '财政收入',
    '赤字',
    '债务',
    '关税',
    '进出口',
    '贸易顺差',
    '逆差',
    '货币',
    '银行',
    '券商',
    '投资',
    '市场',
    '经济',
    '金融',
    '财政',
    '印花税',
    '北向资金',
    '量化',
    'ETF',
    '沪指',
    '深指',
    'A股',
    '亿',
    '专项',
    '定向',
  ],
  国际: [
    '峰会',
    '外交',
    '外长',
    '大使',
    '制裁',
    '禁运',
    '停火',
    '谈判',
    '军事演习',
    '军队',
    '难民',
    '人道主义',
    '议会',
    '气候协议',
    '贸易协定',
    '领事',
    '签证',
    '联合国',
    '欧盟',
    '北约',
    '东盟',
    '上合',
    'G7',
    'G20',
    '岛内',
    '两岸',
    '台海',
    '外长会',
    '使领馆',
  ],
  社会: [
    '事故',
    '伤亡',
    '灾害',
    '防控',
    '隔离',
    '核酸',
    '复课',
    '开学',
    '医疗',
    '医保',
    '药品纳入',
    '就业',
    '失业',
    '最低工资',
    '延迟退休',
    '社区',
    '物业',
    '环境治理',
    '食品安全',
    '曝光',
    '下架',
    '投诉',
    '维权',
    '健康',
    '交通',
    '教育',
    '入学',
    '中考',
    '高考',
    '防控政策',
    '疫情',
    '非亲生',
    '诱拐',
    '宰杀',
    '宠物',
    '社区',
  ],
  娱乐: [
    '首映',
    '定档',
    '官宣',
    '塌房',
    '绯闻',
    '演唱会',
    '票房',
    '收视',
    '综艺',
    '剧集',
    '网红',
    '直播',
    '带货',
    '颁奖',
    '红毯',
    '音乐',
    '电影',
    '去世',
    '逝世',
    '讣告',
    '主屋',
    '带货',
  ],
  体育: [
    '比分',
    '胜负',
    '绝杀',
    '冠军',
    '夺冠',
    '捧杯',
    '联赛',
    '杯赛',
    '淘汰赛',
    '红牌',
    '黄牌',
    '点球',
    '转会',
    '签约',
    '退役',
    '奥运',
    '退赛',
    '伤病',
    '世界杯',
    '欧冠',
    'CBA',
    'NBA',
    '中超',
  ],
  房产: [
    '开盘',
    '加推',
    '日光',
    '去化率',
    '降价',
    '打折',
    '烂尾',
    '交付',
    '延期',
    '松绑',
    '限购',
    '落户',
    '房产税',
    '土拍',
    '地王',
    '流拍',
    '公积金',
    '城镇化',
    '房价',
    '房贷',
    '抄底',
    '新盘',
  ],
  汽车: [
    '降价',
    '促销',
    '碰撞测试',
    '安全评级',
    '召回',
    '故障',
    '新车上市',
    '预售',
    '销量榜单',
    '交付量',
    '新能源',
    '购置税补贴',
    '经销商',
    '4S店',
    '试驾',
    '车型',
    'MPV',
    'SUV',
    '轿车',
    '购置税',
  ],
  消费: [
    '涨价',
    '降价',
    '促销',
    '秒杀',
    '抢购',
    '新品首发',
    '门店开关',
    '食品安全',
    '快递',
    '物流',
    '宠物经济',
    '海淘',
    '代购',
    '电商',
    '购物节',
    '茅台',
    '餐饮',
    '咖啡',
    '奶茶',
    '零食',
    '法拉利',
    '豪车',
  ],
  法律: [
    '判刑',
    '立案',
    '警方通报',
    '检方公诉',
    '判决',
    '处罚',
    '罚款',
    '赔偿',
    '调解',
    '取保候审',
    '治安',
    '扫黄',
    '禁毒',
    '网络犯罪',
    '偷逃税',
    '税务稽查',
    '佛教协会',
    '公诉',
    '检方',
    '通报',
    '治安',
    '被判',
    '有期徒刑',
    '审结',
    '一审',
  ],
};

// 关键词兜底分类(无命名品牌,纯抽象信号词)
export function classifyRule(title: string): string {
  for (const [cat, kws] of Object.entries(CATEGORY_KW)) {
    if (kws.some((k) => title.includes(k))) return cat;
  }
  return '综合';
}

// Workers AI 分类(主分类,优先于关键词兜底)
// 注意:kimi-k2.5 在免费 Worker 内响应太慢(15s+),暂时改用关键词兜底
// 启用条件:升级 Paid 版后 Worker 侧加 timeout 再开启 AI 分类
export async function classifyByAI(title: string, env: Env): Promise<string> {
  return classifyRule(title); // 暂时禁用 AI,降级为纯关键词
}

// 双保险分类:AI 优先,关键词兜底,综合保底
// 注意:AI 分类(classifyByAI)因 Workers AI 响应慢,已暂时禁用
// 启用条件:升级 Paid 版后 Worker 侧加 timeout 再开启
export async function classify(title: string, env: Env): Promise<string> {
  // AI 分类(kimi-k2.5)暂时禁用,待 Paid 版加 timeout 后启用
  return classifyRule(title);
}

// ============================================================
// 评分规则
// ============================================================
// R threshold for Workers AI routing
// NOTE: scoreRule max=7.6, threshold must be <=7.6 to be reachable
const AI_ROUTE_R_THRESHOLD = 7.0;
const TOPIC_MATCH_THRESHOLD = 0.72;
const R2_DUP_THRESHOLD = 0.88;

// ============================================================
// 评分规则
// ============================================================
export function scoreRule(title: string): { score: number; reason: string; isHigh: boolean } {
  const hotWords = [
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
  const superHot = ['紧急', '突发', '重磅'];
  const hasSuperHot = superHot.some((w) => title.includes(w));
  const hasHot = hotWords.some((w) => title.includes(w));
  const hasNum = /\d+/.test(title);
  const hasExclaim = title.includes('!') || title.includes('?');
  const len = title.length;
  let score = 5.0;
  if (hasSuperHot) score += 2.0;
  else if (hasHot) score += 1.2;
  if (hasNum) score += 0.5;
  if (len > 20 && len < 35) score += 0.3;
  if (hasExclaim) score += 0.3;
  const hotCount = hotWords.filter((w) => title.includes(w)).length;
  if (hotCount >= 3) score += 0.5;
  else if (hotCount >= 2) score += 0.3;
  score = Math.min(10, Math.round(score * 10) / 10);
  return {
    score,
    reason: `热词:${hasHot} 超热:${hasSuperHot} 数字:${hasNum} 长:${len} 多热:${hotCount}`,
    isHigh: score >= AI_ROUTE_R_THRESHOLD,
  };
}

// ============================================================
// 主 Worker
// ============================================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';

    // v0.37.3 鉴权回归修复：public endpoint 白名单
    // 健康检查/模型测试/health 端点（9 维度）默认放行，无需鉴权
    const PUBLIC_ACTIONS = new Set(['ping', 'health', 'model-test']);
    if (!PUBLIC_ACTIONS.has(action)) {
      const authError = authRequest(request, env);
      if (authError) return authError;
    }

    if (action === 'diag') {
      const results = [];

      // 1. Insert topic
      const t0 = Date.now();
      const tr = await fetch(`${getSupabaseHost(env)}/rest/v1/topics`, {
        method: 'POST',
        body: JSON.stringify({ topic_key: 'diag-' + Date.now(), level: 'follow' }),
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      });
      const t0t = await tr.text();
      let t0id = null;
      try {
        const d = JSON.parse(t0t);
        t0id = d?.[0]?.id || d?.id;
      } catch {}
      results.push({ step: 'topic_insert', status: tr.status, id: t0id, body: t0t.slice(0, 100) });

      // 2. Insert news
      const t1 = Date.now();
      const nr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_hotspots`, {
        method: 'POST',
        body: JSON.stringify({ title: 'diag-' + Date.now(), source: 'zaker', category: '测试' }),
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
      });
      const t1t = await nr.text();
      let t1id = null;
      try {
        const d = JSON.parse(t1t);
        t1id = d?.[0]?.id || d?.id;
      } catch {}
      results.push({ step: 'news_insert', status: nr.status, id: t1id, body: t1t.slice(0, 100) });

      // 3. Join (if both IDs exist)
      if (t0id && t1id) {
        const t2 = Date.now();
        // Join: news_topic_members.news_id = news.id, topic_id = topic.id
        const jr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_topic_members`, {
          method: 'POST',
          body: JSON.stringify({ news_id: t1id, topic_id: t0id, role: 'seed' }),
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
        });
        const t2t = await jr.text();
        results.push({ step: 'join', status: jr.status, body: t2t.slice(0, 200) });
      } else {
        results.push({ step: 'join', status: -1, reason: 'missing IDs', tid: t0id, nid: t1id });
      }

      return jsonResponse({ ts: Date.now(), results }, cors);
    }

    // All other actions → dispatch layer (pull, health, ai-usage, ping, score, etc.)
    return await dispatchAction(env, ctx, action, request);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const cron = controller?.cron ?? 'unknown';

    // Route to the appropriate handler based on cron expression
    if (cron === '0 3,15 * * *') {
      // Entity selflearn + process + event clustering — twice daily (03:00 & 15:00 UTC)
      // bge-m3 ~5K Neurons/day, within Free Plan 10K/day quota
      ctx.waitUntil(
        scheduledEntity(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] entity error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 * * * *') {
      // Process + tavily + knowledge — hourly at :00 UTC
      ctx.waitUntil(
        scheduledProcess(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] process error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 1 1 * *') {
      // Archive old entities — monthly 1st at 01:00 UTC
      ctx.waitUntil(
        scheduledArchiveOldEntities(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] archive error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 4 * * *') {
      // Feedback loop — daily at 04:00 UTC
      ctx.waitUntil(
        scheduledFeedback(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] feedback error: ${e?.message || e}`);
        })
      );
    } else if (cron === '0 0 * * *') {
      // AI budget daily reset — daily at 00:00 UTC (Phase 1 Neurons tracking)
      // clears AI_USAGE_KV usage/{YYYY-MM-DD} counter for fresh day budget accounting
      ctx.waitUntil(
        scheduledReset(env, ctx, controller).catch((e) => {
          logEvent(env, 'error', `[scheduled] reset error: ${e?.message || e}`);
        })
      );
    }
    // Unknown crons: no-op (ignore silently)
  },
};
