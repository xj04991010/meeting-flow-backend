-- MeetingFlow proactive task idempotency.
-- Run once in Supabase SQL Editor after deploying the proactive guard code.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS proactive_source_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proactive_occurrence_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_proactive_occurrence_unique
  ON tasks(user_id, proactive_occurrence_key)
  WHERE proactive_occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_proactive_source_memory
  ON tasks(proactive_source_memory_id);
