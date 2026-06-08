// ============================================================
// 共享类型（v0.33+sweep·FT-KR0 新增 · Foundation 0 第 1 步）
// ============================================================
// 用途：跨模块共享的类型契约（避免每个模块各写各的形状）
// 详见：tasks/csnews-agent-okr.md v0.33+sweep·FT-KR0 · KR0
//       specs/001-kr17-split-index-ts/{spec.md,plan.md,tasks.md}

// 注：Env 类型由 csnews-agent/src/cf-types.d.ts（ambient declaration）全局提供，
//     不需要在此 re-export。cf-types.d.ts 已经在 src/ 目录下，TypeScript 自动 include。

// 共享接口（从 csnews-agent/src/index.ts line 118-126 抽出 · T000 阶段）
// 后续 T000 抽 endpoints.ts 时会从 index.ts 删 inline 定义，改为 import from './types'
export interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
}
