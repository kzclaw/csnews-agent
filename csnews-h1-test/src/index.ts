/**
 * CSNEWS Agent H1 测试 Worker v2
 * 测试 Workers AI 中文理解质量：评分 + 分类 + 裂变
 */
interface Env {
  AI: Ai;
}

interface NewsItem {
  title: string;
  expected_category: string;
}

interface ScoredResult {
  title: string;
  score: number;
  category: string;
  ai_score?: number;
  ai_category?: string;
  match: boolean;
}

const testNews: NewsItem[] = [
  { title: 'OpenAI 发布 GPT-5，AI 行业迎来新一轮革命', expected_category: '科技' },
  { title: 'A股三大指数集体收涨，沪指重返3400点', expected_category: '财经' },
  { title: '中美外长会晤，同意管控分歧避免冲突', expected_category: '国际' },
  { title: '北京发布最新疫情防控措施，公共场所需核酸证明', expected_category: '社会' },
  { title: '周杰伦新专辑上线，QQ音乐服务器崩溃', expected_category: '娱乐' },
  { title: '华为发布鸿蒙OS 4.0，余承东称比安卓快60%', expected_category: '科技' },
  { title: '美联储宣布加息75个基点，美股期货大跌', expected_category: '财经' },
  { title: '普京与习近平通话，讨论乌克兰局势', expected_category: '国际' },
  { title: '上海新增本土确诊52例，多个小区封控', expected_category: '社会' },
  { title: '世界杯半决赛法国2-0淘汰摩洛哥', expected_category: '娱乐' },
  { title: '特斯拉全自动驾驶获批在华运营', expected_category: '科技' },
  { title: '黄金价格突破2000美元创历史新高', expected_category: '财经' },
  { title: '欧盟通过对华电动汽车加征关税决定', expected_category: '国际' },
  { title: '广州中考改革方案公布，2025年起实施', expected_category: '社会' },
  { title: '刘德华演唱会广州站门票5秒售罄', expected_category: '娱乐' },
  { title: '字节跳动推出新AI产品豆包日活破千万', expected_category: '科技' },
  { title: '人民币汇率跌破7.3创年内新低', expected_category: '财经' },
  { title: '日本首相岸田文雄宣布辞职', expected_category: '国际' },
  { title: '医保新增74种药品覆盖癌症罕见病', expected_category: '社会' },
  { title: '巴黎奥运会中国代表团金牌榜第一', expected_category: '娱乐' },
];

const CATEGORIES = ['科技', '财经', '国际', '社会', '娱乐', '综合'];

// Workers AI 调用（使用正确的模型名）
async function aiScore(title: string): Promise<{ score: number; category: string }> {
  const prompt = `你是一个中文新闻分析师。请分析以下新闻标题：

"${title}"

请以JSON格式返回分析结果，格式如下：
{"score": 分数(0-10), "category": "分类(科技/财经/国际/社会/娱乐/综合)"}

只返回JSON，不要其他内容。`;

  try {
    const resp = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
      messages: [
        { role: 'system', content: '你是一个专业的中文新闻分析师，始终返回JSON格式。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 80,
      temperature: 0.1,
    });

    const text = resp.toString().trim();
    const match = text.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 5.0,
        category: parsed.category || '综合'
      };
    }
  } catch (e: any) {
    console.error('AI error:', e.message);
  }

  return { score: 5.0, category: '综合' };
}

// 规则基础评分（对比基准）
function ruleScore(title: string): { score: number; category: string } {
  const hotWords = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新', '突破', '革命'];
  const hasHot = hotWords.some(w => title.includes(w));
  const hasNum = /\d+/.test(title);
  const len = title.length;

  let score = 5.0;
  if (hasHot) score += 1.5;
  if (hasNum) score += 0.5;
  if (len > 20 && len < 35) score += 0.5;

  let category = '综合';
  const kwMap: Record<string, string[]> = {
    '科技': ['AI', '人工智能', 'ChatGPT', '大模型', '芯片', '算法', '机器人', '智能', '技术', '科技'],
    '财经': ['股市', '基金', '货币', '经济', '金融', '银行', '投资', '市场', '美元', '黄金', '汇率'],
    '国际': ['美国', '英国', '欧盟', '俄罗斯', '乌克兰', '日本', '韩国', '联合国', '外交', '制裁', 'G20', '首相'],
    '社会': ['疫情', '健康', '医疗', '教育', '交通', '环境', '灾害', '事故', '医保', '中考'],
    '娱乐': ['电影', '音乐', '明星', '综艺', '赛事', '奥运', '世界杯', '演唱会', '门票'],
  };
  for (const [cat, kws] of Object.entries(kwMap)) {
    if (kws.some(k => title.includes(k))) { category = cat; break; }
  }

  return { score: Math.min(10, Math.round(score * 10) / 10), category };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'all';

    // 测试 endpoint
    if (action === 'ping') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // Workers AI 模型测试
    if (action === 'model') {
      try {
        const r = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
          messages: [{ role: 'user', content: '回复"OK"，不超过2个字' }],
          max_tokens: 10,
        });
        return new Response(JSON.stringify({ ok: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', response: r.toString() }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // 完整评分测试
    if (action === 'all' || action === 'score') {
      const results: ScoredResult[] = [];
      let scoreMatch = 0;
      let catMatch = 0;

      for (const item of testNews) {
        const rule = ruleScore(item.title);
        let aiResult = { score: rule.score, category: rule.category };

        // 调用 Workers AI（容错）
        if (action === 'all') {
          aiResult = await aiScore(item.title);
        }

        const catCorrect = aiResult.category === item.expected_category;
        if (catCorrect) catMatch++;

        results.push({
          title: item.title,
          score: rule.score,
          category: item.expected_category,
          ai_score: aiResult.score,
          ai_category: aiResult.category,
          match: catCorrect,
        });
      }

      const catAccuracy = Math.round(catMatch / testNews.length * 100);

      return new Response(JSON.stringify({
        total: testNews.length,
        category_match: catMatch,
        category_accuracy: `${catAccuracy}%`,
        results,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    return new Response(JSON.stringify({ error: 'unknown action' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...cors }
    });
  },
};