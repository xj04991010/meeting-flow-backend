-- ==========================================
-- Client Weekly Notes Data Layer Migration
-- ==========================================

-- 1. 建立 Client Weekly Notes 資料表
CREATE TABLE IF NOT EXISTS client_weekly_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    client_name TEXT NOT NULL,
    week_key TEXT NOT NULL, -- e.g. "2026-W26"
    traffic_light TEXT DEFAULT 'green',
    
    -- 文字紀錄區塊
    current_status TEXT DEFAULT '',
    progress_note TEXT DEFAULT '',
    next_week_note TEXT DEFAULT '',
    urgent_note TEXT DEFAULT '',
    
    -- 保留向下相容的數字計數欄位
    raw_count INT DEFAULT 0,
    edited_count INT DEFAULT 0,
    scheduled_count INT DEFAULT 0,
    unshot_count INT DEFAULT 0,
    
    -- 日期連結陣列 JSONB
    date_links JSONB DEFAULT '[]'::jsonb,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- 確保同一個使用者、同一個客戶、在同一週只有一筆紀錄
    CONSTRAINT unique_client_week UNIQUE (user_id, client_name, week_key)
);

-- 建立索引以利 Dashboard 快速查詢當週的所有客戶週報
CREATE INDEX IF NOT EXISTS idx_client_weekly_notes_user_week 
ON client_weekly_notes(user_id, week_key);

-- 啟用 RLS
ALTER TABLE client_weekly_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny all to anon" ON client_weekly_notes;
CREATE POLICY "Deny all to anon" ON client_weekly_notes FOR ALL TO anon USING (false);


-- 2. 修改 tasks 資料表，新增 task_type 以區分「待拍攝」、「待確認事項」等
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS task_type TEXT DEFAULT 'general';

-- 3. 自動更新 updated_at 的 Trigger 函數 (如果還沒建立過的話)
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 為 client_weekly_notes 加入 trigger
DROP TRIGGER IF EXISTS update_client_weekly_notes_modtime ON client_weekly_notes;
CREATE TRIGGER update_client_weekly_notes_modtime
BEFORE UPDATE ON client_weekly_notes
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();
