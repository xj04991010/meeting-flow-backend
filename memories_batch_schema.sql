-- MeetingFlow memory lifecycle patch.
-- Run once in Supabase SQL Editor so rejected batches can remove bad memories.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS memory_type TEXT,
  ADD COLUMN IF NOT EXISTS source_batch_id UUID REFERENCES source_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

UPDATE memories
SET is_active = TRUE
WHERE is_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_source_batch
  ON memories(source_batch_id);

CREATE INDEX IF NOT EXISTS idx_memories_user_active_importance
  ON memories(user_id, is_active, importance DESC);
