-- SMI-1659: Add RPC function to update category skill counts
-- Used by the indexer to efficiently update counts after categorization

-- Create the update_category_counts function
CREATE OR REPLACE FUNCTION update_category_counts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE categories c
  SET skill_count = (
    SELECT COUNT(*) FROM skill_categories sc WHERE sc.category_id = c.id
  );
END;
$$;

-- Grant execute permission to authenticated users (service role)
GRANT EXECUTE ON FUNCTION update_category_counts TO authenticated;

COMMENT ON FUNCTION update_category_counts IS 'Updates the skill_count for all categories based on skill_categories junction table';
