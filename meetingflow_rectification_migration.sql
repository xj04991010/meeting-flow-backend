-- ==========================================
-- MeetingFlow rectification migration
-- Run this once on an existing Supabase project.
-- It upgrades the old coach/button schema into the batch extraction schema.
-- ==========================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS source_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL DEFAULT 'telegram',
    raw_text TEXT NOT NULL,
    parser_version TEXT,
    summary TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS source_batch_id UUID REFERENCES source_batches(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS client TEXT,
    ADD COLUMN IF NOT EXISTS owner TEXT,
    ADD COLUMN IF NOT EXISTS confidence NUMERIC(4, 3) DEFAULT 0.700,
    ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS source_quote TEXT;

ALTER TABLE calendar_intents
    ADD COLUMN IF NOT EXISTS source_batch_id UUID REFERENCES source_batches(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS client TEXT,
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS confidence NUMERIC(4, 3) DEFAULT 0.700,
    ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS source_quote TEXT,
    ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS external_calendar_id TEXT,
    ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE TABLE IF NOT EXISTS chat_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_batches_user_created
    ON source_batches(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_deadline
    ON tasks(user_id, status, deadline);

CREATE INDEX IF NOT EXISTS idx_tasks_source_batch
    ON tasks(source_batch_id);

CREATE INDEX IF NOT EXISTS idx_calendar_user_status_start
    ON calendar_intents(user_id, status, start_time);

CREATE INDEX IF NOT EXISTS idx_calendar_source_batch
    ON calendar_intents(source_batch_id);

ALTER TABLE source_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all to anon" ON source_batches;
DROP POLICY IF EXISTS "Deny all to anon" ON chat_history;

CREATE POLICY "Deny all to anon" ON source_batches FOR ALL TO anon USING (false);
CREATE POLICY "Deny all to anon" ON chat_history FOR ALL TO anon USING (false);

UPDATE tasks
SET category = COALESCE(NULLIF(category, ''), 'meeting')
WHERE category IS NULL OR category = '';

UPDATE calendar_intents
SET sync_status = CASE
    WHEN status = 'needs_review' THEN 'pending_review'
    WHEN status = 'confirmed' THEN 'ready'
    WHEN status = 'executed' THEN 'synced'
    ELSE COALESCE(sync_status, 'ready')
END
WHERE sync_status IS NULL OR sync_status = 'ready';
