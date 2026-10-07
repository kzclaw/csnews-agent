-- v0.37.94: 收回 PUBLIC / anon / authenticated 对两个写函数的默认 EXECUTE 权限
--
-- 背景: Postgres 在函数创建时默认把 EXECUTE 授予 PUBLIC 角色(所有角色都是 PUBLIC 的成员)。
--   Supabase 的 public schema 另有 default privileges 把函数执行权授给
--   anon / authenticated / service_role, 故只 REVOKE ... FROM PUBLIC 可能不足以真正挡住 anon
--   (显式授权条目仍在)。此处 PUBLIC / anon / authenticated 三个一起收。
--
-- 目标函数(两者均 SECURITY INVOKER, 无 SECURITY DEFINER):
--   update_topic_score(uuid, integer) -- 改话题积分与等级; 达 9 分且 explosive 时触发裂变
--   cleanup_stale_topics()             -- 按活跃度删除话题簇(DELETE)
--   二者操作的 topics 表未开 RLS, 故越权调用即可直接改分或删簇。
--
-- 调用方全部在服务端且走 service_role key(shared.ts:98-99 ->
-- news-process.ts:20 / news-process.ts:99), 因此显式 GRANT 给 service_role,
-- 不依赖任何 default privilege —— 收权后应用行为不变。
--
-- 注: 本仓库无凭据, 无法查询线上实际 ACL, 本 migration 按最坏情况收紧。
--     若线上本无 anon 显式授权, REVOKE 亦为幂等无副作用操作。
--
-- 回滚路径: git revert 本文件即可(纯授权变更, 无数据影响, 不动函数体)
REVOKE EXECUTE ON FUNCTION public.update_topic_score(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_topic_score(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_topic_score(uuid, integer) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.cleanup_stale_topics() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_topics() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_topics() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.update_topic_score(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_topics() TO service_role;
