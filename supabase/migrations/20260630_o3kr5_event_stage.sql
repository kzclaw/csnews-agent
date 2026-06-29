-- O3KR5: Event Lifecycle 5-Stage
-- Add event_stage column to topics table
-- Stage: detected → confirmed → growing → hot → archived
-- Migration: 20260630

ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS event_stage TEXT DEFAULT 'detected'
  CHECK (event_stage IN ('detected', 'confirmed', 'growing', 'hot', 'archived'));

-- Index for event_stage queries (filter by stage)
CREATE INDEX IF NOT EXISTS idx_topics_event_stage ON topics(event_stage);
