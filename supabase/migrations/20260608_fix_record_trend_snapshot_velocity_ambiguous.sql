-- CSNEWS Agent · TIE-lite Fix v2: 真正消除 PL/pgSQL 歧义 (v0.30.1)
-- 2026-06-08 17:10
--
-- 之前 (v0.30) 只在 RETURN QUERY 加 AS 别名,但函数体内 v_prev.velocity
-- 依然被 PL/pgSQL 在 parse 阶段报 ambiguous:
--   column reference "velocity" is ambiguous
-- 原因: PL/pgSQL 在 parse 阶段就解析变量引用,RETURNS TABLE 里声明的
--       velocity 跟 v_prev RECORD 的 velocity 字段冲突。
-- 修法: 把 RETURNS TABLE 的输出列改名 (out_velocity / out_acceleration /
--       out_stage / out_warning_created),让函数体内不再有名字冲突。
--
-- Worker (csnews-agent/src/index.ts) 需要相应更新:
--   trend.velocity  -> trend.out_velocity
--   trend.acceleration -> trend.out_acceleration
--   trend.stage -> trend.out_stage
--   trend.warning_created -> trend.out_warning_created

DROP FUNCTION IF EXISTS public.record_trend_snapshot(UUID);

CREATE FUNCTION public.record_trend_snapshot(p_topic_id UUID)
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
  v_topic RECORD;
  v_news_count INT;
  v_signal_score NUMERIC;
  v_prev trend_snapshots%ROWTYPE;  -- 显式 %ROWTYPE 让 PL/pgSQL 静态推断字段
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
    (v_warning_id IS NOT NULL);
END;
$fn$;

-- 更新 RPC search path 上的函数引用
COMMENT ON FUNCTION public.record_trend_snapshot(UUID) IS
  '记录 TIE-lite trend snapshot, 计算 velocity/acceleration/stage, 按规则触发 warning. v0.30.1 改名 RETURNS TABLE 输出列避开 PL/pgSQL 歧义.';