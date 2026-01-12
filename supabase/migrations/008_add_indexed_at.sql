-- Migration: Add indexed_at column to skills table
-- Purpose: Track when each skill was last indexed by the GitHub indexer
-- Related: supabase/functions/indexer/index.ts

-- Add indexed_at column
ALTER TABLE skills
ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;

-- Add comment
COMMENT ON COLUMN skills.indexed_at IS 'Timestamp of last indexer run that processed this skill';

-- Create index for querying recently indexed skills
CREATE INDEX IF NOT EXISTS idx_skills_indexed_at ON skills(indexed_at DESC NULLS LAST);
