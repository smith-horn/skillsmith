-- Fix early_access_signups unique constraint for Supabase upsert compatibility
-- The functional index on LOWER(email) doesn't work with Supabase's onConflict parameter
-- Since we normalize email to lowercase before insert, we can use a direct constraint

-- Drop the functional index (if exists)
DROP INDEX IF EXISTS idx_early_access_email_unique;

-- Add a direct unique constraint on email column (skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'early_access_signups_email_key'
  ) THEN
    ALTER TABLE early_access_signups ADD CONSTRAINT early_access_signups_email_key UNIQUE (email);
  END IF;
END;
$$;
