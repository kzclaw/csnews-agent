-- CSNEWS Agent · Cleanup diag endpoint residue (v2 retry)
-- 2026-06-17 19:00 retry: v1 partial apply
--   topics 表清成功 · news_hotspots 表 DELETE 没生效 (原因待查: FK / RLS / 集成 partial apply)
-- v2 fix: 1 个 transaction · 明确顺序 · 1 次 RTT
BEGIN;

-- 1. 先清 news_topic_members (避免 news_hotspots / topics DELETE 被 FK 阻)
DELETE FROM news_topic_members
 WHERE news_id IN (SELECT id FROM news_hotspots WHERE title LIKE 'diag-%')
    OR topic_id IN (SELECT id FROM topics WHERE topic_key LIKE 'diag-%');

-- 2. 再清 news_hotspots
DELETE FROM news_hotspots WHERE title LIKE 'diag-%';

-- 3. 最后清 topics (v1 已清, 但保留 idempotent)
DELETE FROM topics WHERE topic_key LIKE 'diag-%';

COMMIT;
