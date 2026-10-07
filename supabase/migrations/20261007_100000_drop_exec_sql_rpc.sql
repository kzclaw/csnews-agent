-- v0.37.93: 删除 exec_sql 高危 RPC
-- 该函数为 SECURITY DEFINER + GRANT EXECUTE TO anon, 等同于向全互联网敞开任意 SQL 执行权
-- 且全仓零调用点(实测: grep exec_sql 在 src/ tools/ 下零命中, 注释所称 fission 调用并不存在)
-- 影响: 任何人拿到 anon key 即可 /rest/v1/rpc/exec_sql 执行任意 SQL, 且绕过全部 RLS
-- 回滚路径: 如需恢复, 从 git 历史取本文件上一版 SQL 重新 CREATE 即可(无数据影响, 纯函数)
DROP FUNCTION IF EXISTS public.exec_sql(TEXT);