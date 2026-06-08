-- CSNEWS Agent · Initial Schema
-- Created: 2026-05-29

-- Step 1: Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: news_hotspots（新闻热点记录）
CREATE TABLE IF NOT EXISTS news_hotspots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  source TEXT DEFAULT 'zaker',
  category TEXT,
  hot_score DECIMAL(4,1),
  published_at TIMESTAMPTZ,
  summary TEXT,
  embedding vector(1024),
  r2_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 3: fission_searches（裂变搜索记录）
CREATE TABLE IF NOT EXISTS fission_searches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seed_news_id UUID REFERENCES news_hotspots(id),
  search_query TEXT NOT NULL,
  depth INT DEFAULT 1,
  fission_type TEXT,
  results_count INT DEFAULT 0,
  report_r2_key TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Step 4: trend_reports（趋势报告）
CREATE TABLE IF NOT EXISTS trend_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  report_date DATE,
  title TEXT,
  content_preview TEXT,
  r2_key TEXT NOT NULL,
  news_count INT DEFAULT 0,
  fission_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 5: 向量索引（加速余弦相似度查询）
CREATE INDEX IF NOT EXISTS idx_news_hotspots_embedding
  ON news_hotspots USING ivfflat (embedding vector_cosine_ops);