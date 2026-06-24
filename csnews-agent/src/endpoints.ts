// ============================================================
// endpoints.ts · v0.36.20 · csnews-audit 修复 · 薄壳 re-export
// ============================================================
// 用途：20 个 action handler 的对外统一入口（保持 dispatch.ts / scheduled.ts
//       的 import 路径不变）
//
// v0.36.20 拆 4 文件 (audit 2026-06-18 4:30 · endpoints.ts 2,071 行超长):
//   - endpoints-core.ts    · 12 handler (pull/ping/model-test/ai-test/score/
//                                 classify/batch-score/fission/save/list/embed/
//                                 zaker-hot)
//   - endpoints-process.ts ·  3 handler (process/health/logs)
//   - endpoints-trend.ts   ·  3 handler + 1 helper (content/trend/knowledge/
//                                 runKnowledgeAccumulation)
//   - endpoints-entity.ts  ·  2 handler (entity/event)
//
// v0.36.26: 新增 MCP Server (O13-MCP)
//   - mcp-handler.ts · 6 个 MCP 工具 (stateless HTTP + JSON-RPC 2.0)
//
// 业务契约：
//   - 公开 API 不变：所有 handler 仍从 './endpoints' 导入
//   - dispatch.ts 0 改动 · scheduled.ts 0 改动
//   - 新代码应直接 import 对应子文件 (core/process/trend/entity/mcp)
//   - 本文件仅 re-export, 0 业务逻辑
// ============================================================

// core (13)
export {
  handlePullAction,
  handlePingAction,
  handleModelTestAction,
  handleAiTestAction,
  handleScoreAction,
  handleClassifyAction,
  handleBatchScoreAction,
  handleFissionAction,
  handleSaveAction,
  handleListAction,
  handleEmbedAction,
  handleZakerHotAction,
  handleRescoreAction,
} from './endpoints-core';

// process (4)
export {
  handleProcessAction,
  handleHealthAction,
  handleAiUsageAction,
  handleLogsAction,
  handleTavilyAction,
} from './endpoints-process';

// trend (3) + helpers
export {
  handleContentAction,
  handleTrendAction,
  handleKnowledgeAction,
  runKnowledgeAccumulation,
  runKnowledgeGeneration,
} from './endpoints-trend';

// entity (2)
export { handleEntityAction, handleEventAction } from './endpoints-entity';

// mcp (2) — O13-MCP MCP Server
export { handleMCPAction, handleMCPListAction } from './mcp-handler';

// proxy (1) — Reader 浮窗 Readability 模式 (v0.37)
export { handleProxyAction } from './endpoints-proxy';
