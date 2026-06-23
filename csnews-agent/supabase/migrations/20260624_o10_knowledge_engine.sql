-- ============================================================
-- Migration: Knowledge Engine schema
-- Date: 20260624
-- Contents:
--   1. knowledge table (id / topic_id / insight / confidence / r2_key / created_at)
--   2. knowledge_rls: enable RLS for knowledge table
-- ============================================================

-- 1. knowledge table
CREATE TABLE IF NOT EXISTS public.knowledge (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id    UUID        NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
  warning_id  UUID        REFERENCES public.warnings(id) ON DELETE SET NULL,
  insight     TEXT        NOT NULL,
  confidence  NUMERIC(3,2) NOT NULL DEFAULT 0.5,
  r2_key      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_topic_id    ON public.knowledge (topic_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_warning_id  ON public.knowledge (warning_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_created_at   ON public.knowledge (created_at DESC);

-- 2. RLS: allow service role full access, anon read-only
ALTER TABLE public.knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "knowledge_service_role_all" ON public.knowledge;
CREATE POLICY "knowledge_service_role_all"
  ON public.knowledge
  FOR ALL
  TO authenticated
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "knowledge_anon_read" ON public.knowledge;
CREATE POLICY "knowledge_anon_read"
  ON public.knowledge
  FOR SELECT
  TO authenticated
  USING (true);
