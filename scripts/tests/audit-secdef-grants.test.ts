/**
 * Tests for the SMI-5526 SECURITY DEFINER anon-grant lockdown recurrence guard.
 *
 * Covers `auditSecdefAnonGrants` in audit-standards-helpers.mjs.
 *
 * Background: Supabase's `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
 * FUNCTIONS TO anon, authenticated` auto-grants `anon` EXECUTE on every new
 * public function, including SECURITY DEFINER ones (SMI-5520/5525/5526 class).
 * Check 52 (audit-standards.mjs) uses this helper to fail the audit when a new
 * public SECURITY DEFINER function ships without a matching
 * `REVOKE ... FROM anon`. Self-contained: all SQL fixtures are inline.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  auditSecdefAnonGrants: (
    migrations: Array<{ name: string; content: string }>,
    opts: { cutoff: string | number; allowlist?: string[] }
  ) => Array<{ file: string; fn: string; signature: string; reason: string }>
}

const { auditSecdefAnonGrants } = helpers

const CUTOFF = '20260703235000'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditSecdefAnonGrants (SMI-5526)', () => {
  it('(1) flags a CREATE ... SECURITY DEFINER with no revoke at all', () => {
    const migrations = [
      {
        name: '20260703235001_no_revoke.sql',
        content: `
CREATE OR REPLACE FUNCTION public.get_secret(user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'secret';
END;
$$;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(1)
    expect(violations[0].fn).toBe('get_secret')
    expect(violations[0].signature).toBe('uuid')
    expect(violations[0].file).toBe('20260703235001_no_revoke.sql')
  })

  it('(2) passes a CREATE ... SECURITY DEFINER with a matching REVOKE FROM anon, authenticated, PUBLIC', () => {
    const migrations = [
      {
        name: '20260703235002_with_revoke.sql',
        content: `
CREATE OR REPLACE FUNCTION public.get_secret(user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'secret';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_secret(uuid) FROM anon, authenticated, PUBLIC;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(0)
  })

  it('(3) flags a definer keyword placed AFTER a dollar-quoted body, with no revoke (dollar-quote awareness)', () => {
    // The body contains internal semicolons; SECURITY DEFINER is declared
    // AFTER the `$$...$$` body closes. A naive `[^;]`-based scan would either
    // split this into fragments at the body's internal `;`s, or miss the
    // trailing SECURITY DEFINER entirely.
    const migrations = [
      {
        name: '20260703235003_definer_after_body.sql',
        content: `
CREATE OR REPLACE FUNCTION public.mint_key(user_id uuid, tier text)
RETURNS text AS $$
BEGIN
  PERFORM 1;
  INSERT INTO license_keys (user_id, tier) VALUES (user_id, tier);
  RETURN 'sk_live_x';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(1)
    expect(violations[0].fn).toBe('mint_key')
    expect(violations[0].signature).toBe('uuid,text')
  })

  it('(4) flags only the unrevoked overload when two signatures exist and only one is revoked', () => {
    const migrations = [
      {
        name: '20260703235004_overloads.sql',
        content: `
CREATE OR REPLACE FUNCTION public.create_device_code(client_type_input text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'code-a';
END;
$$;

CREATE OR REPLACE FUNCTION public.create_device_code(client_type_input text, cli_version_input text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'code-b';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_device_code(text) FROM anon, authenticated, PUBLIC;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(1)
    expect(violations[0].fn).toBe('create_device_code')
    expect(violations[0].signature).toBe('text,text')
  })

  it('(5) still flags a violation when the only REVOKE targets PUBLIC (not anon) — anon-in-FROM rule', () => {
    // SMI-5510 lesson: REVOKE ... FROM PUBLIC does NOT remove the explicit
    // anon grant Postgres's default privileges attach at CREATE time.
    const migrations = [
      {
        name: '20260703235005_public_only_revoke.sql',
        content: `
CREATE OR REPLACE FUNCTION public.get_secret(user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'secret';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_secret(uuid) FROM PUBLIC;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(1)
    expect(violations[0].fn).toBe('get_secret')
  })

  it('(6) does not flag an allowlisted function name even with no revoke', () => {
    const migrations = [
      {
        name: '20260703235006_allowlisted.sql',
        content: `
CREATE OR REPLACE FUNCTION public.search_skills(query text)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN;
END;
$$;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, {
      cutoff: CUTOFF,
      allowlist: ['search_skills'],
    })
    expect(violations).toHaveLength(0)
  })

  it('(7) does not flag an unrevoked definer function in a pre-cutoff migration', () => {
    const migrations = [
      {
        name: '20260101000001_pre_cutoff.sql',
        content: `
CREATE OR REPLACE FUNCTION public.legacy_secret_fn(user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN 'secret';
END;
$$;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(0)
  })

  it('passes a non-anon revoke check when name+type equivalence classes match (timestamptz/int4/bool/varchar)', () => {
    const migrations = [
      {
        name: '20260703235007_type_aliases.sql',
        content: `
CREATE OR REPLACE FUNCTION public.audit_event(
  p_created_at timestamp with time zone,
  p_count integer,
  p_flag boolean,
  p_name character varying
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_event(timestamptz, int4, bool, varchar) FROM anon, PUBLIC;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(0)
  })

  it('returns empty array for an empty migrations array', () => {
    const violations = auditSecdefAnonGrants([], { cutoff: CUTOFF })
    expect(violations).toHaveLength(0)
  })

  it('does not flag a CREATE FUNCTION that is not SECURITY DEFINER', () => {
    const migrations = [
      {
        name: '20260703235008_invoker.sql',
        content: `
CREATE OR REPLACE FUNCTION public.plain_fn(x integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  RETURN x;
END;
$$;
`,
      },
    ]
    const violations = auditSecdefAnonGrants(migrations, { cutoff: CUTOFF })
    expect(violations).toHaveLength(0)
  })
})
