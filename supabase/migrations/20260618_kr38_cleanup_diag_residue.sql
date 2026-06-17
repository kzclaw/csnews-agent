-- CSNEWS Agent · Cleanup diag endpoint residue (KR38+2)
-- 2026-06-17 18:48 user decision: 选 2 (Supabase 自动迁移范式)
-- 跟 KR38+1 (删 diag 端点) 配合: 旧 3 条 diag 假数据清掉
-- 历史: 5 天前 (2026-06-12 12:29:59 UTC) 调 ?action=diag 留下 diag-1781267399339 + 之前 broken cleanup 期间留 2 条 = 3 条

-- 1. 清 news_hotspots 表的 diag 假数据
DELETE FROM news_hotspots WHERE title LIKE 'diag-%';

-- 2. 清 topics 表的 diag 假数据
DELETE FROM topics WHERE topic_key LIKE 'diag-%';

-- 3. 清 news_topic_members 表的关联 (news_id 或 topic_id 引用已删的 diag 数据)
DELETE FROM news_topic_members
 WHERE news_id IN (SELECT id FROM news_hotspots WHERE title LIKE 'diag-%')
    OR topic_id IN (SELECT id FROM topics WHERE topic_key LIKE 'diag-%');

-- 验证 (跑完看输出):
-- SELECT COUNT(*) FROM news_hotspots WHERE title LIKE 'diag-%';  -- 应返 0
-- SELECT COUNT(*) FROM topics WHERE topic_key LIKE 'diag-%';  -- 应返 0
-- SELECT COUNT(*) FROM news_topic_members
--   WHERE news_id IN (SELECT id FROM news_hotspots WHERE title LIKE 'diag-%')
--      OR topic_id IN (SELECT id FROM topics WHERE topic_key LIKE 'diag-%');  -- 应返 0
