/**
 * Check 77 (SMI-7151): explicit API grants on new public relations.
 *
 * One test per row of the plan's Appendix B case table, plus the scope
 * classifier arms and the statement splitter edge cases. Assertions name the
 * relation and decision that must fail, not just a count.
 */
import { describe, expect, it } from 'vitest'

type Violation = {
  file: string
  relation: string
  decision: string
  message: string
  fix: string
}
type Scope = { status: string; scanned: number; reason: string }

const mod = (await import('../lib/audit-check77.mjs')) as {
  CHECK77_CUTOFF_TS: string
  CHECK77_EXEMPT_FILES: string[]
  CHECK77_IDENTITY_NEEDS_SEQUENCE_GRANT: boolean
  stripSqlComments: (sql: string) => string
  splitSqlStatements: (sql: string) => string[]
  findCheck77Acks: (
    sql: string
  ) => Array<{ kind: string; key: string | null; problem: string | null }>
  findRelationsWithoutGrantDecisions: (file: string, sql: string) => Violation[]
  classifyScanScope: (a: {
    inScopeFiles: string[]
    encryptedFiles: string[]
    diffFiles: string[] | null
  }) => Scope
}
const {
  stripSqlComments,
  splitSqlStatements,
  findRelationsWithoutGrantDecisions,
  classifyScanScope,
} = mod

const FILE = '20261101000000_foo.sql'
const run = (sql: string, file = FILE) => findRelationsWithoutGrantDecisions(file, sql)
const keys = (v: Violation[]) => v.map((x) => `${x.decision}:${x.relation}`).sort()
const GOOD_REASON = 'no API role reads this table directly'

describe('Check 77: relation grant decisions (Appendix B)', () => {
  it('passes a table with service_role and authenticated grants', () => {
    const sql = `CREATE TABLE public.foo (id uuid PRIMARY KEY);
GRANT SELECT ON public.foo TO service_role;
GRANT SELECT ON foo TO authenticated;`
    expect(run(sql)).toEqual([])
  })

  it('fails a bare CREATE TABLE on both decisions', () => {
    expect(keys(run('CREATE TABLE foo (id int);'))).toEqual(['clients:foo', 'service_role:foo'])
  })

  it('fails a lowercase unlogged table', () => {
    expect(keys(run('create unlogged table foo (id int);'))).toEqual([
      'clients:foo',
      'service_role:foo',
    ])
  })

  it('fails CREATE TABLE AS', () => {
    expect(keys(run('CREATE TABLE foo AS SELECT 1 AS a;'))).toEqual([
      'clients:foo',
      'service_role:foo',
    ])
  })

  it('fails SELECT INTO', () => {
    expect(keys(run('SELECT 1 AS a INTO foo;'))).toEqual(['clients:foo', 'service_role:foo'])
  })

  it('fails a materialized view', () => {
    expect(keys(run('CREATE MATERIALIZED VIEW mv AS SELECT 1;'))).toEqual([
      'clients:mv',
      'service_role:mv',
    ])
  })

  it('fails DROP VIEW then CREATE VIEW', () => {
    expect(keys(run('DROP VIEW v; CREATE VIEW v AS SELECT 1;'))).toEqual([
      'clients:v',
      'service_role:v',
    ])
  })

  it('fails DROP VIEW then CREATE OR REPLACE VIEW (grants were dropped with the view)', () => {
    expect(keys(run('DROP VIEW IF EXISTS v; CREATE OR REPLACE VIEW v AS SELECT 1;'))).toEqual([
      'clients:v',
      'service_role:v',
    ])
  })

  it('ignores CREATE OR REPLACE VIEW with no DROP in the file', () => {
    expect(run('CREATE OR REPLACE VIEW v AS SELECT 1;')).toEqual([])
  })

  it('passes a quoted mixed-case table with an ALL grant and a clients ack', () => {
    const sql = `CREATE TABLE IF NOT EXISTS "Foo" (id int);
GRANT ALL ON TABLE public."Foo" TO service_role;
-- audit:check-77-ack clients none "Foo": ${GOOD_REASON}`
    // ALL to service_role is allowed; the forbidden rule only concerns client roles
    expect(run(sql)).toEqual([])
  })

  it('treats a quoted identifier as case-sensitive', () => {
    const sql = `CREATE TABLE "Foo" (id int);
GRANT SELECT ON public.foo TO service_role, authenticated;`
    expect(keys(run(sql))).toEqual(['clients:Foo', 'service_role:Foo'])
  })

  it('passes a multi-line GRANT for both decisions', () => {
    const sql = `CREATE TABLE public.foo (id int);
GRANT SELECT, INSERT
  ON public.foo
  TO anon, service_role;`
    expect(run(sql)).toEqual([])
  })

  it('does not let one statement satisfy another relation (no cross-statement bleed)', () => {
    const sql = `CREATE TABLE public.foo (id int);
GRANT SELECT ON public.foo TO authenticated;
GRANT SELECT ON public.bar TO service_role;`
    const v = run(sql)
    expect(keys(v)).toEqual(['service_role:foo'])
    expect(v[0].message).toContain('public.foo has no service_role grant decision')
  })

  it('does not prefix-match: a grant on foobar does not satisfy foo', () => {
    const sql = `CREATE TABLE public.foo (id int);
GRANT SELECT ON public.foobar TO service_role, authenticated;`
    expect(keys(run(sql))).toEqual(['clients:foo', 'service_role:foo'])
  })

  it('fails a bigserial table with table grants but no sequence grant', () => {
    const sql = `CREATE TABLE foo (id bigserial PRIMARY KEY);
GRANT SELECT, INSERT ON public.foo TO service_role;
GRANT SELECT ON public.foo TO authenticated;`
    const v = run(sql)
    expect(keys(v)).toEqual(['sequence:foo_id_seq'])
    expect(v[0].message).toContain('service_role')
  })

  it('passes once the sequence has USAGE for service_role', () => {
    const sql = `CREATE TABLE foo (id bigserial PRIMARY KEY);
GRANT SELECT, INSERT ON public.foo TO service_role;
GRANT SELECT ON public.foo TO authenticated;
GRANT USAGE ON SEQUENCE public.foo_id_seq TO service_role;`
    expect(run(sql)).toEqual([])
  })

  it('requires sequence USAGE for a client role that is granted INSERT', () => {
    const sql = `CREATE TABLE foo (id serial PRIMARY KEY);
GRANT SELECT, INSERT ON public.foo TO service_role, authenticated;
GRANT USAGE ON SEQUENCE public.foo_id_seq TO service_role;`
    const v = run(sql)
    expect(keys(v)).toEqual(['sequence:foo_id_seq'])
    expect(v[0].message).toContain('authenticated')
    expect(v[0].message).not.toMatch(/USAGE grant for service_role/)
  })

  it('fails ALTER TABLE ADD COLUMN bigserial with no sequence grant', () => {
    expect(keys(run('ALTER TABLE public.bar ADD COLUMN n bigserial;'))).toEqual([
      'sequence:bar_n_seq',
    ])
  })

  it('passes ALTER COLUMN SET DEFAULT nextval with a sequence grant', () => {
    const sql = `ALTER TABLE public.bar ALTER COLUMN n SET DEFAULT nextval('bar_n_seq');
GRANT USAGE ON SEQUENCE bar_n_seq TO service_role;`
    expect(run(sql)).toEqual([])
  })

  it('fails ALTER COLUMN SET DEFAULT nextval with no sequence grant', () => {
    const sql = "ALTER TABLE public.bar ALTER COLUMN n SET DEFAULT nextval('bar_n_seq');"
    expect(keys(run(sql))).toEqual(['sequence:bar_n_seq'])
  })

  it("does not let one table's sequence grant satisfy another table's serial column", () => {
    const sql = `CREATE TABLE alpha (id bigserial PRIMARY KEY);
CREATE TABLE beta (id bigserial PRIMARY KEY);
GRANT SELECT, INSERT ON public.alpha, public.beta TO service_role;
GRANT SELECT ON public.alpha, public.beta TO authenticated;
GRANT USAGE ON SEQUENCE public.alpha_id_seq TO service_role;`
    const v = run(sql)
    expect(keys(v)).toEqual(['sequence:beta_id_seq'])
    expect(v[0].message).toContain('column beta.id')
  })

  it('passes a sequence ack with a valid reason', () => {
    const sql = `ALTER TABLE public.bar ADD COLUMN n bigserial;
-- audit:check-77-ack sequence none bar.n: ${GOOD_REASON}`
    expect(run(sql)).toEqual([])
  })

  it('accepts a USAGE grant on a sequence the file creates (truncated-name escape)', () => {
    const sql = `CREATE SEQUENCE public.short_seq;
GRANT USAGE ON SEQUENCE short_seq TO service_role;
GRANT SELECT ON SEQUENCE short_seq TO authenticated;
CREATE TABLE foo (id bigint DEFAULT nextval('short_seq'));
GRANT SELECT ON public.foo TO service_role, authenticated;`
    expect(run(sql)).toEqual([])
  })

  it("passes Migration B's body (REVOKE ... ON ALL TABLES ... FROM)", () => {
    const sql =
      'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated;'
    expect(run(sql)).toEqual([])
  })

  it('passes REVOKE TRUNCATE on a table', () => {
    expect(run('REVOKE TRUNCATE ON public.foo FROM authenticated;')).toEqual([])
  })

  it('passes ALTER DEFAULT PRIVILEGES ... REVOKE', () => {
    expect(
      run('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;')
    ).toEqual([])
  })

  it('passes GRANT ALL ON SEQUENCE (out of scope for the forbidden-ALL rule)', () => {
    expect(run('GRANT ALL ON SEQUENCE public.foo_id_seq TO authenticated;')).toEqual([])
  })

  it("ignores Migration A's exact filename even with client TRUNCATE grants", () => {
    const sql = 'GRANT TRUNCATE ON public.foo TO anon;'
    expect(run(sql, '20261021000000_explicit_grants_backfill.sql')).toEqual([])
    // control: the same SQL under a different in-scope name is flagged
    expect(keys(run(sql, '20261022000000_other.sql'))).toEqual(['forbidden:foo'])
  })

  it('fails GRANT ALL to anon as a forbidden privilege', () => {
    const v = run('GRANT ALL ON public.foo TO anon;')
    expect(keys(v)).toEqual(['forbidden:foo'])
    expect(v[0].message).toContain('ALL')
    expect(v[0].message).toContain('anon')
    expect(v[0].fix).toContain('list the privileges explicitly')
  })

  it('fails GRANT TRUNCATE to authenticated', () => {
    const v = run('GRANT TRUNCATE ON public.foo TO authenticated;')
    expect(keys(v)).toEqual(['forbidden:foo'])
    expect(v[0].message).toContain('TRUNCATE')
    expect(v[0].message).toContain('authenticated')
  })

  it('fails GRANT ... ON ALL TABLES IN SCHEMA public TO anon', () => {
    const v = run('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;')
    expect(keys(v)).toEqual(['forbidden:ALL TABLES IN SCHEMA public'])
  })

  it('fails ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon', () => {
    const v = run('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;')
    expect(keys(v)).toEqual(['forbidden:ALTER DEFAULT PRIVILEGES'])
  })

  it('fails a clients ack whose reason is a placeholder (too short)', () => {
    const sql = `CREATE TABLE foo (id int);
GRANT SELECT ON public.foo TO service_role;
-- audit:check-77-ack clients none foo: TODO`
    const v = run(sql)
    expect(keys(v)).toEqual(['clients:foo'])
    expect(v[0].message).toContain('shorter than 18')
  })

  it('fails a long-enough placeholder reason', () => {
    const sql = `CREATE TABLE foo (id int);
GRANT SELECT ON public.foo TO service_role;
-- audit:check-77-ack clients none foo: TODO fill this in later please`
    const v = run(sql)
    expect(keys(v)).toEqual(['clients:foo'])
    expect(v[0].message).toContain('placeholder')
  })

  it('fails an ack that names a different relation', () => {
    const sql = `CREATE TABLE foo (id int);
GRANT SELECT ON public.foo TO service_role;
-- audit:check-77-ack clients none bar: ${GOOD_REASON}`
    const v = run(sql)
    expect(keys(v)).toEqual(['clients:foo'])
    expect(v[0].message).toContain('different relation')
  })

  it('does not accept a prefix-named ack (foobar for foo)', () => {
    const sql = `CREATE TABLE foo (id int);
GRANT SELECT ON public.foo TO service_role;
-- audit:check-77-ack clients none foobar: ${GOOD_REASON}`
    expect(keys(run(sql))).toEqual(['clients:foo'])
  })

  it('ignores TEMP tables and other schemas', () => {
    expect(run('CREATE TEMP TABLE t (id int);')).toEqual([])
    expect(run('CREATE TABLE private.x (id int);')).toEqual([])
  })

  it('ignores relation DDL inside comments', () => {
    expect(run('-- CREATE TABLE x (id int);')).toEqual([])
    expect(run('/* CREATE TABLE x (id int); */')).toEqual([])
  })

  it('ignores CREATE TABLE inside a $$ function body (documented gap)', () => {
    const sql = `CREATE FUNCTION public.mk() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  CREATE TABLE x (id int);
END;
$$;`
    expect(run(sql)).toEqual([])
  })

  it('ignores a file at or before the cutoff', () => {
    expect(run('CREATE TABLE foo (id int);', '20261021000000_old.sql')).toEqual([])
    expect(run('CREATE TABLE foo (id int);', '20260101000000_old.sql')).toEqual([])
    expect(keys(run('CREATE TABLE foo (id int);', '20261021000001_new.sql'))).toEqual([
      'clients:foo',
      'service_role:foo',
    ])
  })

  it('treats legacy short-prefix migrations as pre-cutoff but checks unparseable names', () => {
    const sql = 'CREATE TABLE foo (id int);'
    expect(run(sql, '001_initial_schema.sql')).toEqual([])
    expect(keys(run(sql, 'no_prefix_at_all.sql'))).toEqual(['clients:foo', 'service_role:foo'])
    expect(keys(run(sql, '20261101_short_timestamp.sql'))).toEqual([
      'clients:foo',
      'service_role:foo',
    ])
  })

  it('skips partition children (parent grants cover them)', () => {
    expect(run('CREATE TABLE public.m_2026 PARTITION OF public.m FOR VALUES IN (1);')).toEqual([])
  })

  it('treats identity columns as exempt behind the single constant', () => {
    expect(mod.CHECK77_IDENTITY_NEEDS_SEQUENCE_GRANT).toBe(false)
    const sql = `CREATE TABLE foo (id bigint GENERATED ALWAYS AS IDENTITY);
GRANT SELECT, INSERT ON public.foo TO service_role, authenticated;`
    expect(run(sql)).toEqual([])
  })

  it('does not treat the word serial inside a string default as a serial column', () => {
    const sql = `CREATE TABLE foo (kind text DEFAULT 'serial');
GRANT SELECT ON public.foo TO service_role, authenticated;`
    expect(run(sql)).toEqual([])
  })

  it('prints the exact fix line from the spec', () => {
    const v = run('CREATE TABLE public.foo (id int);').find((x) => x.decision === 'service_role')
    expect(v?.fix).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.foo TO service_role;'
    )
    expect(v?.fix).toContain('-- audit:check-77-ack service_role none foo: <why')
  })
})

describe('Check 77: scan scope classifier', () => {
  const inScope = ['20261101000000_a.sql', '20261102000000_b.sql']

  it('fails INCONCLUSIVE when an encrypted in-scope file is in the PR diff', () => {
    const r = classifyScanScope({
      inScopeFiles: inScope,
      encryptedFiles: [inScope[1]],
      diffFiles: ['supabase/migrations/' + inScope[1]],
    })
    expect(r.status).toBe('inconclusive')
    expect(r.reason).toContain('INCONCLUSIVE')
    expect(r.reason).toContain(inScope[1])
  })

  it('passes "not checked" when the encrypted in-scope file is not in the diff (Dependabot case)', () => {
    const r = classifyScanScope({ inScopeFiles: inScope, encryptedFiles: inScope, diffFiles: [] })
    expect(r.status).toBe('not-checked')
    expect(r.reason).toBe('not checked: tree locked, no in-scope migration in this diff')
    expect(r.scanned).toBe(0)
  })

  it('scans the readable files when only some are encrypted and none is in the diff', () => {
    const r = classifyScanScope({
      inScopeFiles: inScope,
      encryptedFiles: [inScope[0]],
      diffFiles: [],
    })
    expect(r).toMatchObject({ status: 'pass', scanned: 1 })
  })

  it('reports zero in-scope files as not checked, never as a silent pass', () => {
    const r = classifyScanScope({ inScopeFiles: [], encryptedFiles: [], diffFiles: [] })
    expect(r.status).toBe('not-checked')
    expect(r.reason).toContain('0 files scanned')
  })

  it('fails closed when the diff is unknown and something is encrypted', () => {
    const r = classifyScanScope({
      inScopeFiles: inScope,
      encryptedFiles: [inScope[0]],
      diffFiles: null,
    })
    expect(r.status).toBe('inconclusive')
    expect(r.reason).toContain('could not be determined')
  })

  it('scans normally with an unknown diff when nothing is encrypted', () => {
    const r = classifyScanScope({ inScopeFiles: inScope, encryptedFiles: [], diffFiles: null })
    expect(r).toMatchObject({ status: 'pass', scanned: 2 })
  })
})

describe('Check 77: statement splitting and comment stripping', () => {
  it('does not split on a semicolon inside a string', () => {
    expect(splitSqlStatements("SELECT 'a;b'; SELECT 2;")).toEqual(["SELECT 'a;b'", 'SELECT 2'])
  })

  it('does not split on a semicolon inside $$ ... $$', () => {
    const sql = 'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; SELECT 3;'
    expect(splitSqlStatements(sql)).toEqual([
      'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$',
      'SELECT 3',
    ])
  })

  it('does not split on a semicolon inside $tag$ ... $tag$ (and a $$ inside it)', () => {
    const sql = 'DO $body$ BEGIN PERFORM $$x;y$$; END $body$; SELECT 4;'
    expect(splitSqlStatements(sql)).toEqual([
      'DO $body$ BEGIN PERFORM $$x;y$$; END $body$',
      'SELECT 4',
    ])
  })

  it('does not split on a semicolon inside a quoted identifier', () => {
    expect(splitSqlStatements('CREATE TABLE "a;b" (id int); SELECT 1;')).toEqual([
      'CREATE TABLE "a;b" (id int)',
      'SELECT 1',
    ])
  })

  it('handles doubled quotes inside strings', () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2;")).toEqual([
      "SELECT 'it''s; fine'",
      'SELECT 2',
    ])
  })

  it('strips comments but not comment markers inside strings or dollar bodies', () => {
    const sql =
      "SELECT '-- keep'; -- drop\nSELECT $$ /* keep */ $$; /* drop /* nested */ */ SELECT 3;"
    const out = stripSqlComments(sql)
    expect(out).toContain("'-- keep'")
    expect(out).toContain('$$ /* keep */ $$')
    expect(out).not.toContain('drop')
  })

  it('finds ack markers on raw text before stripping removes them', () => {
    const sql = `-- audit:check-77-ack clients none foo: ${GOOD_REASON}\nSELECT 1;`
    expect(stripSqlComments(sql)).not.toContain('audit:check-77-ack')
    expect(mod.findCheck77Acks(sql)).toMatchObject([{ kind: 'clients', key: 'foo', problem: null }])
  })
})
