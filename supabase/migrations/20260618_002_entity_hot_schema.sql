-- entity_hot: 30d 内高频访问 entity (TTL 自动归档到 R2)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entity_hot (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('person', 'org', 'place')),
  confidence NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source TEXT NOT NULL CHECK (source IN ('selflearn', 'review')),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reviewed')),
  UNIQUE (name, type)
);

-- viewer 按 type 查
CREATE INDEX IF NOT EXISTS idx_entity_hot_type ON entity_hot(type);

-- LIKE '%name%' 加速
CREATE INDEX IF NOT EXISTS idx_entity_hot_name_trgm ON entity_hot USING gin (name gin_trgm_ops);

-- cron 按 status 分类归档
CREATE INDEX IF NOT EXISTS idx_entity_hot_status ON entity_hot(status);

-- cron 按 created_at 查 30d+
CREATE INDEX IF NOT EXISTS idx_entity_hot_created_at ON entity_hot(created_at);