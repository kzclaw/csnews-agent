-- ============================================================
-- Migration: O12 Phase 3 — degraded flag
-- Date: 20260624
-- Contents:
--   1. Add degraded BOOLEAN DEFAULT false to warnings / fission_searches / knowledge
--   2. Add index on degraded field for query efficiency
-- ============================================================

-- 1. warnings
ALTER TABLE public.warnings ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_warnings_degraded ON public.warnings (degraded);

-- 2. fission_searches
ALTER TABLE public.fission_searches ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_fission_searches_degraded ON public.fission_searches (degraded);

-- 3. knowledge
ALTER TABLE public.knowledge ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_knowledge_degraded ON public.knowledge (degraded);
