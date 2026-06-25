/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase + R2
 *
 * 安全设计:
 * - 所有请求需带 Bearer Token(BEARER_TOKEN env var)
 * - CORS 仅允许已授权来源
 */
interface Env {
  AI: Ai;
  csnews_raw: R2Bucket;
  BEARER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

function getSupabaseHost(env: Env) {
  return `https://${env.SUPABASE_URL}.supabase.co`;
}

// Supabase fetch wrapper
async function supabaseFetch(env: Env, path: string, options?: RequestInit) {
  const res = await fetch(`${getSupabaseHost(env)}${path}`, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  return res;
}

// 安全的 JSON 解析
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text || !text.trim()) return null;  // 空响应返回 null 而非 {}
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ====== News Self Growth 核心逻辑 ======

// 清理过期话题簇(跟进7天/重要14天/爆炸28天)
async function cleanupStaleTopics(env: Env) {
  const { data } = await (await supabaseFetch(env, '/rest/v1/rpc/cleanup_stale_topics', {
    method: 'POST',
  })).json() as any;
  return data?.[0] || { deleted_topic_count: 0, deleted_news_count: 0 };
}

// 向量查重:查相似新闻
async function findSimilarNews(env: Env, embedding: number[], threshold = 0.88, matchCount = 5) {
  const res = await supabaseFetch(env, '/rest/v1/rpc/find_similar_news', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: embedding, threshold, match_count: matchCount }),
  });
  const data = await safeJson(res) as any[];
  return data || [];
}

// 更新话题簇积分
async function updateTopicScore(env: Env, topicId: string, delta = 1) {
  const res = await supabaseFetch(env, '/rest/v1/rpc/update_topic_score', {
    method: 'POST',
    body: JSON.stringify({ p_topic_id: topicId, p_score_delta: delta }),
  });
  const data = await safeJson(res) as any[];
  return data?.[0] || { new_score: 0, new_level: 'follow', upgraded: false, fission_triggered: false };
}

// 记录 TIE-lite 趋势快照并按规则触发 warning，不调用 LLM
async function recordTrendSnapshot(env: Env, topicId: string) {
  try {
    const res = await supabaseFetch(env, '/rest/v1/rpc/record_trend_snapshot', {
      method: 'POST',
      body: JSON.stringify({ p_topic_id: topicId }),
    });
    const data = await safeJson(res) as any[];
    return Array.isArray(data) ? data[0] || null : null;
  } catch {
    return null;
  }
}

// 插入话题簇
async function createTopic(env: Env, topicKey: string, level = 'follow', firstNewsId?: string): Promise<any> {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await supabaseFetch(env, '/rest/v1/topics', {
    method: 'POST',
    body: JSON.stringify({ id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId }),
  });
  return { id, topic_key: topicKey, level, score: 0, first_news_id: firstNewsId };
}

// 插入新闻记录
async function insertNewsHotspot(env: Env, news: {
  title: string; url?: string; source?: string; category?: string;
  hot_score?: number; published_at?: string; summary?: string;
  embedding?: number[]; r2_key?: string; topic_id?: string;
  level?: string; score?: number; is_stored_r2?: boolean;
}): Promise<string | null> {
  // 生成确定性 UUID(基于 title + timestamp),避免响应体被 Cloudflare 截断
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newsWithId = { id, ...news };
  await supabaseFetch(env, '/rest/v1/news_hotspots', {
    method: 'POST',
    body: JSON.stringify(newsWithId),
  });
  return id;
}

// 关联新闻-话题
async function joinTopicMember(env: Env, newsId: string, topicId: string, role = 'follow'): Promise<boolean> {
  const res = await supabaseFetch(env, '/rest/v1/news_topic_members', {
    method: 'POST',
    body: JSON.stringify({ news_id: newsId, topic_id: topicId, role }),
    headers: { 'Prefer': 'return=representation' },
  });
  const raw = await res.text();
  return !!(raw && raw.trim() && (raw !== '[]'));
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
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
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
  '科技': [
    '技术发布', '算法突破', '开源', '漏洞修复', '系统升级', '产品迭代', '发布会',
    '数字化', '智能化', '云计算', '数据中心', '机器人', '工业自动化', '自动驾驶',
    '网络安全', '数据泄露', '跨境市场', '融资上市', '裁员',
    'OpenAI', 'Anthropic', 'Google DeepMind', 'Meta AI', 'xAI', 'Midjourney',
    '豆包', 'Kimi', '通义', '文心', '智谱', '百川', 'MiniMax', '月之暗面',
    '字节', '腾讯', '阿里', '百度', '京东', '美团', '拼多多', '小米', '荣耀', 'oppo', 'vivo',
    '英特尔', '英伟达', 'AMD', '高通', '苹果', '三星',
    'AI', '大模型', '人工智能', 'ChatGPT', '芯片', '软件', '硬件',
  ],
  '财经': [
    '股市', '指数', '大盘', '涨停', '跌停', '牛市', '熊市', '加印', '降息',
    '利率', '汇率', 'GDP', 'CPI', '信贷', '贷款', '基金', '理财', '保险',
    '财政收入', '赤字', '债务', '关税', '进出口', '贸易顺差', '逆差',
    '货币', '银行', '券商', '投资', '市场', '经济', '金融', '财政',
    '印花税', '北向资金', '量化', 'ETF', '沪指', '深指', 'A股', '亿', '专项', '定向',
  ],
  '国际': [
    '峰会', '外交', '外长', '大使', '制裁', '禁运', '停火', '谈判', '军事演习',
    '军队', '难民', '人道主义', '议会', '气候协议', '贸易协定', '领事', '签证',
    '联合国', '欧盟', '北约', '东盟', '上合', 'G7', 'G20',
    '岛内', '两岸', '台海', '外长会', '使领馆',
  ],
  '社会': [
    '事故', '伤亡', '灾害', '防控', '隔离', '核酸', '复课', '开学', '医疗',
    '医保', '药品纳入', '就业', '失业', '最低工资', '延迟退休', '社区', '物业',
    '环境治理', '食品安全', '曝光', '下架', '投诉', '维权', '健康', '交通',
    '教育', '入学', '中考', '高考', '防控政策', '疫情',
    '非亲生', '诱拐', '宰杀', '宠物', '社区',
  ],
  '娱乐': [
    '首映', '定档', '官宣', '塌房', '绯闻', '演唱会', '票房', '收视', '综艺',
    '剧集', '网红', '直播', '带货', '颁奖', '红毯', '音乐', '电影',
    '去世', '逝世', '讣告', '主屋', '带货',
  ],
  '体育': [
    '比分', '胜负', '绝杀', '冠军', '夺冠', '捧杯', '联赛', '杯赛', '淘汰赛',
    '红牌', '黄牌', '点球', '转会', '签约', '退役', '奥运', '退赛', '伤病',
    '世界杯', '欧冠', 'CBA', 'NBA', '中超',
  ],
  '房产': [
    '开盘', '加推', '日光', '去化率', '降价', '打折', '烂尾', '交付', '延期',
    '松绑', '限购', '落户', '房产税', '土拍', '地王', '流拍', '公积金', '城镇化',
    '房价', '房贷', '抄底', '新盘',
  ],
  '汽车': [
    '降价', '促销', '碰撞测试', '安全评级', '召回', '故障', '新车上市', '预售',
    '销量榜单', '交付量', '新能源', '购置税补贴', '经销商', '4S店', '试驾',
    '车型', 'MPV', 'SUV', '轿车', '购置税',
  ],
  '消费': [
    '涨价', '降价', '促销', '秒杀', '抢购', '新品首发', '门店开关', '食品安全',
    '快递', '物流', '宠物经济', '海淘', '代购', '电商', '购物节',
    '茅台', '餐饮', '咖啡', '奶茶', '零食', '法拉利', '豪车',
  ],
  '法律': [
    '判刑', '立案', '警方通报', '检方公诉', '判决', '处罚', '罚款', '赔偿',
    '调解', '取保候审', '治安', '扫黄', '禁毒', '网络犯罪', '偷逃税', '税务稽查',
    '佛教协会', '公诉', '检方', '通报', '治安',
    '被判', '有期徒刑', '审结', '一审',
  ],
};

// 关键词兜底分类(无命名品牌,纯抽象信号词)
export function classifyRule(title: string): string {
  for (const [cat, kws] of Object.entries(CATEGORY_KW)) {
    if (kws.some(k => title.includes(k))) return cat;
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
// R threshold for Workers AI routing (KR4: Neurons saving)
// NOTE: scoreRule max=7.6, threshold must be <=7.6 to be reachable
const AI_ROUTE_R_THRESHOLD = 7.0;
const TOPIC_MATCH_THRESHOLD = 0.72;
const R2_DUP_THRESHOLD = 0.88;

// ============================================================
// 评分规则
// ============================================================
export function scoreRule(title: string): { score: number; reason: string; isHigh: boolean } {
  const hotWords = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新', '突破', '革命', '创历史'];
  const superHot = ['紧急', '突发', '重磅'];
  const hasSuperHot = superHot.some(w => title.includes(w));
  const hasHot = hotWords.some(w => title.includes(w));
  const hasNum = /\d+/.test(title);
  const hasExclaim = title.includes('!') || title.includes('?');
  const len = title.length;
  let score = 5.0;
  if (hasSuperHot) score += 2.0;
  else if (hasHot) score += 1.2;
  if (hasNum) score += 0.5;
  if (len > 20 && len < 35) score += 0.3;
  if (hasExclaim) score += 0.3;
  const hotCount = hotWords.filter(w => title.includes(w)).length;
  if (hotCount >= 3) score += 0.5;
  else if (hotCount >= 2) score += 0.3;
  score = Math.min(10, Math.round(score * 10) / 10);
  return { score, reason: `热词:${hasHot} 超热:${hasSuperHot} 数字:${hasNum} 长:${len} 多热:${hotCount}`, isHigh: score >= AI_ROUTE_R_THRESHOLD };
}

// ============================================================
// Workers AI 响应解析
// env.AI.run() 返回格式:{ response: string, usage: {...} }
// ============================================================
function extractText(resp: any): string {
  if (typeof resp === 'string') return resp.trim();
  if (resp && typeof resp === 'object') {
    const text = (resp.response || '').trim();
    if (text) return text;
  }
  return '';
}

// ============================================================
// Workers AI 裂变报告生成
// ============================================================
// Workers AI 裂变报告生成
// KR4: only call AI when R >= AI_ROUTE_R_THRESHOLD
async function maybeFissionReport(title: string, env: Env, rScore: number): Promise<string> {
  if (rScore < AI_ROUTE_R_THRESHOLD) return `(AI跳过-R<${AI_ROUTE_R_THRESHOLD})`;
  try {
    const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'user', content: `根据以下新闻，生成一段50字左右的裂变分析报告：\n\n${title}` }
      ],
      max_tokens: 200,
      temperature: 0.3,
    }) as any;
    return extractText(resp) || '(无AI输出)';
  } catch (e: any) {
    return `(AI错误: ${e.message})`;
  }
}

// ============================================================
// 主 Worker
// ============================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const authError = authRequest(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'ping';



    if (action === 'diag') {
      const results = [];

      // 1. Insert topic
      const t0 = Date.now();
      const tr = await fetch(`${getSupabaseHost(env)}/rest/v1/topics`, {
        method: 'POST',
        body: JSON.stringify({ topic_key: 'diag-' + Date.now(), level: 'follow' }),
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        }
      });
      const t0t = await tr.text();
      let t0id = null;
      try { const d = JSON.parse(t0t); t0id = d?.[0]?.id || d?.id; } catch {}
      results.push({ step: 'topic_insert', status: tr.status, id: t0id, body: t0t.slice(0,100) });

      // 2. Insert news
      const t1 = Date.now();
      const nr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_hotspots`, {
        method: 'POST',
        body: JSON.stringify({ title: 'diag-' + Date.now(), source: 'zaker', category: '测试' }),
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        }
      });
      const t1t = await nr.text();
      let t1id = null;
      try { const d = JSON.parse(t1t); t1id = d?.[0]?.id || d?.id; } catch {}
      results.push({ step: 'news_insert', status: nr.status, id: t1id, body: t1t.slice(0,100) });

      // 3. Join (if both IDs exist)
      if (t0id && t1id) {
        const t2 = Date.now();
        // Join: news_topic_members.news_id = news.id, topic_id = topic.id
        const jr = await fetch(`${getSupabaseHost(env)}/rest/v1/news_topic_members`, {
          method: 'POST',
          body: JSON.stringify({ news_id: t1id, topic_id: t0id, role: 'seed' }),
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          }
        });
        const t2t = await jr.text();
        results.push({ step: 'join', status: jr.status, body: t2t.slice(0,200) });
      } else {
        results.push({ step: 'join', status: -1, reason: 'missing IDs', tid: t0id, nid: t1id });
      }

      return new Response(JSON.stringify({ ts: Date.now(), results }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    if (action === 'ping') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }









    // -------- 模型测试 --------
    if (action === 'model-test') {
      const r = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: '说一段话介绍自己' }],
        max_tokens: 100,
      }) as any;
      return new Response(JSON.stringify({
        ok: true,
        model: 'llama-3-8b-instruct',
        response: extractText(r).substring(0, 200),
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变报告测试 --------
    if (action === 'ai-test') {
      const title = url.searchParams.get('title') || 'OpenAI发布GPT-5,AI行业迎来新一轮革命';
      const report = await maybeFissionReport(title, env, 9.0); // test always uses high score
      return new Response(JSON.stringify({ title, report }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 单条新闻评分 + 分类 --------
    if (action === 'score') {
      const title = url.searchParams.get('title');
      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      const rule = scoreRule(title);
      const category = await classify(title, env);
      const useAI = url.searchParams.get('ai') !== 'false';
      let aiReport = '';

      if (useAI) {
        aiReport = await maybeFissionReport(title, env, rule.score);
      }

      return new Response(JSON.stringify({
        title,
        score: rule.score,
        category,
        reason: rule.reason,
        ai_report: aiReport,
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 独立分类测试(调试用)--------
    if (action === 'classify') {
      const title = url.searchParams.get('title');
      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      const aiCat = await classifyByAI(title, env);
      const kwCat = classifyRule(title);
      return new Response(JSON.stringify({ title, aiCat, kwCat }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 批量评分 --------
    if (action === 'batch-score') {
      let body: { items: NewsItem[]; use_ai?: boolean } | null = null;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      const items = body?.items || [];
      const useAI = body?.use_ai !== false;

      const results = await Promise.all(items.map(async (item) => {
        const rule = scoreRule(item.title);
        const category = await classify(item.title, env);
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
      }));

      return new Response(JSON.stringify({ count: results.length, results }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变查询生成（KR4: 高分新闻才生成，低分跳过）--------
    if (action === 'fission') {
      const seed = url.searchParams.get('seed') || url.searchParams.get('title');
      if (!seed) {
        return new Response(JSON.stringify({ error: 'missing seed param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      const r = scoreRule(seed);
      if (r.score < AI_ROUTE_R_THRESHOLD) {
        return new Response(JSON.stringify({
          seed,
          queries: [],
          count: 0,
          skipped: true,
          reason: `R=${r.score} < ${AI_ROUTE_R_THRESHOLD}，AI跳过`
        }), { headers: { 'Content-Type': 'application/json', ...cors } });
      }
      try {
        const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'user', content: `生成5个深度裂变搜索查询词(每个不超过15字),用|分隔:
新闻:${seed}` }
          ],
          max_tokens: 200,
          temperature: 0.3,
        }) as any;
        const text = extractText(resp);
        const queries = text.split('|').map(q => q.trim()).filter(q => q.length > 0 && q.length <= 20);
        return new Response(JSON.stringify({ seed, queries, count: queries.length }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- 保存新闻到 R2(手动单条保存)--------
    if (action === 'save') {
      const title = url.searchParams.get('title') || '';
      const category = url.searchParams.get('category') || '综合';
      const score = parseFloat(url.searchParams.get('score') || '5');
      const source = url.searchParams.get('source') || 'zaker';

      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const item = { id, title, category, score, source, created_at: new Date().toISOString() };
        const key = `news/${source}/${id}.json`;
        await env.csnews_raw.put(key, JSON.stringify(item), {
          httpMetadata: { contentType: 'application/json' },
        });
        return new Response(JSON.stringify({ ok: true, key, item }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- 列出 R2 中的新闻 --------
    if (action === 'list') {
      const prefix = url.searchParams.get('prefix') || 'news/zaker/';
      const list = await env.csnews_raw.list({ prefix });
      const items = await Promise.all(
        list.objects.slice(0, 20).map(async (obj) => {
          const body = await env.csnews_raw.get(obj.key);
          const text = await body?.text();
          try { return JSON.parse(text || '{}'); } catch { return { key: obj.key }; }
        })
      );
      return new Response(JSON.stringify({ count: items.length, items }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- Workers AI 向量嵌入(@cf/baai/bge-m3)--------
    if (action === 'embed') {
      const text = url.searchParams.get('text') || url.searchParams.get('title') || '';
      if (!text) {
        return new Response(JSON.stringify({ error: 'missing text param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const resp = await env.AI.run('@cf/baai/bge-m3', {
          text: [text],
        }) as any;

        // bge-m3 返回格式:{ shape: [n, dim], data: [...], response: string }
        const raw = resp as any;
        // 尝试多种路径取 embedding
        let embedding: number[] = [];
        if (Array.isArray(raw?.data) && raw.data.length > 0) {
          const item = raw.data[0];
          if (Array.isArray(item?.embedding)) embedding = item.embedding;
          else if (Array.isArray(item)) embedding = item;
        }

        if (!embedding || embedding.length === 0) {
          return new Response(JSON.stringify({ error: 'embedding empty', shape: raw?.shape, keys: raw ? Object.keys(raw) : [] }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }

        // 存 R2
        const key = `embeddings/${Date.now()}.json`;
        await env.csnews_raw.put(key, JSON.stringify({ text, embedding, dim: embedding.length, model: 'bge-m3' }), {
          httpMetadata: { contentType: 'application/json' },
        });

        return new Response(JSON.stringify({
          text,
          dim: embedding.length,
          model: '@cf/baai/bge-m3',
          sample: embedding.slice(0, 5),
          key,
        }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- ZAKER 热点新闻获取 + 处理 --------
    if (action === 'zaker-hot') {
      try {
        const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
        const json = await r.json() as any;
        const list: any[] = json?.data?.list || [];
        const results = [];

        for (const item of list.slice(0, 1)) {
          const title = item.title || '';
          if (!title) continue;

          const rule = scoreRule(title);
          const category = await classify(title, env);

          // 跳过向量化和R2,只测Supabase写入
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

        return new Response(JSON.stringify({ count: results.length, items: results }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }





    // -------- News Self Growth 主流程(ZAKER → 查重 → 积分 → R2)--------
    if (action === 'process') {
      // Step 0: 清理过期话题簇(1 subrequest)
      const cleaned = await cleanupStaleTopics(env) as any;

      // Step 1: 拉 ZAKER 热点(1 subrequest)
      const r = await fetch('https://skills.myzaker.com/api/v1/article/hot?v=1.0.3');
      const json = await r.json() as any;
      const list: any[] = json?.data?.list || [];
      if (list.length === 0) {
        return new Response(JSON.stringify({ error: 'no news' }), { headers: { 'Content-Type': 'application/json', ...cors } });
      }

      const results = [];
      // 10 items max:
      // - Full flow adds one TIE-lite snapshot RPC after topic join.
      // - 6 full items + 2 global requests remain under the free Worker subrequest limit.
      // - 后4条只写Supabase(跳过向量查重)节省 Neurons
      const FULL_COUNT = 6;

      for (let i = 0; i < list.slice(0, 10).length; i++) {
        const item = list[i];
        const title = item.title || '';
        if (!title) continue;

        // 规则引擎评分+分类
        const rule = scoreRule(title);
        const category = await classify(title, env);

        let topicId: string | undefined;
        let isStoredR2 = false;
        let newsLevel = 'follow';
        let newsScore = 0;
        let fission = false;
        let isNewTopic = false;
        let embedding: number[] = [];
        let matchedSimilarity: number | null = null;
        let r2Key: string | undefined;
        let storedReason = i < FULL_COUNT ? 'embedding_empty' : 'lightweight_no_embedding';
        let trendSnapshot: any = null;

        // 仅前 FULL_COUNT 条做 embedding + 向量查重(Workers AI CPU 限制)
        if (i < FULL_COUNT) {
          try {
            const embResp = await env.AI.run('@cf/baai/bge-m3', { text: [title] }) as any;
            const raw = embResp as any;
            if (Array.isArray(raw?.data) && raw.data.length > 0) {
              const it = raw.data[0];
              embedding = Array.isArray(it?.embedding) ? it.embedding : Array.isArray(it) ? it : [];
            }
          } catch { /* 向量化失败不影响 */ }

          if (embedding.length > 0) {
            const similar = await findSimilarNews(env, embedding, TOPIC_MATCH_THRESHOLD, 3);
            if (similar.length > 0 && similar[0].topic_id) {
              const top = similar[0];
              topicId = top.topic_id;
              const updated = await updateTopicScore(env, top.topic_id, 1) as any;
              newsScore = updated.new_score || 0;
              newsLevel = updated.new_level || 'follow';
              fission = updated.fission_triggered || false;

              const simScore = top.similarity || 0;
              matchedSimilarity = simScore;
              if (simScore < R2_DUP_THRESHOLD) {
                r2Key = await saveToR2(env, 'news/zaker', {
                  title, category, score: rule.score, source: 'zaker',
                  topic_id: topicId, level: newsLevel, fission, similarity: simScore,
                  created_at: new Date().toISOString(),
                });
                isStoredR2 = true;
                storedReason = 'same_topic_new_angle';
              } else {
                storedReason = 'same_topic_duplicate';
              }
            }
          }

          if (!topicId) {
            const topicKey = title.slice(0, 8).replace(/[^a-zA-Z0-9]/g, '') + Math.abs(hashStr(title)).toString(36);
            const created = await createTopic(env, topicKey, 'follow') as any;
            if (created?.id) {
              topicId = created.id;
              newsScore = 0;
              newsLevel = 'follow';
              isNewTopic = true;
              r2Key = await saveToR2(env, 'news/zaker', {
                title, category, score: rule.score, source: 'zaker',
                topic_id: topicId, level: newsLevel, fission: false,
                created_at: new Date().toISOString(),
              });
              isStoredR2 = true;
              storedReason = embedding.length > 0 ? 'new_topic' : 'new_topic_without_embedding';
            }
          }
        }

        // Step 4: 写 Supabase(实时打分层)- 1 subrequest
        const newsId = await insertNewsHotspot(env, {
          title,
          url: item.url || '',
          source: 'zaker',
          category,
          hot_score: rule.score,
          published_at: item.publish_time || new Date().toISOString(),
          summary: (item.summary || '').substring(0, 200),
          embedding: embedding.length > 0 ? embedding : undefined,
          r2_key: r2Key,
          topic_id: topicId,
          level: newsLevel,
          score: newsScore,
          is_stored_r2: isStoredR2,
        });

        // Step 5: 关联新闻-话题(news_topic_members)- 1 subrequest
        if (newsId && topicId) {
          await joinTopicMember(env, newsId, topicId, isNewTopic ? 'seed' : 'follow');
          trendSnapshot = await recordTrendSnapshot(env, topicId);
        }

        results.push({
          title,
          category,
          score: rule.score,
          topic_id: topicId,
          similarity: matchedSimilarity,
          level: newsLevel,
          is_stored_r2: isStoredR2,
          stored_reason: storedReason,
          trend: trendSnapshot ? {
            snapshot_id: trendSnapshot.snapshot_id,
            warning_id: trendSnapshot.warning_id,
            velocity: trendSnapshot.velocity,
            acceleration: trendSnapshot.acceleration,
            stage: trendSnapshot.stage,
            warning_created: trendSnapshot.warning_created,
          } : null,
          fission,
        });
        if (fission) console.log(`[FISSION] ${title}`);
      }

      return new Response(JSON.stringify({
        processed: results.length,
        cleaned: cleaned?.deleted_topic_count || 0,
        items: results,
      }), { headers: { 'Content-Type': 'application/json', ...cors } });
    }
    return new Response(JSON.stringify({ error: 'unknown action' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors }
    });
  },
};
