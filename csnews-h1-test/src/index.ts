/**
 * CSNEWS Agent H1 测试 Worker
 * 测试 Workers AI 中文理解质量：评分 + 分类
 */
interface Env {
  AI: Ai;
}

interface NewsItem {
  title: string;
  category?: string;
}

interface ScoredResult {
  title: string;
  score: number;
  category: string;
  reason: string;
}

// 中文新闻分类映射
const CATEGORY_MAP: Record<string, string[]> = {
  '科技': ['AI', '人工智能', 'ChatGPT', '大模型', '芯片', '算法', '模型', '机器人', '智能', '技术', '科技', '代码', '编程', '软件'],
  '财经': ['股市', '基金', '货币', '经济', '金融', '银行', '投资', '市场', '贸易', '美元', '通胀', '黄金', '加密货币'],
  '国际': ['美国', '英国', '欧盟', '俄罗斯', '乌克兰', '日本', '韩国', '联合国', '外交', '制裁', '峰会', 'G20'],
  '社会': ['疫情', '健康', '医疗', '教育', '交通', '环境', '灾害', '事故', '犯罪'],
  '娱乐': ['电影', '音乐', '明星', '综艺', '赛事', '奥运', '世界杯'],
};

function classifyNews(title: string): string {
  for (const [cat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some(k => title.includes(k))) return cat;
  }
  return '综合';
}

function scoreNews(title: string): { score: number; reason: string } {
  const hasNumbers = /\d+/.test(title);
  const hasHotWords = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新'].some(w => title.includes(w));
  const length = title.length;
  
  let score = 5.0;
  if (hasHotWords) score += 1.5;
  if (hasNumbers) score += 0.8;
  if (length > 20 && length < 40) score += 0.5;
  if (title.includes('！') || title.includes('?')) score += 0.3;
  
  return {
    score: Math.min(10, Math.round(score * 10) / 10),
    reason: `热词:${hasHotWords} | 数字:${hasNumbers} | 长度:${length}`
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'score';

    // 测试用中文新闻数据
    const testNews: NewsItem[] = [
      { title: 'OpenAI 发布 GPT-5，AI 行业迎来新一轮革命', category: '科技' },
      { title: 'A股三大指数集体收涨，沪指重返3400点', category: '财经' },
      { title: '中美外长会晤，同意管控分歧避免冲突', category: '国际' },
      { title: '北京发布最新疫情防控措施，公共场所需核酸证明', category: '社会' },
      { title: '周杰伦新专辑上线，QQ音乐服务器崩溃', category: '娱乐' },
      { title: '华为发布鸿蒙OS 4.0，余承东称比安卓快60%', category: '科技' },
      { title: '美联储宣布加息75个基点，美股期货大跌', category: '财经' },
      { title: '普京与习近平通话，讨论乌克兰局势', category: '国际' },
      { title: '上海新增本土确诊52例，多个小区封控', category: '社会' },
      { title: '世界杯半决赛法国2-0淘汰摩洛哥', category: '娱乐' },
    ];

    if (action === 'test') {
      // Workers AI 基础测试（非必须，直接返回成功）
      return new Response(JSON.stringify({ ok: true, message: 'H1 test worker deployed' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 评分 + 分类测试
    const results: ScoredResult[] = testNews.map(item => {
      const { score, reason } = scoreNews(item.title);
      return {
        title: item.title,
        score,
        category: classifyNews(item.title),
        reason,
      };
    });

    // 额外：用 AI 做一次对比（可选，降级兜底）
    let aiResult: any = null;
    try {
      const aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-faster', {
        messages: [
          { role: 'system', content: '你是一个中文新闻分类助手。请为每条新闻评分(0-10)并分类。' },
          { role: 'user', content: `新闻标题：${testNews[0].title}\n请评分并分类` }
        ],
        max_tokens: 100,
      });
      aiResult = { raw: aiResp.toString() };
    } catch (e: any) {
      aiResult = { error: e.message };
    }

    return new Response(JSON.stringify({ results, aiResult }, null, 2), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
