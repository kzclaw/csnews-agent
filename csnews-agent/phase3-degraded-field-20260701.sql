-- Phase 3 degradation markers (AI Neurons 预算控制 · 降级策略)
-- 2026-07-01
--
-- 给 warnings / knowledge 两张表加 degraded 字段：
--   - degraded = true  → AI 调用因 budget 超限被降级（非正常 LLM 产出）
--   - degraded = false (default) → 正常 LLM 产出
--
-- 业务下游（manual review queue / 业务统计 / data export）通过
--   `?degraded=true` 过滤出"今天因 budget 超限被降级的 records"。
--
-- 字段语义：
--   warnings.degraded   = L4 warning 未走 LLM 深度分析（手动 review 候选）
--   knowledge.degraded  = L6 knowledge 写空 insight（明天 retry 候选）
--
-- fission_searches 表在 csnews-fission worker 项目里，本文件不处理。

ALTER TABLE public.warnings
  ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;

ALTER TABLE public.knowledge
  ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;

-- 索引（按 degraded 过滤时的常见查询模式）
CREATE INDEX IF NOT EXISTS idx_warnings_degraded_created
  ON public.warnings (degraded, created_at DESC)
  WHERE degraded = true;

CREATE INDEX IF NOT EXISTS idx_knowledge_degraded_created
  ON public.knowledge (degraded, created_at DESC)
  WHERE degraded = true;