-- Create Daily Journals Table
CREATE TABLE IF NOT EXISTS public.daily_journals (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    date date NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- Index for fast queries by user and date
CREATE INDEX IF NOT EXISTS daily_journals_user_date_idx ON public.daily_journals(user_id, date);

-- Optional RLS (Row Level Security) if enabled
ALTER TABLE public.daily_journals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own daily journals"
    ON public.daily_journals
    FOR ALL
    USING (auth.uid() = user_id);
