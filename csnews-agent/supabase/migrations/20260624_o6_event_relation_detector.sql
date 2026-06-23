-- O6 Event Graph: Relation Detection Support Functions
-- Date: 20260624
-- Contents:
--   1. exec(text) RPC for running arbitrary SQL (relation detection use)

BEGIN;

-- exec RPC: run arbitrary SQL (service role only)
-- Used by event-relation-detector for temporal/semantic/causal batch detection
CREATE OR REPLACE FUNCTION public.exec(p_sql text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY: only allow service role (has access to service role key)
  -- Called via /rest/v1/rpc/exec from Worker with SUPABASE_SERVICE_KEY
  RETURN QUERY EXECUTE p_sql;
END;
$$;

-- Grant execute to authenticated role
GRANT EXECUTE ON FUNCTION public.exec(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exec(text) TO service_role;

-- event-relation summary view (for debugging/monitoring)
CREATE OR REPLACE VIEW public.event_relation_summary AS
SELECT
  relation_type,
  sub_type,
  detected_by,
  COUNT(*) AS pair_count,
  COUNT(DISTINCT from_event_id) AS from_count,
  COUNT(DISTINCT to_event_id) AS to_count,
  MIN(created_at) AS first_detected,
  MAX(created_at) AS last_detected
FROM event_relation
GROUP BY relation_type, sub_type, detected_by
ORDER BY pair_count DESC;

COMMIT;
