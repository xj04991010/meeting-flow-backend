CREATE TABLE IF NOT EXISTS research_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  created_at timestamptz DEFAULT now()
);
