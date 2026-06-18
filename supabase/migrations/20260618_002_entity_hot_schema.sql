-- CSNEWS Agent · Entity Hot Tier Schema v1 (方案 D · v0.36.21)
-- Created: 2026-06-18
--
-- 戴舒柯 18:49 拍板方案 D = 分层架构 (R2 冷层 + Supabase 热层 + TTL 自动归档)
-- 评估文档: tasks/entity-hot-cold-tier-design.md
-- 关联 KR: KR3 v0.36.21 (重启, 戴舒柯 18:49 拍板, 拍板权回归 Mavis + root session)
--
-- 热层 (entity_hot): 30d 内 entity (review 频繁 + viewer 主要查)
--   - 容量: 30d × 5-10 entity/d = 150-300 行 (稳态)
--   - 30d+ 自动归档: cron 每月 1 号 0:00 UTC 移到 R2 entity-archive-YYYY-MM.json
--   - 戴舒柯 review 过的 (status='reviewed'): 移到 R2 entity-reviewed-YYYY.json (永久保留)
-- 冷层 (R2): 30d+ entity 历史 + 戴舒柯 review 过永久保留
--
-- 4 问评估 (戴舒柯 17:59 框架 + 戴舒柯 18:49 方案 D 落地):
-- 1. schema 演化: 10 字段够用, 未来 ALTER ADD COLUMN O(1) 不锁表
-- 2. pg_trgm 稳定性: TTL 控制稳态 150-300 行, 永不超 500 行, 性能无忧
-- 3. 双写一致性: R2 (source of truth) + Supabase (写优化层, best effort)
-- 4. 下游消费者: 4 文件改动 (3 src/ + 1 tools/ viewer), 0 破坏性

-- Step 1: Enable pg_trgm (热层 gin 索引依赖)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Step 2: entity_hot 单表 10 字段
-- 8 字段 (entity 核心) + created_at/archived_at (TTL 用) + status (active/reviewed 分类)
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

-- Step 3: type 索引 (viewer 按 type 查)
CREATE INDEX IF NOT EXISTS idx_entity_hot_type ON entity_hot(type);

-- Step 4: name 模糊查询索引 (pg_trgm gin, 加速 LIKE '%xxx%' 查询)
-- entity name 是 2-8 字短字符串, pg_trgm 短字符串效果尚可 (CSDN 实测)
CREATE INDEX IF NOT EXISTS idx_entity_hot_name_trgm ON entity_hot USING gin (name gin_trgm_ops);

-- Step 5: status 索引 (cron 归档查询 active / reviewed 分类)
CREATE INDEX IF NOT EXISTS idx_entity_hot_status ON entity_hot(status);

-- Step 6: created_at 索引 (cron 归档查询 30d+ 老 entity)
CREATE INDEX IF NOT EXISTS idx_entity_hot_created_at ON entity_hot(created_at);

-- Step 7: pg_trgm 调参说明 (不在 SQL 改, 戴舒柯后期手动 SET LOCAL 或 ALTER DATABASE)
-- similarity_threshold = 0.2 (中文短字符串友好, 默认 0.3 太严)
-- gin_pending_list_limit = 64MB (批量写入友好, 默认 4MB 太短)
-- 注: Supabase Free Plan 是共享实例, ALTER DATABASE 需要 superuser, 默认不允许
-- 戴舒柯 5h 配额期外手动: psql SET pg_trgm.similarity_threshold = 0.2;
