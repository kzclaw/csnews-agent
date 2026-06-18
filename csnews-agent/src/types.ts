// ============================================================
// 共享类型
// ============================================================
// 用途：跨模块共享的类型契约（避免每个模块各写各的形状）

// 注：Env 类型由 csnews-agent/src/cf-types.d.ts（ambient declaration）全局提供，
//     不需要在此 re-export。cf-types.d.ts 已经在 src/ 目录下，TypeScript 自动 include。

// 共享接口（从 csnews-agent/src/index.ts 抽出）
export interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  category?: string;
  hot_score?: number;
  published_at?: string;
  summary?: string;
}
