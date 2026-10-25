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
type Scope = { status: string; scanned: number; reason: string; diffKnown?: boolean }

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
  runCheck77: (a: {
    migrationFiles: string[]
    readFile: (f: string) => string
    isEncrypted: (f: string) => boolean
    diffFiles: string[] | null
    pass: (m: string) => void
    fail: (m: string, hint?: string) => void
    note?: (line: string) => void
  }) => void
  getCheck77DiffFiles: (a: {
    execFile: (args: string[]) => string
    baseRef?: string
  }) => string[] | null
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

  // Expected names below were produced by real PostgreSQL 17 (CREATE TABLE ... serial, then
  // pg_class), not by this module's own truncation logic.
  const LONG_A = 'registry_audit_volume_monitor_health_history_alpha_archive_v1'
  const LONG_B = 'registry_audit_volume_monitor_health_history_beta_archive_v1'
  const SEQ_A = 'registry_audit_volume_monitor_health_history_alpha_archi_id_seq'
  const SEQ_B = 'registry_audit_volume_monitor_health_history_beta_archiv_id_seq'

  it("does not let a long-named table borrow another long table's truncated sequence grant", () => {
    const sql = `CREATE TABLE ${LONG_A} (id bigserial PRIMARY KEY);
CREATE TABLE ${LONG_B} (id bigserial PRIMARY KEY);
GRANT SELECT, INSERT ON public.${LONG_A}, public.${LONG_B} TO service_role;
GRANT SELECT ON public.${LONG_A}, public.${LONG_B} TO authenticated;
GRANT USAGE ON SEQUENCE public.${SEQ_A} TO service_role;`
    expect(keys(run(sql))).toEqual([`sequence:${SEQ_B}`])
  })

  it('accepts the exact Postgres-truncated sequence name for long table and column names', () => {
    const sql = `CREATE TABLE ${LONG_A} (id bigserial PRIMARY KEY);
GRANT SELECT, INSERT ON public.${LONG_A} TO service_role;
GRANT SELECT ON public.${LONG_A} TO authenticated;
GRANT USAGE ON SEQUENCE public.${SEQ_A} TO service_role;
CREATE TABLE events (a_really_long_column_name_that_goes_on_and_on_and_on_forever_x serial);
GRANT SELECT, INSERT ON public.events TO service_role;
GRANT SELECT ON public.events TO authenticated;
GRANT USAGE ON SEQUENCE public.events_a_really_long_column_name_that_goes_on_and_on_and_on_seq TO service_role;`
    expect(run(sql)).toEqual([])
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

  it('ignores TEMP tables and other schemas, but still flags a real table beside them', () => {
    const sql = `CREATE TEMP TABLE t (id int);
CREATE TEMPORARY TABLE t2 (id int);
CREATE TABLE private.x (id int);
CREATE TABLE real_one (id int);`
    // only real_one: a TEMP/other-schema table leaking in, or nothing being scanned, both fail
    expect(keys(run(sql))).toEqual(['clients:real_one', 'service_role:real_one'])
  })

  it('ignores relation DDL inside comments', () => {
    expect(run('-- CREATE TABLE x (id int);')).toEqual([])
    expect(run('/* CREATE TABLE x (id int); */')).toEqual([])
  })

  it('ignores CREATE TABLE inside a $$ function body (documented gap) but not one after it', () => {
    const sql = `CREATE FUNCTION public.mk() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  CREATE TABLE x (id int);
END;
$$;
CREATE TABLE after_body (id int);
SELECT $$ x INTO decoy_dollar $$ AS a;
SELECT 'x INTO decoy_string' AS b;`
    // x and the INTO decoys sit in a dollar body / string, so they are masked. after_body proves
    // the scan continued past the body; the decoys fail if masking stops blanking literals.
    expect(keys(run(sql))).toEqual(['clients:after_body', 'service_role:after_body'])
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

  it('flags ALTER DEFAULT PRIVILEGES granted to PUBLIC or a quoted API role, not to others', () => {
    const adp = (to: string) =>
      keys(run(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${to};`))
    const hit = ['forbidden:ALTER DEFAULT PRIVILEGES']
    expect(adp('PUBLIC')).toEqual(hit)
    expect(adp('public')).toEqual(hit)
    expect(adp('"anon"')).toEqual(hit)
    expect(adp('GROUP authenticated')).toEqual(hit)
    expect(adp('"service_role" WITH GRANT OPTION')).toEqual(hit)
    expect(adp('postgres, "Anon"')).toEqual([]) // "Anon" is a different, case-sensitive role
    expect(adp('postgres')).toEqual([])
  })

  it('normalizes quoted and PUBLIC grantees on plain GRANT too', () => {
    expect(keys(run('GRANT TRUNCATE ON public.foo TO "anon";'))).toEqual(['forbidden:foo'])
    expect(keys(run('GRANT ALL ON public.foo TO PUBLIC;'))).toEqual(['forbidden:foo'])
    expect(run('GRANT TRUNCATE ON public.foo TO "Anon";')).toEqual([])
  })

  it('reports one violation for GRANT TRUNCATE ON ALL TABLES, still naming the privilege', () => {
    const v = run('GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO anon;')
    expect(keys(v)).toEqual(['forbidden:ALL TABLES IN SCHEMA public'])
    expect(v[0].message).toContain('TRUNCATE')
    // control: a different statement is a different violation
    const two = run(
      'GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO anon; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;'
    )
    expect(keys(two)).toEqual([
      'forbidden:ALL SEQUENCES IN SCHEMA public',
      'forbidden:ALL TABLES IN SCHEMA public',
    ])
  })

  it('honours acks only in real top-level -- line comments', () => {
    const ack = (t: string) => `-- audit:check-77-ack clients none ${t}: ${GOOD_REASON}`
    const base = (t: string) =>
      `CREATE TABLE ${t} (id int);\nGRANT SELECT ON public.${t} TO service_role;\n`
    const sql =
      base('in_string') +
      `SELECT '\n${ack('in_string')}\n';\n` +
      base('in_dollar') +
      `DO $$\n${ack('in_dollar')}\n$$;\n` +
      base('in_block') +
      `/*\n${ack('in_block')}\n*/\n` +
      base('real') +
      `${ack('real')}\n`
    // the three fake acks must not count; the real one (control) must
    expect(keys(run(sql))).toEqual(['clients:in_block', 'clients:in_dollar', 'clients:in_string'])
  })

  it('treats CREATE FOREIGN TABLE as a relation', () => {
    const sql = `CREATE FOREIGN TABLE ft (id int) SERVER s;
CREATE FOREIGN TABLE ok_ft (id int) SERVER s;
GRANT SELECT ON public.ok_ft TO service_role, authenticated;`
    expect(keys(run(sql))).toEqual(['clients:ft', 'service_role:ft'])
  })

  it('treats WITH ... SELECT INTO as creating a table, but not WITH ... INSERT INTO', () => {
    const sql = `WITH x AS (SELECT 1 AS a) SELECT a INTO made FROM x;
WITH y AS (SELECT 1 AS a) INSERT INTO not_made SELECT a FROM y;
WITH z AS (SELECT 1 AS a) SELECT a INTO TEMP scratch FROM z;`
    expect(keys(run(sql))).toEqual(['clients:made', 'service_role:made'])
  })

  it('lets a later REVOKE cancel an earlier GRANT, in statement order', () => {
    const sql = `CREATE TABLE revoked (id int);
GRANT SELECT ON public.revoked TO service_role, authenticated;
REVOKE ALL ON public.revoked FROM service_role;
CREATE TABLE early (id int);
REVOKE ALL ON public.early FROM service_role;
GRANT SELECT ON public.early TO service_role, authenticated;
CREATE TABLE partial (id int);
GRANT SELECT, INSERT ON public.partial TO service_role, authenticated;
REVOKE INSERT, TRUNCATE ON public.partial FROM service_role;
CREATE TABLE swept (id int);
GRANT SELECT ON public.swept TO service_role, authenticated;
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM authenticated;`
    // revoked: service_role cancelled. early: revoke came first, grant stands. partial: SELECT survives.
    // swept: schema-wide REVOKE cancels authenticated on every table granted before it
    // (it cancels authenticated SELECT on revoked and early too; partial keeps its INSERT, so it stays clean).
    expect(keys(run(sql))).toEqual([
      'clients:early',
      'clients:revoked',
      'clients:swept',
      'service_role:revoked',
    ])
  })

  it('does not let a column-level REVOKE cancel a table-level grant decision', () => {
    // Postgres: REVOKE SELECT (id) removes only the column privilege; table-level SELECT stands.
    const sql = `CREATE TABLE colrev (id int, secret text);
GRANT SELECT ON public.colrev TO service_role, authenticated;
REVOKE SELECT (secret) ON public.colrev FROM authenticated;
CREATE TABLE tblrev (id int);
GRANT SELECT ON public.tblrev TO service_role, authenticated;
REVOKE SELECT ON public.tblrev FROM authenticated;`
    // control: the table-level REVOKE on tblrev still cancels its client decision.
    expect(keys(run(sql))).toEqual(['clients:tblrev'])
  })

  it('counts a grant as a decision only if it carries a usable privilege', () => {
    const sql = `CREATE TABLE refs (id int);
GRANT REFERENCES ON public.refs TO service_role;
GRANT SELECT ON public.refs TO authenticated;
CREATE TABLE writes (id int);
GRANT DELETE ON public.writes TO service_role, authenticated;
CREATE SEQUENCE s_bad;
GRANT UPDATE ON SEQUENCE public.s_bad TO service_role, authenticated;
CREATE SEQUENCE s_ok;
GRANT USAGE ON SEQUENCE public.s_ok TO service_role;
GRANT SELECT ON SEQUENCE public.s_ok TO authenticated;`
    expect(keys(run(sql))).toEqual(['clients:s_bad', 'service_role:refs', 'service_role:s_bad'])
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

  // SMI-7164 R2a: the classifier says the diff itself was unknown, so the wiring can name the right remedy.
  it('marks an unknown-diff INCONCLUSIVE as diffKnown: false', () => {
    const r = classifyScanScope({
      inScopeFiles: inScope,
      encryptedFiles: [inScope[0]],
      diffFiles: null,
    })
    expect(r.status).toBe('inconclusive')
    expect(r.diffKnown).toBe(false)
  })

  // SMI-7164 R2c (control, classifier half): a known diff with an encrypted file in it is not "diff unknown".
  it('does not mark a known-diff INCONCLUSIVE as diffKnown: false', () => {
    const r = classifyScanScope({
      inScopeFiles: inScope,
      encryptedFiles: [inScope[1]],
      diffFiles: ['supabase/migrations/' + inScope[1]],
    })
    expect(r.status).toBe('inconclusive')
    expect(r.diffKnown).not.toBe(false)
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

  it('finds ack markers in real line comments, which stripping removes from the text', () => {
    const sql = `-- audit:check-77-ack clients none foo: ${GOOD_REASON}\nSELECT 1;`
    expect(stripSqlComments(sql)).not.toContain('audit:check-77-ack')
    expect(mod.findCheck77Acks(sql)).toMatchObject([{ kind: 'clients', key: 'foo', problem: null }])
  })
})

describe('Check 77: audit wiring (runCheck77)', () => {
  const GOOD = '20261101000000_good.sql'
  const BAD = '20261102000000_bad.sql'
  const OLD = '20260101000000_old.sql'
  const files: Record<string, string> = {
    [GOOD]: 'CREATE TABLE ok (id int);\nGRANT SELECT ON public.ok TO service_role, authenticated;',
    [BAD]: 'CREATE TABLE bad (id int);',
    [OLD]: 'CREATE TABLE legacy (id int);',
    '20261021000000_explicit_grants_backfill.sql': 'GRANT TRUNCATE ON public.x TO anon;',
  }
  const drive = (over: Partial<Parameters<typeof mod.runCheck77>[0]> = {}) => {
    const calls = {
      pass: [] as string[],
      fail: [] as string[],
      fix: [] as Array<string | undefined>,
      note: [] as string[],
      read: [] as string[],
    }
    mod.runCheck77({
      migrationFiles: Object.keys(files),
      readFile: (f) => (calls.read.push(f), files[f]),
      isEncrypted: () => false,
      diffFiles: [],
      pass: (m) => calls.pass.push(m),
      fail: (m, hint) => (calls.fail.push(m), calls.fix.push(hint)),
      note: (l) => calls.note.push(l),
      ...over,
    })
    return calls
  }

  it('fails with the Check 77 message for an in-scope violating file', () => {
    const c = drive()
    expect(c.pass).toEqual([])
    expect(c.fail.length).toBe(2)
    expect(c.fail[0]).toContain('Check 77: supabase/migrations/' + BAD)
    expect(c.fail[0]).toContain('public.bad has no service_role grant decision')
    expect(c.note.join('\n')).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bad')
  })

  it('passes a clean in-scope set and states how many files it scanned', () => {
    const c = drive({ migrationFiles: [GOOD, OLD] })
    expect(c.fail).toEqual([])
    expect(c.pass).toHaveLength(1)
    expect(c.pass[0]).toContain('scanned 1 in-scope migration(s)')
    expect(c.read).toEqual([GOOD]) // the pre-cutoff file was never read
  })

  it('says "not checked" rather than passing silently when nothing is in scope', () => {
    const c = drive({ migrationFiles: [OLD, 'README.md'] })
    expect(c.fail).toEqual([])
    expect(c.pass).toEqual(['Check 77: not checked: no in-scope migrations (0 files scanned)'])
  })

  it('fails INCONCLUSIVE, without reading it, when an encrypted file is in the diff', () => {
    const c = drive({
      isEncrypted: (f) => f === BAD,
      diffFiles: ['supabase/migrations/' + BAD],
    })
    expect(c.pass).toEqual([])
    expect(c.fail).toHaveLength(1)
    expect(c.fail[0]).toContain('INCONCLUSIVE')
    expect(c.fail[0]).toContain(BAD)
    expect(c.read).toEqual([])
  })

  it('fails INCONCLUSIVE when the diff is unknown and a file is encrypted', () => {
    const c = drive({ isEncrypted: (f) => f === BAD, diffFiles: null })
    expect(c.fail).toHaveLength(1)
    expect(c.fail[0]).toContain('could not be determined')
  })

  // SMI-7164 R2b (property): an unknown diff and an encrypted file in a known diff are different
  // faults with different fixes, so the same path must not hand both the same remedy.
  it('names a different fix for an unknown diff than for an encrypted file in a known diff', () => {
    const unknown = drive({ isEncrypted: (f) => f === BAD, diffFiles: null })
    const known = drive({
      isEncrypted: (f) => f === BAD,
      diffFiles: ['supabase/migrations/' + BAD],
    })
    expect(unknown.fail).toHaveLength(1)
    expect(known.fail).toHaveLength(1)
    expect(unknown.fix[0]).not.toEqual(known.fix[0])
    expect(unknown.fix[0]).toContain('fetch-depth: 0')
    expect(unknown.fix[0]).toContain('Check 78')
  })

  // SMI-7164 R2c (control, wiring half): the known-diff case keeps the git-crypt remedy.
  it('keeps the unlock-git-crypt fix when an encrypted file is in a known diff', () => {
    const c = drive({ isEncrypted: (f) => f === BAD, diffFiles: ['supabase/migrations/' + BAD] })
    // The property: this fault is the missing key, so the remedy names the key, not the checkout.
    expect(c.fix).toHaveLength(1)
    expect(c.fix[0]).toContain('Unlock git-crypt')
    expect(c.fix[0]).not.toContain('fetch-depth')
  })

  it('still scans readable files when the encrypted one is not in the diff', () => {
    const c = drive({ isEncrypted: (f) => f === GOOD, diffFiles: [] })
    expect(c.fail.join('\n')).toContain('public.bad')
    expect(c.read).toEqual([BAD])
  })
})

describe('Check 77: PR diff computation (getCheck77DiffFiles)', () => {
  it('passes git arguments as an argv array, never through a shell string', () => {
    const calls: string[][] = []
    const out = mod.getCheck77DiffFiles({
      baseRef: 'main; touch pwned',
      execFile: (args) => {
        calls.push(args)
        return args[0] === 'merge-base'
          ? 'abc123\n'
          : 'supabase/migrations/a.sql\n\nsupabase/migrations/b.sql\n'
      },
    })
    expect(out).toEqual(['supabase/migrations/a.sql', 'supabase/migrations/b.sql'])
    expect(calls[0]).toEqual(['merge-base', 'origin/main; touch pwned', 'HEAD'])
    expect(calls[1]).toEqual(['diff', '--name-only', 'abc123...HEAD', '--', 'supabase/migrations/'])
  })

  it('defaults the base to origin/main and returns null when git fails', () => {
    const seen: string[][] = []
    expect(
      mod.getCheck77DiffFiles({
        execFile: (args) => {
          seen.push(args)
          throw new Error('no remote')
        },
      })
    ).toBeNull()
    expect(seen[0][1]).toBe('origin/main')
  })
})
