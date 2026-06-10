-- Preview exact duplicate proactive tasks.
-- This does not modify data.
WITH ranked AS (
  SELECT
    id,
    user_id,
    title,
    deadline::date AS deadline_date,
    status,
    needs_review,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, title, deadline::date
      ORDER BY created_at ASC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY user_id, title, deadline::date
    ) AS duplicate_count
  FROM tasks
  WHERE source_batch_id IS NULL
    AND title LIKE '[AI推演]%'
)
SELECT *
FROM ranked
WHERE duplicate_count > 1
ORDER BY duplicate_count DESC, title, created_at;

-- Delete exact duplicates, keeping the oldest row in each duplicate group.
-- Review the preview above first, then run this block manually if it looks right.
/*
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, title, deadline::date
      ORDER BY created_at ASC
    ) AS rn
  FROM tasks
  WHERE source_batch_id IS NULL
    AND title LIKE '[AI推演]%'
)
DELETE FROM tasks
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
RETURNING id, title, deadline, created_at;
*/
