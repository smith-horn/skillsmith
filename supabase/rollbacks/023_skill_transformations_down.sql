-- SMI-1841: Skill Transformations Table - DOWN Migration
-- Rollback script to remove skill_transformations table

-- Drop helper functions
DROP FUNCTION IF EXISTS upsert_skill_transformation(TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS get_skill_transformation(TEXT);

-- Drop trigger
DROP TRIGGER IF EXISTS trigger_skill_transformations_updated ON skill_transformations;
DROP FUNCTION IF EXISTS update_transformed_at_column();

-- Drop indexes
DROP INDEX IF EXISTS idx_skill_transformations_source_hash;
DROP INDEX IF EXISTS idx_skill_transformations_transformed_at;
DROP INDEX IF EXISTS idx_skill_transformations_skill_id;

-- Drop policies
DROP POLICY IF EXISTS "Allow authenticated delete on skill_transformations" ON skill_transformations;
DROP POLICY IF EXISTS "Allow authenticated update on skill_transformations" ON skill_transformations;
DROP POLICY IF EXISTS "Allow authenticated insert on skill_transformations" ON skill_transformations;
DROP POLICY IF EXISTS "Allow service role full access on skill_transformations" ON skill_transformations;
DROP POLICY IF EXISTS "Allow public read access on skill_transformations" ON skill_transformations;

-- Drop table
DROP TABLE IF EXISTS skill_transformations;

-- Remove schema version entry
DELETE FROM schema_version WHERE version = 23;
