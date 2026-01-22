-- SMI-1634: Fix category name casing
-- Website sends lowercase, database has capitalized names

UPDATE categories SET name = LOWER(name);
