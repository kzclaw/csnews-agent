-- ============================================================
-- Migration: record_feedback RPC
-- Purpose: O11 Feedback Loop core RPC
--          Called by Workers at 24/48/72h checkpoints to:
--            1. Fetch current topic_score from topics table
--            2. Compare with score at warning creation time
--            3. Determine if warning was correct (topic still hot = validated, cooled = dismissed)
--            4. Update feedback_status on the warning
--            5. Return feedback_status + category-level accuracy
-- Accuracy formula: accuracy = correct / total (per category)
-- Check-hour logic: 24h=no-judgment / 48h=preliminary / 72h=final
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_feedback(
  p_warning_id    UUID,
  p_check_hour    INT,    -- 24 | 48 | 72
  p_topic_score_now NUMERIC  -- current topic.score at check time
)
RETURNS TABLE (
  feedback_status  TEXT,
  accuracy        NUMERIC,
  correct         INT,
  total           INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_warning RECORD;
  v_topic   RECORD;
  v_score_at_creation NUMERIC;
  v_feedback_status TEXT;
  v_category TEXT;
  v_correct  INT;
  v_total    INT;
  v_accuracy NUMERIC;
BEGIN
  -- Fetch warning + topic in one shot
  SELECT
    w.id,
    w.topic_id,
    w.category,
    w.feedback_status,
    w.created_at AS warning_created_at,
    t.score    AS score_at_creation
  INTO v_warning
  FROM warnings w
  JOIN topics t ON t.id = w.topic_id
  WHERE w.id = p_warning_id
    AND w.status = 'open';

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::NUMERIC, 0::INT, 0::INT;
    RETURN;
  END IF;

  v_category := COALESCE(v_warning.category, 'unknown');
  v_score_at_creation := COALESCE(v_warning.score_at_creation, 0);

  -- Check-hour logic:
  -- 24h: no judgment yet, skip (keep pending)
  -- 48h: preliminary — topic_score_now >= score_at_creation → validated
  -- 72h: final — topic_score_now < score_at_creation → dismissed (cooling down)
  IF p_check_hour < 48 THEN
    v_feedback_status := 'pending';
    -- No accuracy change at 24h checkpoint
  ELSIF p_check_hour < 72 THEN
    -- Preliminary at 48h: topic still hot or hotter = validated
    IF p_topic_score_now >= v_score_at_creation THEN
      v_feedback_status := 'validated';
    ELSE
      v_feedback_status := 'pending'; -- might recover by 72h, keep pending
    END IF;
  ELSE
    -- Final at 72h: topic cooled = dismissed, still hot = validated
    IF p_topic_score_now >= v_score_at_creation THEN
      v_feedback_status := 'validated';
    ELSE
      v_feedback_status := 'dismissed';
    END IF;
  END IF;

  -- Write back feedback_status
  UPDATE warnings
  SET feedback_status = v_feedback_status
  WHERE id = p_warning_id;

  -- Calculate category-level accuracy:
  -- correct = validated count in this category (warning was correct)
  -- total   = validated + dismissed count in this category (judged warnings only)
  SELECT
    COUNT(*) FILTER (WHERE feedback_status = 'validated')::INT,
    COUNT(*) FILTER (WHERE feedback_status IN ('validated', 'dismissed'))::INT
  INTO v_correct, v_total
  FROM warnings
  WHERE category = v_category
    AND feedback_status IN ('validated', 'dismissed');

  v_total := GREATEST(v_total, 1); -- avoid division by zero
  v_accuracy := ROUND(v_correct::NUMERIC / v_total, 4);

  RETURN QUERY SELECT v_feedback_status, v_accuracy, v_correct, v_total;
END;
$fn$;
