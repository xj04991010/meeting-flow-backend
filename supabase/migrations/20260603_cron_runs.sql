CREATE TABLE IF NOT EXISTS public.cron_runs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    job_type text NOT NULL,
    run_date date NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(job_type, run_date)
);

-- RLS policies
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

-- Note: This is an internal system table, no user access required.
-- We can add a policy if needed later, but backend service role bypasses RLS anyway.
