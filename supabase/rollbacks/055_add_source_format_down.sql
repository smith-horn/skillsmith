-- Rollback for 055_add_source_format.sql
-- Removes source_format, license, and skill_path columns and their indexes.
--
-- Note: source_format is NOT NULL — rolling back after data has been written
-- with non-default values will silently drop that data. Verify the column
-- contains only the default value ('skill-md') before rolling back in production.

SET search_path = public;

DROP INDEX IF EXISTS idx_skills_source_format;
DROP INDEX IF EXISTS idx_skills_license;

ALTER TABLE skills DROP COLUMN IF EXISTS skill_path;
ALTER TABLE skills DROP COLUMN IF EXISTS license;
ALTER TABLE skills DROP COLUMN IF EXISTS source_format;

DELETE FROM schema_version WHERE version = 55;
