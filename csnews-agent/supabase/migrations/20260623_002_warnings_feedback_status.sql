-- ============================================================
-- Migration: Add feedback_status to warnings table
-- Purpose: Track feedback loop validation state for each warning
--          (pending → validated / dismissed at 24/48/72h checkpoints)
-- Usage: O11 Feedback Loop writes feedback_status;
--        record_feedback RPC reads/writes this column.
-- ============================================================

-- Only add column if it does not already exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'warnings'
      AND column_name  = 'feedback_status'
  ) THEN
    ALTER TABLE public.warnings
      ADD COLUMN feedback_status TEXT
      DEFAULT NULL
      CHECK (feedback_status IS NULL OR feedback_status IN ('pending', 'validated', 'dismissed'));
  END IF;
END
$$;

-- Index on status for O11 Feedback Loop to efficiently find open warnings
CREATE INDEX IF NOT EXISTS idx_warnings_feedback_status
  ON public.warnings (feedback_status)
  WHERE feedback_status IS NOT NULL;

-- Index for feedback loop query: open warnings by category and created_at
CREATE INDEX IF NOT EXISTS idx_warnings_category_created
  ON public.warnings (category, created_at DESC)
  WHERE status = 'open';

COMMENT ON COLUMN public.warnings.feedback_status IS
  'O11 Feedback Loop: pending=awaiting review, validated=warning confirmed, dismissed=warning was false alarm';
