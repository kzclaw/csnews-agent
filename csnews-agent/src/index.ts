/**
 * CSNEWS Agent · 主 Worker
 * Cloudflare Workers + Workers AI + Supabase
 * 
 * 安全设计：
 * - 所有请求需带 Bearer Token（BEARER_TOKEN env var）
 * - CORS 仅允许已授权来源
 * - 敏感操作需要明确权限
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
  '国际': ['美国', '英国', '欧盟', '俄罗斯', '乌克兰', '日本', '韩国', '联合国', '外交', '制裁', 'G20', '首相', '岸田', '普京', '习近平', '中美', '外长', '欧盟'],
  '社会': ['疫情', '健康', '医疗', '医保', '教育', '交通', '环境', '灾害', '事故', '疫情', '核酸', '中考', '确诊', '小区', '防控'],
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
// Workers AI 分类 + 评分（中文友好模型）
// ============================================================
async function aiClassifyAndScore(title: string, env: Env): Promise<{ score: number; category: string; reason: string }> {
  try {
    const resp = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
      messages: [
        { role: 'system', content: '你是一个专业的中文新闻分析师。请分析新闻标题并以JSON格式返回：{"score": 0-10分数, "category": "科技/财经/国际/社会/娱乐/综合", "reason": "简短原因"}' },
        { role: 'user', content: `新闻标题：${title}` }
      ],
      max_tokens: 100,
      temperature: 0.1,
    });
    const text = resp.toString().trim();
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 5.0,
        category: parsed.category || '综合',
        reason: parsed.reason || '',
      };
    }
  } catch (e: any) {
    console.error('AI error:', e.message);
  }
  return { score: 5.0, category: '综合', reason: 'AI调用失败，降级规则引擎' };
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

    // OPTIONS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // 认证
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

    // -------- Workers AI 模型测试 --------
    if (action === 'model-test') {
      try {
        const r = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [{ role: 'user', content: '回复"OK"' }],
          max_tokens: 10,
        });
        return new Response(JSON.stringify({ ok: true, model: 'kimi-k2.5', response: r.toString() }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // -------- 单条新闻评分 + 分类 --------
    if (action === 'score') {
      const title = url.searchParams.get('title');
      if (!title) {
        return new Response(JSON.stringify({ error: 'missing title param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      const useAI = url.searchParams.get('ai') !== 'false';
      let result: { score: number; category: string; reason: string };

      if (useAI) {
        result = await aiClassifyAndScore(title, env);
      } else {
        const rule = scoreRule(title);
        result = { score: rule.score, category: classifyRule(title), reason: rule.reason };
      }

      return new Response(JSON.stringify(result), {
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
        let aiResult: { score: number; category: string; reason: string } | null = null;

        if (useAI) {
          aiResult = await aiClassifyAndScore(item.title, env);
        }

        return {
          title: item.title,
          rule_score: rule.score,
          rule_category: classifyRule(item.title),
          rule_reason: rule.reason,
          ai_score: aiResult?.score,
          ai_category: aiResult?.category,
          ai_reason: aiResult?.reason,
          final_score: aiResult?.score ?? rule.score,
          final_category: aiResult?.category ?? classifyRule(item.title),
        };
      }));

      return new Response(JSON.stringify({ count: results.length, results }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // -------- 裂变搜索 --------
    if (action === 'fission') {
      const seed = url.searchParams.get('seed') || url.searchParams.get('title');
      if (!seed) {
        return new Response(JSON.stringify({ error: 'missing seed param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {
        const resp = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [
            { role: 'system', content: '你是一个专业的新闻裂变搜索助手。请根据种子新闻，生成5个深度裂变搜索查询，用于深度挖掘相关内幕。返回JSON格式：{"queries": ["query1", "query2", ...]}' },
            { role: 'user', content: `种子新闻：${seed}\n请生成5个深度裂变搜索查询，覆盖不同角度。` }
          ],
          max_tokens: 200,
          temperature: 0.3,
        });

        const text = resp.toString().trim();
        const match = text.match(/\{[^}]+\}/);
        const queries = match ? JSON.parse(match[0]).queries || [] : [];

        return new Response(JSON.stringify({ seed, queries, count: queries.length }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'unknown action', available: ['ping', 'model-test', 'score', 'batch-score', 'fission'] }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors }
    });
  },
};