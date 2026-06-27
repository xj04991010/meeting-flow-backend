-- ==========================================
-- Clients Data Layer Migration
-- ==========================================

-- 1. 建立 Clients 資料表
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active', -- active, paused, completed
    notes TEXT DEFAULT '',
    contact_info JSONB DEFAULT '{}'::jsonb,
    contract_start TIMESTAMP WITH TIME ZONE,
    contract_end TIMESTAMP WITH TIME ZONE,
    default_monthly_target INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- 確保同一個使用者不會有重複的客戶名稱
    CONSTRAINT unique_user_client_name UNIQUE (user_id, name)
);

-- 建立索引以利快速查詢
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients(user_id);

-- 啟用 RLS
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny all to anon" ON clients;
CREATE POLICY "Deny all to anon" ON clients FOR ALL TO anon USING (false);

-- 2. 自動更新 updated_at 的 Trigger 函數
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 為 clients 加入 trigger
DROP TRIGGER IF EXISTS update_clients_modtime ON clients;
CREATE TRIGGER update_clients_modtime
BEFORE UPDATE ON clients
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();
