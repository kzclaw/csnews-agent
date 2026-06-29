-- Event Lifecycle 5-Stage — stage transition RPC
-- Transition rules (unidirectional):
--   detected → confirmed:  news_count >= 2
--   confirmed → growing:   news_count > 5 OR velocity > 0
--   growing  → hot:       velocity ≈ 0 AND news_count > 20
--   hot     → archived:  news_count < 5 for 24h (last_active_at)
-- Archived is terminal — no backward transitions.

CREATE OR REPLACE FUNCTION update_topic_event_stage(p_topic_id UUID)
RETURNS TEXT   -- returns the new event_stage (may equal old stage if no transition)
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_stage  TEXT;
  v_last_active  TIMESTAMPTZ;
  v_news_count   INT;
  v_velocity     NUMERIC;
  v_new_stage    TEXT;
BEGIN
  -- 1. Read current topic state
  SELECT event_stage, last_active_at
    INTO v_event_stage, v_last_active
  FROM topics
  WHERE id = p_topic_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- archived is terminal — never transition out
  IF v_event_stage = 'archived' THEN
    RETURN 'archived';
  END IF;

  -- 2. Current news_count from news_topic_members
  SELECT COUNT(*)::INT
    INTO v_news_count
  FROM news_topic_members
  WHERE topic_id = p_topic_id;

  -- 3. Latest velocity from trend_snapshots
  SELECT velocity
    INTO v_velocity
  FROM trend_snapshots
  WHERE topic_id = p_topic_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- Default to 0 if no snapshot exists yet
  v_velocity := COALESCE(v_velocity, 0);

  -- 4. Apply transition rules (unidirectional)
  v_new_stage := v_event_stage;

  IF v_event_stage = 'detected' AND v_news_count >= 2 THEN
    v_new_stage := 'confirmed';
  ELSIF v_event_stage = 'confirmed' AND (v_news_count > 5 OR v_velocity > 0) THEN
    v_new_stage := 'growing';
  ELSIF v_event_stage = 'growing' AND ABS(v_velocity) < 0.1 AND v_news_count > 20 THEN
    v_new_stage := 'hot';
  ELSIF v_event_stage = 'hot' AND v_news_count < 5
    AND (v_last_active IS NULL OR v_last_active < NOW() - INTERVAL '24 hours') THEN
    v_new_stage := 'archived';
  END IF;

  -- 5. Persist if changed
  IF v_new_stage <> v_event_stage THEN
    UPDATE topics
       SET event_stage = v_new_stage,
           updated_at   = NOW()
     WHERE id = p_topic_id;
  END IF;

  RETURN v_new_stage;
END;
$$;
