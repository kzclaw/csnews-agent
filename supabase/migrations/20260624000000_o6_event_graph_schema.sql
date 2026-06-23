-- O6 Event Graph Schema Migration
-- Created by CEO (Mavis) via GitHub API
-- Date: 2026-06-23

-- 1. events table
CREATE TABLE IF NOT EXISTS public.events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT        NOT NULL,
  topic_id      UUID        REFERENCES public.topics(id) ON DELETE SET NULL,
  event_stage   TEXT        NOT NULL DEFAULT 'detected'
                       CHECK (event_stage IN ('detected','confirmed','growing','hot','archived')),
  score         INT         NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 9),
  news_count    INT         NOT NULL DEFAULT 1,
  first_news_id UUID        REFERENCES public.news_hotspots(id) ON DELETE SET NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding     public.vector(1024),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_embedding_hnsw
  ON public.events
  USING hnsw (embedding public.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_events_topic_id
  ON public.events (topic_id)
  WHERE topic_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_published_at
  ON public.events (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_stage
  ON public.events (event_stage)
  WHERE event_stage != 'archived';

-- 2. event_relation table
CREATE TABLE IF NOT EXISTS public.event_relation (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_event_id   UUID        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  to_event_id     UUID        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  relation_type   TEXT        NOT NULL CHECK (relation_type IN ('temporal','semantic','causal')),
  sub_type        TEXT,
  weight          NUMERIC(4,3) NOT NULL DEFAULT 1.000 CHECK (weight >= 0 AND weight <= 1.000),
  evidence        JSONB,
  detected_by     TEXT        NOT NULL DEFAULT 'sql_batch'
                       CHECK (detected_by IN ('sql_batch','llm','manual','rule_template')),
  reviewed        BOOLEAN     NOT NULL DEFAULT FALSE,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT      no_self_relation CHECK (from_event_id != to_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_relation_unique
  ON public.event_relation (from_event_id, to_event_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_event_relation_type
  ON public.event_relation (relation_type)
  WHERE reviewed = FALSE;

CREATE INDEX IF NOT EXISTS idx_event_relation_from
  ON public.event_relation (from_event_id);

CREATE INDEX IF NOT EXISTS idx_event_relation_to
  ON public.event_relation (to_event_id);

-- 3. causal_rules table
CREATE TABLE IF NOT EXISTS public.causal_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  head_kw     TEXT[]      NOT NULL,
  tail_kw     TEXT[]      NOT NULL,
  relation    TEXT        NOT NULL,
  description TEXT,
  min_sim     NUMERIC(3,2) NOT NULL DEFAULT 0.70,
  max_hours   INT         NOT NULL DEFAULT 72,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.causal_rules (head_kw, tail_kw, relation, description, min_sim, max_hours)
VALUES
  (ARRAY['加息','降息','宽松','紧缩','量化宽松','缩表'],
   ARRAY['下跌','上涨','暴跌','暴涨','市场反应','科技股'],
   'policy_market', 'central bank policy impacts financial markets', 0.60, 48),
  (ARRAY['发布','推出','上市','发售'],
   ARRAY['接单','量产','供应链','合作','代工'],
   'announcement_reaction', 'product announcement triggers supply chain follow-up', 0.60, 120),
  (ARRAY['调查','审查','监管','起诉','指控'],
   ARRAY['回应','澄清','道歉','承认','反驳'],
   'investigation_response', 'regulatory action triggers subject response', 0.55, 24),
  (ARRAY['制裁','限制','封禁','禁令','加税'],
   ARRAY['下跌','暴跌','暂停','退出','损失'],
   'sanction_reaction', 'sanctions trigger market or business reaction', 0.65, 72),
  (ARRAY['业绩','财报','营收','亏损','暴雷'],
   ARRAY['审计','调查','暴跌','回应','预警'],
   'earnings_investigation', 'earnings issues trigger audit or market reaction', 0.60, 48)
ON CONFLICT DO NOTHING;

-- 4. event_entity association table (FK -> entity per O4KR1)
CREATE TABLE IF NOT EXISTS public.event_entity (
  event_id    UUID        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  entity_id   UUID        NOT NULL REFERENCES public.entity(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'participant'
                       CHECK (role IN ('subject','object','context')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_event_entity_entity
  ON public.event_entity (entity_id);

-- RLS policies
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.causal_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_entity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_events" ON public.events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_event_relation" ON public.event_relation FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_causal_rules" ON public.causal_rules FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_event_entity" ON public.event_entity FOR ALL USING (auth.role() = 'service_role');
