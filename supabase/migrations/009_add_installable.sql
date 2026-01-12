-- Migration: Add installable column to skills table
-- Purpose: Track whether skills have a valid SKILL.md and can be auto-installed
-- Related: SMI-1406 - Document skill repository structure requirements

-- Add installable column (default false - unknown until checked)
ALTER TABLE skills
ADD COLUMN IF NOT EXISTS installable BOOLEAN DEFAULT false;

-- Add comment
COMMENT ON COLUMN skills.installable IS 'Whether the skill has a valid SKILL.md at repo root and can be auto-installed';

-- Create index for filtering installable skills
CREATE INDEX IF NOT EXISTS idx_skills_installable ON skills(installable) WHERE installable = true;
