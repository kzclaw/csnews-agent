-- ============================================================
-- Migration: score_rule_weights table
-- Purpose: Store configurable hot-word weights per category
--          for the O11 Feedback Loop accuracy tuning system.
-- Usage: O11 Feedback Loop reads/writes weights here;
--        scoreRule() in Workers queries this table.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.score_rule_weights (
  category TEXT NOT NULL,
  hot_word TEXT NOT NULL,
  weight NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, hot_word)
);

-- Cluster for fast lookups by category (O11 Feedback Loop reads all weights per category)
CREATE INDEX IF NOT EXISTS idx_score_rule_weights_category ON public.score_rule_weights (category);

COMMENT ON TABLE public.score_rule_weights IS 'O11 Feedback Loop: per-category hot-word weights for scoreRule tuning';
COMMENT ON COLUMN public.score_rule_weights.category IS 'Topic category, e.g. tech/business/politics';
COMMENT ON COLUMN public.score_rule_weights.hot_word IS 'Hot keyword, e.g. 突发/震惊/重磅';
COMMENT ON COLUMN public.score_rule_weights.weight IS 'Multiplier applied to this hot_word when scoring titles (default 1.0)';
COMMENT ON COLUMN public.score_rule_weights.updated_at IS 'Last time this weight was adjusted by Feedback Loop';
