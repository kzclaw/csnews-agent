// ============================================================
// Worker AI工具函数（v0.33+sweep·FT-KR0 · Phase0 · T000 helper）
// ============================================================
//用途：抽离 index.ts 的 Workers AI响应解析 +裂变报告生成函数
// 让 endpoints.ts 不依赖 index.ts（避免循环依赖）
//详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
// specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}
import { Env } from './shared';
import { AI_ROUTE_R_THRESHOLD } from './score';

//Workers AI响应解析
// env.AI.run() 返回格式:{ response: string, usage: {...} }
export function extractText(resp: any): string {
 if (typeof resp === 'string') return resp.trim();
 if (resp && typeof resp === 'object') {
 const text = (resp.response || '').trim();
 if (text) return text;
 }
 return '';
}

//Workers AI裂变报告生成
// KR0: only call AI when R >= AI_ROUTE_R_THRESHOLD
// NOTE: scoreRule max=7.6, threshold must be <=7.6 to be reachable
export async function maybeFissionReport(title: string, env: Env, rScore: number): Promise<string> {
 if (rScore < AI_ROUTE_R_THRESHOLD) return `(AI跳过-R<${AI_ROUTE_R_THRESHOLD})`;
 try {
 const resp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
 messages: [
 { role: 'user', content: `根据以下新闻，生成一段50字左右的裂变分析报告：\n\n${title}` }
 ],
 max_tokens:200,
 temperature:0.3,
 }) as any;
 return extractText(resp) || '(无AI输出)';
 } catch (e: any) {
 return `(AI错误: ${e.message})`;
 }
}
