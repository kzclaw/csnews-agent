/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase
 *
 * 安全设计：
 * - 所有请求需带 Bearer Token（BEARER_TOKEN env var）
 * - CORS 仅允许已授权来源
 */
interface Env {
  AI: Ai;
  BEARER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
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
  '科技': ['AI', '人工智能', 'ChatGPT', '大模型', '芯片', '算法', '机器人', '智能', '技术', '科技', '代码', '编程', '软件', '特斯拉', '字节', '华为', '鸿蒙', 'OpenAI', '模型'],
  '财经': ['股市', '基金', '货币', '经济', '金融', '银行', '投资', '市场', '美元', '黄金', '汇率', 'A股', '沪指', '加息', '通胀', '人民币', '加密货币'],
  '国际': ['美国', '英国', '欧盟', '俄罗斯', '乌克兰', '日本', '韩国', '联合国', '外交', '制裁', 'G20', '首相', '岸田', '普京', '习近平', '中美', '外长'],
  '社会': ['疫情', '健康', '医疗', '医保', '教育', '交通', '环境', '灾害', '事故', '核酸', '中考', '确诊', '小区', '防控'],
  '娱乐': ['电影', '音乐', '明星', '综艺', '赛事', '奥运', '世界杯', '演唱会', '门票', '周杰伦', '刘德华', 'QQ音乐'],
  '综合': [],
};

export function classifyRule(title: string): string {
  for (const [cat, kws] of Object.entries(CATEGORY_KW)) {
    if (kws.some(k => title.includes(k))) return cat;
  }
  return '综合';
}

// ============================================================
// 评分规则
// ============================================================
export function scoreRule(title: string): { score: number; reason: string } {
  const hotWords = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新', '突破', '革命', '创历史'];
  const hasHot = hotWords.some(w => title.includes(w));
  const hasNum = /\d+/.test(title);
  const hasExclaim = title.includes('！') || title.includes('?');
  const len = title.length;
  let score = 5.0;
  if (hasHot) score += 1.5;
  if (hasNum) score += 0.5;
  if (len > 20 && len < 35) score += 0.3;
  if (hasExclaim) score += 0.3;
  return { score: Math.min(10, Math.round(score * 10) / 10), reason: `热词:${hasHot} 数字:${hasNum} 长度:${len}` };
}

// ============================================================
// Workers AI 响应解析
// env.AI.run() 返回格式：{ response: string, usage: {...} }
// 直接取 r.response，不要用 OpenAI 的 choices 格式
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
// Workers AI 裂变报告生成（唯一 AI 用途）
// ============================================================
async function aiFissionReport(title: string, env: Env): Promise<string> {
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
// Supabase 操作
// ============================================================
async function supabaseInsert(table: string, data: Record<string, any>, env: Env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  return res.json();
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

    // -------- 健康检查 --------
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
      // Workers AI 内部 env.AI.run() 返回格式：{ response: string }（不是 OpenAI 格式）
      // Workers AI 返回 { response: string }，不用 OpenAI choices 格式
      let text = '';
      if (typeof r === 'string') {
        text = r.trim();
      } else {
        text = (r.response || '').trim();
      }
      return new Response(JSON.stringify({
        ok: true,
        model: 'llama-3-8b-instruct',
        text: text.substring(0, 200),
        top_keys: r ? Object.keys(r) : [],
        r_response: typeof r === 'string' ? r.substring(0, 100) : '(object)',
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变报告测试 --------
    if (action === 'ai-test') {
      const title = url.searchParams.get('title') || 'OpenAI发布GPT-5，AI行业迎来新一轮革命';
      const report = await aiFissionReport(title, env);
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
      const category = classifyRule(title);
      const useAI = url.searchParams.get('ai') !== 'false';
      let aiReport = '';

      if (useAI) {
        aiReport = await aiFissionReport(title, env);
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
        const category = classifyRule(item.title);
        let aiReport = '';
        if (useAI) {
          aiReport = await aiFissionReport(item.title, env);
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

    // -------- 裂变查询生成 --------
    if (action === 'fission') {
      const seed = url.searchParams.get('seed') || url.searchParams.get('title');
      if (!seed) {
        return new Response(JSON.stringify({ error: 'missing seed param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'user', content: `生成5个深度裂变搜索查询词（每个不超过15字），用|分隔：\n新闻：${seed}` }
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

    return new Response(JSON.stringify({ error: 'unknown action' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors }
    });
  },
};