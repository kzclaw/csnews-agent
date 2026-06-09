// ============================================================
//评分规则 +路由常量（v0.33+sweep·FT-KR0 · Phase0 · T000）
// ============================================================
//用途：标题评分（热词/超热/数字/长度）+3 个路由阈值常量
// + hashStr工具（用于 topic_key 生成）
//详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
// specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}
//
// NOTE: scoreRule max=7.6, AI_ROUTE_R_THRESHOLD 必须 <=7.6 才能 reachable

// R threshold for Workers AI routing (KR0: Neurons saving)
// NOTE: scoreRule max=8.6 (5 base + 2 superHot + 0.5 num + 0.3 len + 0.3 ! + 0.5 hotCount>=3)
//       threshold must be <= 8.6 to be reachable
export const AI_ROUTE_R_THRESHOLD =7.0;
export const TOPIC_MATCH_THRESHOLD =0.72;
export const R2_DUP_THRESHOLD =0.88;

//简单字符串哈希(用于 topic_key 生成)
export function hashStr(s: string): number {
let h =0;
for (let i =0; i < s.length; i++) {
h = (Math.imul(31, h) + s.charCodeAt(i)) |0;
}
return h;
}

// ============================================================
//评分规则
// ============================================================
export function scoreRule(title: string): { score: number; reason: string; isHigh: boolean } {
const hotWords = ['突发', '震惊', '重磅', '紧急', '首次', '史上', '最新', '突破', '革命', '创历史'];
const superHot = ['紧急', '突发', '重磅'];
const hasSuperHot = superHot.some(w => title.includes(w));
const hasHot = hotWords.some(w => title.includes(w));
const hasNum = /\d+/.test(title);
const hasExclaim = title.includes('!') || title.includes('?');
const len = title.length;
let score =5.0;
if (hasSuperHot) score +=2.0;
else if (hasHot) score +=1.2;
if (hasNum) score +=0.5;
if (len >20 && len <35) score +=0.3;
if (hasExclaim) score +=0.3;
const hotCount = hotWords.filter(w => title.includes(w)).length;
if (hotCount >=3) score +=0.5;
else if (hotCount >=2) score +=0.3;
score = Math.min(10, Math.round(score *10) /10);
return { score, reason: `热词:${hasHot} 超热:${hasSuperHot}数字:${hasNum} 长:${len} 多热:${hotCount}`, isHigh: score >= AI_ROUTE_R_THRESHOLD };
}
