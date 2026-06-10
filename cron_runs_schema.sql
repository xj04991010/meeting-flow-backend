CREATE TABLE IF NOT EXISTS cron_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  run_date text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(job_type, run_date)
);
