-- CSNEWS Agent · News Self Growth Schema (v0.16)
-- 2026-05-30

-- topics（话题簇）
CREATE TABLE IF NOT EXISTS topics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_key VARCHAR(64) NOT NULL,  -- 话题指纹（首条新闻的 title 哈希前8位）
  level TEXT DEFAULT 'follow' CHECK (level IN ('follow', 'important', 'explosive')),
  score INT DEFAULT 0 CHECK (score >= 0 AND score <= 9),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  first_news_id UUID,                -- 话题首发新闻 ID
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- news_topic_members（新闻-话题关联）
CREATE TABLE IF NOT EXISTS news_topic_members (
  news_id UUID REFERENCES news_hotspots(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES topics(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'follow' CHECK (role IN ('seed', 'follow')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (news_id, topic_id)
);

-- 为 news_hotspots 添加 News Self Growth 字段
ALTER TABLE news_hotspots
  ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS level TEXT DEFAULT 'follow' CHECK (level IN ('follow', 'important', 'explosive')),
  ADD COLUMN IF NOT EXISTS score INT DEFAULT 0 CHECK (score >= 0 AND score <= 9),
  ADD COLUMN IF NOT EXISTS is_stored_r2 BOOLEAN DEFAULT FALSE;  -- 是否已存 R2（去重存储层标志）

-- 向量索引（已有则跳过）
-- idx_news_hotspots_embedding 已在 001_initial_schema.sql 创建

-- topics 的 last_active 索引（加速清理查询）
CREATE INDEX IF NOT EXISTS idx_topics_last_active ON topics(last_active_at);

-- news_topic_members 的 topic_id 索引
CREATE INDEX IF NOT EXISTS idx_topic_members_topic ON news_topic_members(topic_id);

-- 向量相似度搜索 RPC（余弦相似度 > threshold 视为相似）
CREATE OR REPLACE FUNCTION find_similar_news(
  query_embedding vector(1024),
  threshold FLOAT DEFAULT 0.88,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  similarity FLOAT,
  level TEXT,
  score INT,
  topic_id UUID
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    h.id,
    h.title,
    1 - (h.embedding <=> query_embedding) AS similarity,
    h.level,
    h.score,
    h.topic_id
  FROM news_hotspots h
  WHERE h.embedding IS NOT NULL
    AND 1 - (h.embedding <=> query_embedding) > threshold
  ORDER BY h.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 话题簇积分 + 等级更新 RPC
CREATE OR REPLACE FUNCTION update_topic_score(
  p_topic_id UUID,
  p_score_delta INT DEFAULT 1
)
RETURNS TABLE (
  new_score INT,
  new_level TEXT,
  upgraded BOOLEAN,
  fission_triggered BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_score INT;
  v_level TEXT;
  v_upgraded BOOLEAN := FALSE;
  v_fission BOOLEAN := FALSE;
  v_new_score INT;
  v_new_level TEXT;
BEGIN
  -- 获取当前值
  SELECT score, level INTO v_score, v_level FROM topics WHERE id = p_topic_id FOR UPDATE;

  -- 更新积分（上限9）
  v_new_score := LEAST(v_score + p_score_delta, 9);
  v_new_level := v_level;

  -- 检查是否触发升级（3的倍数）
  IF v_new_score > 0 AND v_new_score % 3 = 0 THEN
    IF v_level = 'follow' THEN
      v_new_level := 'important';
      v_upgraded := TRUE;
    ELSIF v_level = 'important' THEN
      v_new_level := 'explosive';
      v_upgraded := TRUE;
    ELSIF v_level = 'explosive' AND v_new_score = 9 THEN
      -- 爆炸级9分 → 裂变触发，重置积分
      v_new_score := 0;
      v_fission := TRUE;
    END IF;
  END IF;

  -- 写入
  UPDATE topics
  SET score = v_new_score,
      level = v_new_level,
      last_active_at = NOW(),
      updated_at = NOW()
  WHERE id = p_topic_id;

  RETURN QUERY SELECT v_new_score, v_new_level, v_upgraded, v_fission;
END;
$$;

-- 话题簇清理 RPC（删除超过 retention_days 无活跃的话题簇）
CREATE OR REPLACE FUNCTION cleanup_stale_topics()
RETURNS TABLE (deleted_topic_count INT, deleted_news_count INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_topics INT;
  v_deleted_news INT;
BEGIN
  -- 跟进级：7天，重要级：14天，爆炸级：28天
  DELETE FROM topics
  WHERE (
    (level = 'follow' AND last_active_at < NOW() - INTERVAL '7 days')
    OR (level = 'important' AND last_active_at < NOW() - INTERVAL '14 days')
    OR (level = 'explosive' AND last_active_at < NOW() - INTERVAL '28 days')
  );

  GET DIAGNOSTICS v_deleted_topics = ROW_COUNT;

  -- news_topic_members 通过 ON DELETE CASCADE 自动清理
  -- news_hotspots 保留（因为有 is_stored_r2 标志，只清理 R2 里存过的）

  RETURN QUERY SELECT v_deleted_topics, 0;
END;
$$;