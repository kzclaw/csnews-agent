-- v0.37.66: csnews-fission exec_sql RPC
-- fission-trigger.ts uses /rest/v1/rpc/exec_sql to run arbitrary SQL queries
-- SECURITY DEFINER so it runs as the service_role (bypasses RLS)
CREATE OR REPLACE FUNCTION public.exec_sql(query TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (SELECT jsonb_agg(row_to_json(t)) FROM (EXECUTE query) t);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'code', SQLSTATE);
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.exec_sql(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exec_sql(TEXT) TO anon;
