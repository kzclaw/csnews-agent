DROP FUNCTION IF EXISTS public.record_trend_with_member(UUID, UUID, BOOLEAN);

CREATE FUNCTION public.record_trend_with_member(
  p_news_id UUID,
  p_topic_id UUID,
  p_is_seed BOOLEAN
)
RETURNS TABLE (
  snapshot_id UUID,
  warning_id UUID,
  out_velocity NUMERIC,
  out_acceleration NUMERIC,
  out_stage TEXT,
  out_warning_created BOOLEAN
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_role TEXT;
  v_topic RECORD;
  v_news_count INT;
  v_signal_score NUMERIC;
  v_prev trend_snapshots%ROWTYPE;
  v_hours NUMERIC;
  v_velocity NUMERIC := 0;
  v_acceleration NUMERIC := 0;
  v_stage TEXT := 'emerging';
  v_snapshot_id UUID;
  v_warning_id UUID;
  v_recent_warning BOOLEAN := FALSE;
  v_severity INT := 3;
BEGIN
  v_role := CASE WHEN p_is_seed THEN 'seed' ELSE 'follow' END;
  INSERT INTO news_topic_members (news_id, topic_id, role)
  VALUES (p_news_id, p_topic_id, v_role);

  SELECT id, level, score INTO v_topic
  FROM topics WHERE id = p_topic_id;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*)::INT INTO v_news_count
  FROM news_topic_members WHERE topic_id = p_topic_id;

  v_signal_score := COALESCE(v_topic.score, 0) + COALESCE(v_news_count, 0);

  SELECT signal_score, velocity, created_at INTO v_prev
  FROM trend_snapshots
  WHERE topic_id = p_topic_id
  ORDER BY created_at DESC LIMIT 1;

  IF FOUND THEN
    v_hours := GREATEST(EXTRACT(EPOCH FROM (NOW() - v_prev.created_at)) / 3600.0, 0.001);
    v_velocity := ROUND((v_signal_score - v_prev.signal_score) / v_hours, 4);
    v_acceleration := ROUND((v_velocity - v_prev.velocity) / v_hours, 4);
  END IF;

  IF v_velocity < 0 THEN v_stage := 'declining';
  ELSIF v_topic.level = 'explosive' OR v_signal_score >= 10 THEN v_stage := 'hot';
  ELSIF v_velocity > 0 AND v_signal_score >= 5 THEN v_stage := 'growing';
  ELSIF v_velocity = 0 AND v_signal_score >= 5 THEN v_stage := 'mature';
  ELSE v_stage := 'emerging';
  END IF;

  INSERT INTO trend_snapshots (topic_id, topic_level, topic_score, news_count, signal_score, velocity, acceleration, stage)
  VALUES (p_topic_id, v_topic.level, v_topic.score, v_news_count, v_signal_score, v_velocity, v_acceleration, v_stage)
  RETURNING id INTO v_snapshot_id;

  SELECT EXISTS (SELECT 1 FROM warnings WHERE topic_id = p_topic_id AND warning_type = 'acceleration' AND created_at > NOW() - INTERVAL '24 hours' AND status IN ('open', 'acknowledged')) INTO v_recent_warning;

  IF v_velocity > 0 AND v_acceleration > 0 AND NOT v_recent_warning THEN
    v_severity := CASE WHEN v_topic.level = 'explosive' THEN 5 WHEN v_topic.level = 'important' THEN 4 WHEN v_acceleration >= 3 THEN 4 ELSE 3 END;
    INSERT INTO warnings (topic_id, snapshot_id, warning_type, severity, reason)
    VALUES (p_topic_id, v_snapshot_id, 'acceleration', v_severity, 'velocity=' || v_velocity || ', acceleration=' || v_acceleration || ', signal_score=' || v_signal_score)
    RETURNING id INTO v_warning_id;
  END IF;

  RETURN QUERY SELECT v_snapshot_id, v_warning_id, v_velocity, v_acceleration, v_stage, (v_warning_id IS NOT NULL);
END;
$fn$;
