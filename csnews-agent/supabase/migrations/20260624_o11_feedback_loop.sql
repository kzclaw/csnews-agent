-- ============================================================
-- Migration: O11 Feedback Loop schema
-- Date: 20260624
-- Contents:
--   1. score_rule_weights table (hot-word weight tuning)
--   2. warnings table additions (feedback_status, category)
--   3. record_feedback RPC (checkpoint validation logic)
-- ============================================================

-- 1. score_rule_weights table
CREATE TABLE IF NOT EXISTS public.score_rule_weights (
  category    TEXT        NOT NULL,
  hot_word    TEXT        NOT NULL,
  weight      NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, hot_word)
);
CREATE INDEX IF NOT EXISTS idx_score_rule_weights_category ON public.score_rule_weights (category);

-- 2. warnings table additions (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'warnings'
      AND column_name  = 'feedback_status'
  ) THEN
    ALTER TABLE public.warnings
      ADD COLUMN feedback_status TEXT DEFAULT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'warnings'
      AND column_name  = 'category'
  ) THEN
    ALTER TABLE public.warnings
      ADD COLUMN category TEXT DEFAULT NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_warnings_feedback_status
  ON public.warnings (feedback_status)
  WHERE feedback_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warnings_topic_created
  ON public.warnings (topic_id, created_at DESC)
  WHERE status = 'open';

-- 3. record_feedback RPC
CREATE OR REPLACE FUNCTION public.record_feedback(
  p_warning_id     UUID,
  p_check_hour     INT,
  p_topic_score_now NUMERIC
)
RETURNS TABLE (feedback_status TEXT, accuracy NUMERIC, correct INT, total INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_warning          RECORD;
  v_score_at_creation NUMERIC;
  v_feedback_status   TEXT;
  v_category          TEXT;
  v_correct           INT;
  v_total             INT;
  v_accuracy          NUMERIC;
BEGIN
  SELECT
    w.id,
    w.topic_id,
    w.category,
    w.feedback_status,
    w.created_at AS warning_created_at,
    t.score      AS score_at_creation
  INTO v_warning
  FROM warnings w
  JOIN topics t ON t.id = w.topic_id
  WHERE w.id = p_warning_id
    AND w.status = 'open';

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC, 0::INT, 0::INT;
    RETURN;
  END IF;

  v_category          := COALESCE(v_warning.category, 'unknown');
  v_score_at_creation := COALESCE(v_warning.score_at_creation, 0);

  -- Check-hour logic:
  -- 24h: no judgment yet (keep pending)
  -- 48h: preliminary — still hot = validated
  -- 72h: final — still hot = validated, cooled = dismissed
  IF p_check_hour < 48 THEN
    v_feedback_status := 'pending';
  ELSIF p_check_hour < 72 THEN
    IF p_topic_score_now >= v_score_at_creation THEN
      v_feedback_status := 'validated';
    ELSE
      v_feedback_status := 'pending';
    END IF;
  ELSE
    IF p_topic_score_now >= v_score_at_creation THEN
      v_feedback_status := 'validated';
    ELSE
      v_feedback_status := 'dismissed';
    END IF;
  END IF;

  UPDATE warnings
  SET feedback_status = v_feedback_status
  WHERE id = p_warning_id;

  -- Category-level accuracy: correct / judged
  SELECT
    COUNT(*) FILTER (WHERE feedback_status = 'validated')::INT,
    COUNT(*) FILTER (WHERE feedback_status IN ('validated', 'dismissed'))::INT
  INTO v_correct, v_total
  FROM warnings
  WHERE category = v_category
    AND feedback_status IN ('validated', 'dismissed');

  v_total   := GREATEST(v_total, 1);
  v_accuracy := ROUND(v_correct::NUMERIC / v_total, 4);

  RETURN QUERY SELECT v_feedback_status, v_accuracy, v_correct, v_total;
END;
$fn$;
