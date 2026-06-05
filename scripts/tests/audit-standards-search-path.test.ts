/**
 * Tests for the SMI-5203 function_search_path_mutable recurrence guard helper.
 *
 * Covers `findFunctionsWithoutSearchPath` in audit-standards-helpers.mjs.
 *
 * Background: Supabase raises WARN advisories for public-schema functions that
 * lack SET search_path. Check 51 (audit-standards.mjs) uses this helper to scan
 * new migration files at PR time and warn before they land.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  findFunctionsWithoutSearchPath: (
    sqlContent: string,
    filePath: string
  ) => Array<{ funcName: string; filePath: string }>
}

const { findFunctionsWithoutSearchPath } = helpers

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findFunctionsWithoutSearchPath (SMI-5203)', () => {
  it('flags a CREATE FUNCTION block that has no SET search_path', () => {
    const sql = `
CREATE OR REPLACE FUNCTION my_func()
RETURNS void AS $$
BEGIN
  NULL;
END;
$$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(1)
    expect(violations[0].funcName).toBe('my_func')
    expect(violations[0].filePath).toBe('test.sql')
  })

  it('passes a CREATE FUNCTION block with SET search_path = in the header', () => {
    const sql = `
CREATE OR REPLACE FUNCTION good_func()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  NULL;
END;
$$;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(0)
  })

  it('passes a CREATE FUNCTION block with SET search_path TO in the body', () => {
    const sql = `
CREATE FUNCTION another_func()
RETURNS void AS $$
BEGIN
  SET search_path TO public;
  NULL;
END;
$$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(0)
  })

  it('detects multiple violations across multiple CREATE FUNCTION blocks', () => {
    const sql = `
CREATE FUNCTION func_a()
RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;

CREATE FUNCTION func_b()
RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'multi.sql')
    expect(violations).toHaveLength(2)
    expect(violations.map((v) => v.funcName)).toContain('func_a')
    expect(violations.map((v) => v.funcName)).toContain('func_b')
  })

  it('only flags the function lacking search_path when mixed good and bad exist', () => {
    const sql = `
CREATE FUNCTION clean_func()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$ BEGIN NULL; END; $$;

CREATE FUNCTION dirty_func()
RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'mixed.sql')
    expect(violations).toHaveLength(1)
    expect(violations[0].funcName).toBe('dirty_func')
  })

  it('returns empty array for SQL with no CREATE FUNCTION at all', () => {
    const sql = `
ALTER TABLE foo ADD COLUMN bar TEXT;
INSERT INTO schema_version (version) VALUES (94) ON CONFLICT DO NOTHING;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'no-funcs.sql')
    expect(violations).toHaveLength(0)
  })

  it('skips _temp_set_function_search_path by name (remediation helper exemption)', () => {
    const sql = `
CREATE FUNCTION _temp_set_function_search_path(fn_oid oid)
RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(0)
  })

  it('skips cleanup_search_metrics by name (known exemption)', () => {
    const sql = `
CREATE FUNCTION cleanup_search_metrics()
RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(0)
  })

  it('is case-insensitive for SET SEARCH_PATH', () => {
    const sql = `
CREATE FUNCTION ci_func()
RETURNS void
LANGUAGE plpgsql
SET SEARCH_PATH = public
AS $$ BEGIN NULL; END; $$;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'test.sql')
    expect(violations).toHaveLength(0)
  })

  it('returns empty array for empty SQL string', () => {
    const violations = findFunctionsWithoutSearchPath('', 'empty.sql')
    expect(violations).toHaveLength(0)
  })

  it('handles ALTER FUNCTION (no CREATE) — should produce no violations', () => {
    // Migration 1 uses ALTER FUNCTION only; no CREATE FUNCTION. Should be clean.
    const sql = `
ALTER FUNCTION audit_api_key_change() SET search_path = public, extensions;
ALTER FUNCTION audit_webhook_change() SET search_path = public, extensions;
ALTER FUNCTION tier_rank(p_tier text) SET search_path = public, extensions;
`
    const violations = findFunctionsWithoutSearchPath(sql, 'alter-only.sql')
    expect(violations).toHaveLength(0)
  })
})
