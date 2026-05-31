-- CSNEWS Agent · TIE-lite Trend Snapshot + Warning Layer
-- 2026-05-31
--
-- Free-tier design:
-- - Keep all trend/warning computation in PostgreSQL and Worker rules.
-- - Do not call LLMs in the main processing path.
-- - Store only compact metrics in Supabase; long explanations can later go to R2.

CREATE TABLE IF NOT EXISTS trend_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  topic_level TEXT NOT NULL CHECK (topic_level IN ('follow', 'important', 'explosive')),
  topic_score INT NOT NULL CHECK (topic_score >= 0 AND topic_score <= 9),
  news_count INT NOT NULL DEFAULT 0 CHECK (news_count >= 0),
  signal_score NUMERIC NOT NULL DEFAULT 0,
  velocity NUMERIC NOT NULL DEFAULT 0,
  acceleration NUMERIC NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'emerging'
    CHECK (stage IN ('emerging', 'growing', 'hot', 'mature', 'declining')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warnings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES trend_snapshots(id) ON DELETE SET NULL,
  warning_type TEXT NOT NULL DEFAULT 'acceleration',
  severity INT NOT NULL DEFAULT 3 CHECK (severity >= 1 AND severity <= 5),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'validated', 'dismissed', 'closed')),
  report_r2_key TEXT,
  validated BOOLEAN DEFAULT FALSE,
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE trend_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE warnings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_trend_snapshots_topic_created
  ON trend_snapshots(topic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trend_snapshots_stage_created
  ON trend_snapshots(stage, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warnings_topic_created
  ON warnings(topic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warnings_status_created
  ON warnings(status, created_at DESC);

CREATE OR REPLACE FUNCTION record_trend_snapshot(p_topic_id UUID)
RETURNS TABLE (
  snapshot_id UUID,
  warning_id UUID,
  velocity NUMERIC,
  acceleration NUMERIC,
  stage TEXT,
  warning_created BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_topic RECORD;
  v_news_count INT;
  v_signal_score NUMERIC;
  v_prev RECORD;
  v_hours NUMERIC;
  v_velocity NUMERIC := 0;
  v_acceleration NUMERIC := 0;
  v_stage TEXT := 'emerging';
  v_snapshot_id UUID;
  v_warning_id UUID;
  v_recent_warning BOOLEAN := FALSE;
  v_severity INT := 3;
BEGIN
  SELECT id, level, score
    INTO v_topic
  FROM topics
  WHERE id = p_topic_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INT
    INTO v_news_count
  FROM news_topic_members
  WHERE topic_id = p_topic_id;

  v_signal_score := COALESCE(v_topic.score, 0) + COALESCE(v_news_count, 0);

  SELECT signal_score, velocity, created_at
    INTO v_prev
  FROM trend_snapshots
  WHERE topic_id = p_topic_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_hours := GREATEST(EXTRACT(EPOCH FROM (NOW() - v_prev.created_at)) / 3600.0, 0.001);
    v_velocity := ROUND((v_signal_score - v_prev.signal_score) / v_hours, 4);
    v_acceleration := ROUND((v_velocity - v_prev.velocity) / v_hours, 4);
  END IF;

  IF v_velocity < 0 THEN
    v_stage := 'declining';
  ELSIF v_topic.level = 'explosive' OR v_signal_score >= 10 THEN
    v_stage := 'hot';
  ELSIF v_velocity > 0 AND v_signal_score >= 5 THEN
    v_stage := 'growing';
  ELSIF v_velocity = 0 AND v_signal_score >= 5 THEN
    v_stage := 'mature';
  ELSE
    v_stage := 'emerging';
  END IF;

  INSERT INTO trend_snapshots (
    topic_id,
    topic_level,
    topic_score,
    news_count,
    signal_score,
    velocity,
    acceleration,
    stage
  )
  VALUES (
    p_topic_id,
    v_topic.level,
    v_topic.score,
    v_news_count,
    v_signal_score,
    v_velocity,
    v_acceleration,
    v_stage
  )
  RETURNING id INTO v_snapshot_id;

  SELECT EXISTS (
    SELECT 1
    FROM warnings
    WHERE topic_id = p_topic_id
      AND warning_type = 'acceleration'
      AND created_at > NOW() - INTERVAL '24 hours'
      AND status IN ('open', 'acknowledged')
  ) INTO v_recent_warning;

  IF v_velocity > 0 AND v_acceleration > 0 AND NOT v_recent_warning THEN
    v_severity := CASE
      WHEN v_topic.level = 'explosive' THEN 5
      WHEN v_topic.level = 'important' THEN 4
      WHEN v_acceleration >= 3 THEN 4
      ELSE 3
    END;

    INSERT INTO warnings (
      topic_id,
      snapshot_id,
      warning_type,
      severity,
      reason
    )
    VALUES (
      p_topic_id,
      v_snapshot_id,
      'acceleration',
      v_severity,
      'velocity=' || v_velocity || ', acceleration=' || v_acceleration || ', signal_score=' || v_signal_score
    )
    RETURNING id INTO v_warning_id;
  END IF;

  RETURN QUERY
  SELECT
    v_snapshot_id,
    v_warning_id,
    v_velocity,
    v_acceleration,
    v_stage,
    v_warning_id IS NOT NULL;
END;
$$;
