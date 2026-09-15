/**
 * SMI-6114: an HONEST TRIPWIRE for
 * supabase/migrations/20260913000000_private_registry_audit_trigger.sql -- NOT a security
 * boundary. Text scanning cannot be one: a third adversarial review round (the round-2 gate on
 * PR #2855, which prompted this rescope) kept finding new bypass classes the previous rewrite
 * hadn't closed (Postgres disables a trigger through
 * ALTER TABLE, not ALTER TRIGGER; a second, differently-named trigger on the same table is outside
 * any name-pinned check; the audit sink itself, audit_logs, can be rewritten out from under an
 * unchanged function via CREATE RULE). Rather than chase a fourth bypass class with a fifth regex,
 * the owner rescoped this file: it is a tripwire that forces a human to look at any migration that
 * touches this trigger, this function, or its audit_logs sink, not a proof that no unreviewed
 * change can happen. THE REAL INVARIANT (one row per committed change, no text columns copied, the
 * untag rule) is enforced by live-Postgres suites once SMI-5946 wires Postgres into CI:
 * `private-registry-audit-trigger.test.ts` (row-shape / fail-closed / actor derivation) and
 * `private-registry-audit-visibility.test.ts` (audit visibility never exceeds data visibility).
 * Both skip today without a test database and do not run in CI yet.
 *
 * SMI-6680 (post-merge governance retro on PR #2855) split the implementation out of this file into
 * four siblings so every non-test file here stays under the repo's 500-line gate --
 * `private-registry-audit-trigger.scanner.ts` (comment/quote-aware text scanning),
 * `.migrations.ts` (directory reading/ordering, `dir`-overridable so tests can point at a tmpdir),
 * `.pins.ts` (the raw-text sha256/exact-text pins), and `.detectors.ts` (the five fail-closed
 * "later migration" tripwires). SMI-6680's own finding F1: every detector iterated
 * `laterMigrationFiles()` against the REAL migrations directory, which returns `[]` (this migration
 * is the newest of 207 files today) -- so none of the five detectors below was ever exercised by a
 * committed test. The `describe('later-migration tripwires ...')` block further down drives all
 * five against `mkdtempSync()` fixtures instead.
 *
 * WHAT THIS FILE DOES NOT, AND CANNOT, DETECT:
 *   - role-membership grants (`GRANT audit_runner TO authenticated;`) that hand a broader role the
 *     EXECUTE privilege this file's own GRANT check already denies to that role by name, or any
 *     other GRANT/REVOKE against audit_logs itself (e.g. `REVOKE INSERT ON audit_logs FROM ...`);
 *   - RLS policy changes on audit_logs (`CREATE POLICY`, `ALTER POLICY`, `DROP POLICY`, or
 *     `ENABLE`/`DISABLE ROW LEVEL SECURITY`) that narrow or widen who can read or write the sink;
 *   - a retention/cleanup job (a pg_cron `DELETE FROM audit_logs ...` or similar scheduled job)
 *     that prunes rows the pinned insert wrote;
 *   - dynamic SQL assembled inside a `DO $$ ... $$` block or an `EXECUTE '...'` string, where the
 *     protected keywords never appear as contiguous, parseable statement text;
 *   - any change applied outside a migration file altogether (a manual `psql` session against
 *     prod, for instance) -- this file only ever reads `supabase/migrations/`.
 *
 * MODEL:
 *   1. THE PIN FORCES HUMAN REVIEW OF ANY CHANGE, INCLUDING A COMMENT. A fail-closed parser
 *      (DEF_RE, `.pins.ts`) finds every CREATE [OR REPLACE] FUNCTION of
 *      audit_private_registry_skills_change() across all migrations regardless of schema
 *      qualification, dollar-quote tag or case, and a separate mention counter catches anything
 *      DEF_RE could not parse instead of silently ignoring it (gate finding F1). The latest
 *      definition's RAW header and body -- no comment stripping, no whitespace collapsing -- are
 *      pinned by sha256: any change to either, down to a single added comment, must change the
 *      pinned hash, which means a human has to look at the diff and update the constant. The
 *      triggers are pinned the same way, against exact raw expected text.
 *   2. THREE MORE FAIL-CLOSED CHECKS, ONE PER ROUND-2 GATE FINDING, EACH EXEMPTABLE ONLY BY NAME.
 *      A later migration that disables either audit trigger via `ALTER TABLE ... DISABLE TRIGGER`
 *      (gate finding 1), that creates ANY new trigger on `private_registry_skills` or ANY overload
 *      of `audit_private_registry_skills_change` (gate finding 2), or that rewrites, drops,
 *      renames or adds a trigger/rule to the `audit_logs` sink itself, or changes its column shape
 *      underneath the pinned insert (gate finding 3, extended by round-3 gate finding 1) -- fails
 *      this suite. The only way past any of the three is to add the migration's filename to
 *      REVIEWED_LATER_MIGRATIONS (`.detectors.ts`), after review -- never to weaken the regex.
 *      Two more checks in the same file (drop/alter by exact pinned name; re-grant EXECUTE, by
 *      name OR schema-wide OR via ALTER DEFAULT PRIVILEGES, SMI-6680 F3) have NO allowlist escape
 *      hatch at all -- see `nonExemptRemediation()`.
 *   3. THE SEMANTIC CHECKS DOCUMENT WHY THE PINNED BODY WAS APPROVED, not police future changes:
 *      no EXCEPTION handler (fail-closed), the exact untag CASE, one team_id write, and full
 *      column coverage. They run against the LATEST parsed definition so they keep describing
 *      reality after a future reviewed redefinition, but the pin above -- not these regexes -- is
 *      what makes a bad change fail loudly.
 *
 * Column coverage is the one guard the live suite cannot provide even when it does run: the
 * trigger lists every private_registry_skills column explicitly so it can report an exact
 * `changed_columns` list, and this file's coverage check derives the column set from the
 * migrations so a later column addition without a matching trigger clause fails at PR time.
 *
 * Git-crypt: same contract as private-registry-rls.test.ts (SMI-5984). A locked migration is only
 * accepted when SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED=1; content assertions then skip.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MIGRATION_FILE,
  PROD_COLUMNS,
  ROLLBACK_FILE,
  allMigrationFiles,
  readMigration,
  unprefixedMigrationFiles,
} from './private-registry-audit-trigger.migrations.ts'
import {
  splitStatements,
  stripComments,
  stripLineComments,
} from './private-registry-audit-trigger.scanner.ts'
import {
  EXPECTED_TRG_PRS_AUDIT,
  EXPECTED_TRG_PRS_AUDIT_TRUNCATE,
  FUNCTION_CREATE_MENTION_RE,
  PINNED_BODY_SHA256,
  PINNED_HEADER_SHA256,
  allFunctionDefinitions,
  columnsFromMigrations,
  latestFunctionBody,
  pinRemediation,
  sha256,
  triggerDefinitions,
} from './private-registry-audit-trigger.pins.ts'
import {
  auditSinkViolations,
  disableTriggerViolations,
  grantExecuteViolations,
  laterTriggerViolations,
  triggerOrFunctionTamperViolations,
} from './private-registry-audit-trigger.detectors.ts'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  auditSecdefAnonGrants: (
    migrations: Array<{ name: string; content: string }>,
    opts: { cutoff: string | number; allowlist?: string[] }
  ) => Array<{ file: string; fn: string; signature: string; reason: string }>
}

const triggerSql = readMigration(MIGRATION_FILE)
const locked = triggerSql === null

describe.skipIf(locked)('20260913000000_private_registry_audit_trigger.sql (SMI-6114)', () => {
  const sql = triggerSql ?? ''
  const code = stripLineComments(sql)

  it(
    'parses every CREATE FUNCTION mention of audit_private_registry_skills_change() -- fails ' +
      'closed on anything it cannot read (SMI-6114 retro F1)',
    () => {
      const mentionCounts = new Map<string, number>()
      for (const file of allMigrationFiles()) {
        const content = readMigration(file)
        if (content === null) continue
        const n = [...content.matchAll(FUNCTION_CREATE_MENTION_RE)].length
        if (n > 0) mentionCounts.set(file, n)
      }
      const defCounts = new Map<string, number>()
      for (const d of allFunctionDefinitions()) {
        defCounts.set(d.file, (defCounts.get(d.file) ?? 0) + 1)
      }
      const unparsed = [...mentionCounts.entries()]
        .filter(([file, count]) => (defCounts.get(file) ?? 0) < count)
        .map(
          ([file, count]) =>
            `${file}: ${count} CREATE FUNCTION mention(s), only ${defCounts.get(file) ?? 0} parsed`
        )
      expect(
        unparsed,
        'a migration CREATEs the function in a form this parser cannot read'
      ).toEqual([])
    }
  )

  it(
    'pins the function header (RETURNS / LANGUAGE / SECURITY DEFINER / SET search_path) against ' +
      'a reviewed hash -- ADR-164 (SMI-6114 retro F1/F2)',
    () => {
      const defs = allFunctionDefinitions()
      // Denominator first: an empty defs list would make the hash check below vacuous.
      expect(defs.length, 'no parseable definition found in any migration').toBeGreaterThan(0)
      const latest = defs[defs.length - 1] // RAW: no comment stripping, no normalizing.
      expect(
        sha256(latest.header),
        pinRemediation('the function header', latest.file, 'PINNED_HEADER_SHA256')
      ).toBe(PINNED_HEADER_SHA256)
    }
  )

  it('pins the function body against a reviewed hash -- ADR-164 (SMI-6114 retro F1/F2)', () => {
    const defs = allFunctionDefinitions()
    expect(defs.length, 'no parseable definition found in any migration').toBeGreaterThan(0)
    const latest = defs[defs.length - 1] // RAW: no comment stripping, no normalizing.
    expect(
      sha256(latest.body),
      pinRemediation('the function body', latest.file, 'PINNED_BODY_SHA256')
    ).toBe(PINNED_BODY_SHA256)
  })

  it('pins the triggers trg_prs_audit and trg_prs_audit_truncate against reviewed expected text (SMI-6114 retro F1)', () => {
    const auditDefs = triggerDefinitions('trg_prs_audit')
    const truncateDefs = triggerDefinitions('trg_prs_audit_truncate')
    expect(
      auditDefs.length,
      'trg_prs_audit: no CREATE TRIGGER found in any migration'
    ).toBeGreaterThan(0)
    expect(
      truncateDefs.length,
      'trg_prs_audit_truncate: no CREATE TRIGGER found in any migration'
    ).toBeGreaterThan(0)
    const latestAudit = auditDefs[auditDefs.length - 1]
    const latestTruncate = truncateDefs[truncateDefs.length - 1]
    expect(
      latestAudit.text,
      pinRemediation('the trg_prs_audit trigger', latestAudit.file, 'EXPECTED_TRG_PRS_AUDIT')
    ).toBe(EXPECTED_TRG_PRS_AUDIT)
    expect(
      latestTruncate.text,
      pinRemediation(
        'the trg_prs_audit_truncate trigger',
        latestTruncate.file,
        'EXPECTED_TRG_PRS_AUDIT_TRUNCATE'
      )
    ).toBe(EXPECTED_TRG_PRS_AUDIT_TRUNCATE)
  })

  it('no later migration drops or alters the pinned function or triggers by name (SMI-6114 retro F1)', () => {
    expect(
      triggerOrFunctionTamperViolations(),
      'a later migration tampers with the pinned function/trigger by name -- not exemptable, see each entry above'
    ).toEqual([])
  })

  it(
    'no later migration disables an audit trigger via ALTER TABLE, or re-enables it under a ' +
      'non-default firing mode (SMI-6114 retro round 2, finding 1)',
    () => {
      expect(disableTriggerViolations()).toEqual([])
    }
  )

  it(
    'no later migration creates another trigger on private_registry_skills, or an overload of ' +
      'the pinned function (SMI-6114 retro round 2, finding 2)',
    () => {
      expect(laterTriggerViolations()).toEqual([])
    }
  )

  it(
    'no later migration rewrites, drops, renames or adds a trigger/rule to the audit_logs sink ' +
      '(SMI-6114 retro round 2, finding 3)',
    () => {
      expect(auditSinkViolations()).toEqual([])
    }
  )

  it(
    'revokes EXECUTE from anon and authenticated (Check 51/52), and no later migration re-grants ' +
      'it to anon, authenticated or PUBLIC, by name, schema-wide, or via ALTER DEFAULT PRIVILEGES ' +
      '(SMI-6114; schema-wide/ALTER DEFAULT PRIVILEGES SMI-6680 F3)',
    () => {
      // Scoped to MIGRATION_FILE only (not every migration): the whole-directory form picks up
      // pre-existing, out-of-scope SECDEF functions elsewhere in the migration history (e.g.
      // 20260819000002_fix_check_team_tier_access.sql) that are this test's business no more than
      // they were before -- broadening this call is not what "keep the existing check" meant.
      expect(
        helpers.auditSecdefAnonGrants([{ name: MIGRATION_FILE, content: sql }], {
          cutoff: '20260704000000',
        })
      ).toEqual([])
      expect(
        grantExecuteViolations(),
        'a later migration re-grants EXECUTE on the pinned function -- not exemptable, see each entry above'
      ).toEqual([])
    }
  )

  it('fails closed: the function body has no exception handler around the audit write, in the LATEST definition', () => {
    expect(latestFunctionBody()).not.toMatch(/\bEXCEPTION\b/i)
  })

  it(
    'writes metadata.team_id only under the member-visibility rule, via only the two allowed ' +
      'value expressions, in the LATEST definition (SMI-6114 untag, retro F2)',
    () => {
      const body = latestFunctionBody()
      // audit_logs_team_scoped_read reads exactly this key, so it may be WRITTEN in one place
      // only (`'team_id'::TEXT` in the changed-columns list is a column name, not a metadata key).
      expect(body.match(/'team_id'\s*,/g)).toHaveLength(1)
      expect(body).toMatch(
        /CASE WHEN v_tagged THEN jsonb_build_object\('team_id', v_row\.team_id\)\s+ELSE '\{\}'::JSONB END/
      )
      expect(body).toMatch(/v_visible_before := OLD\.approval_status = 'approved';/)
      expect(body).toMatch(/v_visible_after := NEW\.approval_status = 'approved';/)
      expect(body).toMatch(
        /v_tagged := CASE v_event\s+WHEN 'publish' THEN v_visible_after\s+WHEN 'approve' THEN v_visible_after\s+WHEN 'delete'\s+THEN v_visible_before\s+ELSE v_visible_before AND v_visible_after\s+END;/
      )
      // Value-level guard: every NEW|OLD|v_row.team_id reference is either the resource-string
      // concatenation, the always-present registry_team_id entry, the tagged CASE arm, or the
      // changed-column-list comparison -- never a bare copy into a new or unconditional key.
      const teamIdValueRefs = body.match(/(NEW|OLD|v_row)\.team_id\b/g)?.length ?? 0
      const inResourceConcat = body.match(/\|\|\s*v_row\.team_id\s*\|\|/g)?.length ?? 0
      const inRegistryTeamId = body.match(/'registry_team_id',\s*v_row\.team_id/g)?.length ?? 0
      const inCaseArm = body.match(/'team_id',\s*v_row\.team_id/g)?.length ?? 0
      const changeListMatches =
        body.match(
          /IF\s+NEW\.team_id\s+IS DISTINCT FROM\s+OLD\.team_id\s+THEN\s+v_changed\s*:=\s*v_changed\s*\|\|\s*'team_id'::TEXT;\s*END IF;/g
        )?.length ?? 0
      expect(teamIdValueRefs).toBe(
        inResourceConcat + inRegistryTeamId + inCaseArm + changeListMatches * 2
      )
    }
  )

  it('compares every private_registry_skills column the migrations create, in the LATEST definition', () => {
    const columns = columnsFromMigrations()
    // Denominator first: an extractor that found nothing would make the loop below vacuous.
    expect([...columns].sort()).toEqual([...PROD_COLUMNS].sort())
    const body = latestFunctionBody()
    const uncovered = [...columns].filter(
      (col) => !new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}\\b`).test(body)
    )
    expect(uncovered).toEqual([])
  })

  // SMI-6114: pin the schema_version registration (migration insert, rollback delete) so a later
  // edit can't silently drop either half.
  it('registers schema_version 116 exactly once, idempotently, before the transaction COMMIT', () => {
    const inserts = code.match(
      /INSERT INTO schema_version \(version\) VALUES \(116\) ON CONFLICT DO NOTHING;/g
    )
    // Denominator first: a pattern that matched nothing would make the ordering check below vacuous.
    expect(inserts).toHaveLength(1)
    const commits = code.match(/\bCOMMIT;/g)
    expect(commits).toHaveLength(1)
    expect(code.indexOf(inserts![0])).toBeLessThan(code.indexOf(commits![0]))
  })

  it('the standalone rollback file deletes schema_version 116 as a real (uncommented) statement', () => {
    const rollbackCode = stripLineComments(readFileSync(ROLLBACK_FILE, 'utf8'))
    expect(rollbackCode.match(/DELETE FROM schema_version WHERE version = 116;/g)).toHaveLength(1)
  })

  it(
    'every migration filename carries a numeric prefix -- an unprefixed file cannot be ordered ' +
      'against the pin and is invisible to all five later-migration detectors (SMI-6680 F6)',
    () => {
      expect(
        unprefixedMigrationFiles(),
        'unprefixed migration filename(s) found -- laterMigrationFiles() cannot tell whether ' +
          'these are before or after the pinned migration. Rename with a numeric prefix.'
      ).toEqual([])
    }
  )
})

/**
 * pinRemediation() (SMI-6680 F5, PR #2860 gate finding 3). Previously exercised only as vitest's
 * failure-message argument -- with the pins matching (the normal, passing state), that argument is
 * never even evaluated for its content by the assertion, so a regression in the message text alone
 * (wrong wording, a dropped clause, a broken template literal) would leave every pin test green.
 * Assert its return value directly, independent of any pin passing or failing.
 */
describe('pinRemediation() (SMI-6680 F5, PR #2860 gate finding 3)', () => {
  it('names the file, the changed thing, and states plainly that a comment-only edit trips the check', () => {
    const message = pinRemediation(
      'the function header',
      '20990101000000_x.sql',
      'PINNED_HEADER_SHA256'
    )
    expect(message).toBe(
      'the function header changed in 20990101000000_x.sql. A comment-only or whitespace-only ' +
        'edit trips this too, by design (raw text is hashed/compared, not normalized -- see ' +
        "this file's own header). Review the diff against ADR-164, then set PINNED_HEADER_SHA256 " +
        'to the "Received" value above and say in the PR that you did the review.'
    )
  })

  it('substitutes a different what/file/constant triple correctly (not just the header case)', () => {
    const message = pinRemediation(
      'the trg_prs_audit_truncate trigger',
      '20990101000001_y.sql',
      'EXPECTED_TRG_PRS_AUDIT_TRUNCATE'
    )
    expect(message).toContain('the trg_prs_audit_truncate trigger changed in 20990101000001_y.sql')
    expect(message).toContain('set EXPECTED_TRG_PRS_AUDIT_TRUNCATE to the "Received" value above')
  })
})

/**
 * Fixture-driven exercise of the five later-migration detectors in
 * `private-registry-audit-trigger.detectors.ts`, plus `unprefixedMigrationFiles()`
 * (SMI-6680 F1/F6). Deliberately NOT gated by describe.skipIf(locked): every detector accepts an
 * optional `dir`, and every fixture here points it at a `mkdtempSync()` directory rather than the
 * real (git-crypt-scoped) one, so these run even when supabase/migrations/ is locked. Each
 * detector was revert-checked (SMI-6598): neuter it (`return []` at its head), confirm the
 * matching fixture below fails, restore, confirm it passes again -- see the SMI-6680 report for
 * the pass/fail counts.
 */
describe('later-migration tripwires (SMI-6114 retro F1, SMI-6680)', () => {
  function withFixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'private-registry-audit-trigger-fixture-'))
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content)
    }
    return dir
  }
  function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  // PR #2860 gate finding 2: the whole-detector fixture above (now folded into this table) proved
  // the detector isn't a no-op, but individual branches -- ALTER TRIGGER, DROP FUNCTION, ALTER
  // FUNCTION, and the trg_prs_audit_truncate-named half of both DROP/ALTER TRIGGER -- were still
  // deletable without failing anything, since each is a separately-deletable `if` block in
  // triggerOrFunctionTamperViolations(). One row per distinct branch, matching the source
  // one-for-one; all 6 verified against the real detector via tsx before being written down.
  it.each([
    [
      'DROP TRIGGER trg_prs_audit_truncate',
      'DROP TRIGGER IF EXISTS public.trg_prs_audit_truncate;',
      'DROP TRIGGER trg_prs_audit_truncate',
    ],
    [
      'DROP TRIGGER trg_prs_audit',
      'DROP TRIGGER IF EXISTS public.trg_prs_audit;',
      'DROP TRIGGER trg_prs_audit',
    ],
    [
      'DROP FUNCTION',
      'DROP FUNCTION public.audit_private_registry_skills_change();',
      'DROP FUNCTION',
    ],
    [
      'ALTER FUNCTION',
      'ALTER FUNCTION public.audit_private_registry_skills_change() RENAME TO foo;',
      'ALTER FUNCTION',
    ],
    [
      'ALTER TRIGGER trg_prs_audit_truncate',
      'ALTER TRIGGER trg_prs_audit_truncate ON private_registry_skills RENAME TO x_old;',
      'ALTER TRIGGER trg_prs_audit_truncate',
    ],
    [
      'ALTER TRIGGER trg_prs_audit',
      'ALTER TRIGGER trg_prs_audit ON private_registry_skills RENAME TO x_old;',
      'ALTER TRIGGER trg_prs_audit',
    ],
  ])('triggerOrFunctionTamperViolations() catches %s', (_label, stmt, expectedSubstring) => {
    const dir = withFixtureDir({ '20990101000000_tamper.sql': stmt })
    try {
      const offenders = triggerOrFunctionTamperViolations(dir)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain(expectedSubstring)
    } finally {
      cleanup(dir)
    }
  })

  it.each([
    [
      'named function (original shape)',
      'GRANT EXECUTE ON FUNCTION public.audit_private_registry_skills_change() TO authenticated;',
    ],
    [
      'schema-wide (SMI-6680 F3)',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;',
    ],
    [
      'ALTER DEFAULT PRIVILEGES (SMI-6680 F3)',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;',
    ],
  ])('grantExecuteViolations() catches a re-grant shaped as: %s', (_label, stmt) => {
    const dir = withFixtureDir({ '20990101000001_grant.sql': stmt })
    try {
      expect(grantExecuteViolations(dir)).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  it('grantExecuteViolations() does not false-positive on a grant naming a different function', () => {
    const dir = withFixtureDir({
      '20990101000001b_grant_other.sql':
        'GRANT EXECUTE ON FUNCTION public.some_other_function() TO authenticated;',
    })
    try {
      expect(grantExecuteViolations(dir)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  // PR #2860 gate finding 2: only DISABLE TRIGGER ALL was covered; ENABLE REPLICA/ALWAYS TRIGGER
  // (the re-enable-under-a-non-default-firing-mode branch) was not.
  it.each([
    [
      'ALTER TABLE ... DISABLE TRIGGER ALL',
      'ALTER TABLE private_registry_skills DISABLE TRIGGER ALL;',
      'disables a trigger',
    ],
    [
      'ALTER TABLE ... ENABLE REPLICA TRIGGER',
      'ALTER TABLE private_registry_skills ENABLE REPLICA TRIGGER trg_prs_audit;',
      're-enables an audit trigger',
    ],
    [
      'ALTER TABLE ... ENABLE ALWAYS TRIGGER',
      'ALTER TABLE private_registry_skills ENABLE ALWAYS TRIGGER trg_prs_audit;',
      're-enables an audit trigger',
    ],
  ])('disableTriggerViolations() catches %s', (_label, stmt, expectedSubstring) => {
    const dir = withFixtureDir({ '20990101000002_disable.sql': stmt })
    try {
      const offenders = disableTriggerViolations(dir)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain(expectedSubstring)
    } finally {
      cleanup(dir)
    }
  })

  it('disableTriggerViolations() honours REVIEWED_LATER_MIGRATIONS', () => {
    const file = '20990101000002b_disable_reviewed.sql'
    const dir = withFixtureDir({
      [file]: 'ALTER TABLE private_registry_skills DISABLE TRIGGER ALL;',
    })
    try {
      expect(disableTriggerViolations(dir)).toHaveLength(1)
      expect(disableTriggerViolations(dir, [file])).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('laterTriggerViolations() catches a second trigger on private_registry_skills, and honours REVIEWED_LATER_MIGRATIONS', () => {
    const file = '20990101000003_second_trigger.sql'
    const dir = withFixtureDir({
      [file]:
        'CREATE TRIGGER trg_prs_snapshot AFTER INSERT ON private_registry_skills ' +
        'FOR EACH ROW EXECUTE FUNCTION audit_prs_snapshot();',
    })
    try {
      expect(laterTriggerViolations(dir)).toHaveLength(1)
      expect(laterTriggerViolations(dir, [file])).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('laterTriggerViolations() catches an overload of the pinned function', () => {
    const dir = withFixtureDir({
      '20990101000004_overload.sql':
        'CREATE FUNCTION audit_private_registry_skills_change(p_x INT) RETURNS trigger AS ' +
        '$$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    })
    try {
      const offenders = laterTriggerViolations(dir)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain('overload')
    } finally {
      cleanup(dir)
    }
  })

  // PR #2860 gate finding 2: only CREATE RULE and DROP COLUMN were covered, out of 9 distinct
  // branches in auditSinkViolations() (trigger creation, table drop, rename, trigger disable,
  // column-type change, SET NOT NULL, and constraint addition were not). One row per branch,
  // matching the source one-for-one; all verified against the real detector via tsx first.
  it.each([
    [
      'CREATE RULE targeting audit_logs',
      'CREATE RULE suppress_registry_audit AS ON INSERT TO public.audit_logs DO INSTEAD NOTHING;',
      'CREATE RULE targeting audit_logs',
    ],
    [
      'CREATE TRIGGER on audit_logs',
      'CREATE TRIGGER trg_fake AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION noop();',
      'CREATE TRIGGER on audit_logs',
    ],
    ['DROP TABLE audit_logs', 'DROP TABLE audit_logs;', 'DROP TABLE audit_logs'],
    [
      'ALTER TABLE audit_logs ... RENAME',
      'ALTER TABLE audit_logs RENAME TO audit_logs_old;',
      'RENAME',
    ],
    [
      'ALTER TABLE audit_logs ... DISABLE TRIGGER',
      'ALTER TABLE audit_logs DISABLE TRIGGER ALL;',
      'DISABLE TRIGGER',
    ],
    [
      'ALTER TABLE audit_logs ... DROP COLUMN, with a semicolon-bearing literal earlier in the ' +
        'statement (SMI-6680 F2 measured repro)',
      "ALTER TABLE public.audit_logs ADD COLUMN note TEXT DEFAULT 'a;b', DROP COLUMN metadata;",
      'DROP COLUMN',
    ],
    [
      'ALTER TABLE audit_logs ... ALTER COLUMN ... TYPE',
      'ALTER TABLE audit_logs ALTER COLUMN metadata TYPE TEXT;',
      'ALTER COLUMN ... TYPE',
    ],
    [
      'ALTER TABLE audit_logs ... SET NOT NULL',
      'ALTER TABLE audit_logs ALTER COLUMN metadata SET NOT NULL;',
      'SET NOT NULL',
    ],
    [
      'ALTER TABLE audit_logs ... ADD CONSTRAINT/CHECK',
      'ALTER TABLE audit_logs ADD CONSTRAINT chk_x CHECK (true);',
      'ADD CONSTRAINT/CHECK',
    ],
  ])('auditSinkViolations() catches %s', (_label, stmt, expectedSubstring) => {
    const dir = withFixtureDir({ '20990101000005_sink.sql': stmt })
    try {
      const offenders = auditSinkViolations(dir)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain(expectedSubstring)
    } finally {
      cleanup(dir)
    }
  })

  it('auditSinkViolations() honours REVIEWED_LATER_MIGRATIONS', () => {
    const file = '20990101000005b_sink_reviewed.sql'
    const dir = withFixtureDir({
      [file]:
        'CREATE RULE suppress_registry_audit AS ON INSERT TO public.audit_logs DO INSTEAD NOTHING;',
    })
    try {
      expect(auditSinkViolations(dir)).toHaveLength(1)
      expect(auditSinkViolations(dir, [file])).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it("auditSinkViolations() catches ALTER TABLE audit_logs ... DROP COLUMN even with a semicolon inside a double-quoted identifier earlier in the statement (PR #2860 gate finding 1, the reviewer's exact case)", () => {
    const dir = withFixtureDir({
      '20990101000006b_drop_column_quoted.sql':
        'ALTER TABLE public.audit_logs\n' +
        '  ADD COLUMN "note;field" text,\n' +
        '  DROP COLUMN metadata;',
    })
    try {
      const offenders = auditSinkViolations(dir)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain('DROP COLUMN')
    } finally {
      cleanup(dir)
    }
  })

  it('auditSinkViolations() does not false-positive on a CREATE RULE mentioned only inside a block comment', () => {
    const dir = withFixtureDir({
      '20990101000007_commented.sql':
        '/* CREATE RULE suppress_registry_audit AS ON INSERT TO audit_logs DO INSTEAD NOTHING; */',
    })
    try {
      expect(auditSinkViolations(dir)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('auditSinkViolations() still catches a real statement immediately after a comment', () => {
    const dir = withFixtureDir({
      '20990101000008_after_comment.sql':
        '-- a routine comment\nCREATE RULE suppress_registry_audit AS ON INSERT TO audit_logs DO INSTEAD NOTHING;',
    })
    try {
      expect(auditSinkViolations(dir)).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  it('unprefixedMigrationFiles() catches a filename with no numeric prefix (SMI-6680 F6)', () => {
    const dir = withFixtureDir({ 'fix_audit.sql': 'SELECT 1;' })
    try {
      expect(unprefixedMigrationFiles(dir)).toEqual(['fix_audit.sql'])
    } finally {
      cleanup(dir)
    }
  })
})

/**
 * splitStatements() case table (SMI-6680 F2). `stripComments()`'s own case table lives in the
 * describe block below this one; this one is scoped to the `;`-splitting behavior specifically --
 * the defect this fixes is separate from anything stripComments() itself got wrong (it was always
 * quote-aware; only the naive `sql.split(';')` calls that consumed its output weren't).
 */
describe('splitStatements() (SMI-6680 F2)', () => {
  it(
    'does not split on a semicolon inside a single-quoted literal, an E-string, a dollar-quoted ' +
      'body, a double-quoted identifier (incl. doubled "" and U&"..."), or a comment',
    () => {
      expect(splitStatements("SELECT 'a;b' AS x; DROP TABLE foo;")).toEqual([
        "SELECT 'a;b' AS x",
        ' DROP TABLE foo',
        '',
      ])
      expect(splitStatements("SELECT e'a;b' AS x; DROP TABLE foo;")).toEqual([
        "SELECT e'a;b' AS x",
        ' DROP TABLE foo',
        '',
      ])
      expect(splitStatements('SELECT $$a;b$$ AS x; DROP TABLE foo;')).toEqual([
        'SELECT $$a;b$$ AS x',
        ' DROP TABLE foo',
        '',
      ])
      // PR #2860 gate finding 1: quoted identifiers were not atomic before this fix.
      expect(splitStatements('SELECT "a;b" AS x; DROP TABLE foo;')).toEqual([
        'SELECT "a;b" AS x',
        ' DROP TABLE foo',
        '',
      ])
      // Doubled "" inside a quoted identifier embeds a literal quote, not a terminator.
      expect(splitStatements('SELECT "a""b;c" AS x; DROP TABLE foo;')).toEqual([
        'SELECT "a""b;c" AS x',
        ' DROP TABLE foo',
        '',
      ])
      // U&"..." Unicode-escape identifiers close exactly like a plain quoted identifier.
      expect(splitStatements('SELECT U&"a;b" AS x; DROP TABLE foo;')).toEqual([
        'SELECT U&"a;b" AS x',
        ' DROP TABLE foo',
        '',
      ])
      expect(splitStatements('SELECT 1; -- a;b\nDROP TABLE foo;')).toEqual([
        'SELECT 1',
        ' \nDROP TABLE foo',
        '',
      ])
      expect(splitStatements('SELECT 1; /* a;b */ DROP TABLE foo;')).toEqual([
        'SELECT 1',
        '  DROP TABLE foo',
        '',
      ])
    }
  )

  it('measured repro: a naive sql.split(";") never puts the audit_logs table reference and DROP COLUMN in the same chunk when a semicolon sits inside a preceding literal; splitStatements() does', () => {
    // This is the actual defect (SMI-6680 F2): a detector requiring BOTH markers in one chunk
    // (e.g. auditSinkViolations()'s `alterAuditLogsRe.test(stmt) && dropColumnRe.test(stmt)`)
    // never fires against the naive split, even though the raw text "DROP COLUMN" is still
    // present *somewhere* in the split output -- just severed from its table reference.
    const stmt =
      "ALTER TABLE public.audit_logs ADD COLUMN note TEXT DEFAULT 'a;b', DROP COLUMN metadata;"
    const bothInOneChunk = (chunks: string[]): boolean =>
      chunks.some((chunk) => /audit_logs/.test(chunk) && /DROP COLUMN/.test(chunk))
    expect(bothInOneChunk(stmt.split(';'))).toBe(false)
    expect(bothInOneChunk(splitStatements(stmt))).toBe(true)
  })

  it(
    'columnsFromMigrations() (pins.ts) finds a column added after a semicolon-bearing literal in ' +
      'the same ALTER TABLE statement -- the same defect shape as the three detectors above, found ' +
      'in a fourth call site during the F2 sweep and fixed in the same branch (coordinator follow-up)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'private-registry-audit-trigger-columns-fixture-'))
      try {
        writeFileSync(
          join(dir, '20990101000000_create.sql'),
          'CREATE TABLE private_registry_skills (\n  id UUID,\n  team_id UUID\n);'
        )
        // The literal 'a;b' is what defeats a naive `sql.split(';')`: it splits this ONE statement
        // into two chunks, the first carrying the ALTER TABLE ... private_registry_skills prefix
        // and the "note" column, the second carrying "newcol" but not the table reference -- so
        // the naive version silently drops "newcol" from the set (measured, verified in node
        // before writing this fixture down).
        writeFileSync(
          join(dir, '20990101000001_alter.sql'),
          "ALTER TABLE private_registry_skills ADD COLUMN note TEXT DEFAULT 'a;b', ADD COLUMN newcol TEXT;"
        )
        const columns = columnsFromMigrations(dir)
        expect(columns.has('newcol')).toBe(true)
        expect(columns.has('note')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

/**
 * stripComments() escape-string case table (SMI-6114 retro round 4, gate finding on PR #2855).
 * Deliberately NOT gated by describe.skipIf(locked): stripComments() is a pure function of its
 * string argument and reads no migration file, so these regression cases must keep running even
 * when supabase/migrations/ is git-crypt-locked -- unlike the suite above, which needs the real
 * pinned migration content. Each case was executed against this exact implementation (node, outside
 * vitest) before being written down here, per the repo's "measure, don't reason" rule.
 */
describe('stripComments() escape-string handling (SMI-6114 retro round 4)', () => {
  it(
    "does not let a Postgres escape string's own /* hide a real statement after it -- the " +
      "reviewer's exact case (gate round 4)",
    () => {
      const sql =
        "SELECT E'prefix \\' /*';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;\n' +
        '/* ordinary comment */'
      const stripped = stripComments(sql)
      // The real ALTER TABLE, hidden by the pre-fix parser closing the E-string early at \', stays
      // visible to auditSinkViolations() ...
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
      // ... and the real trailing block comment is still genuinely stripped, not left behind by an
      // over-correction that stops treating anything named /* as a comment.
      expect(stripped).not.toMatch(/ordinary comment/)
    }
  )

  it(
    "correctly pairs a real backslash-escaped backslash (e'\\\\') inside an escape string with " +
      'the ODD backslash right after it, so the following quote stays escaped too, keeping a ' +
      'later real statement visible (SMI-6680 F8: the prior version of this fixture used an ' +
      'EVEN backslash count before the closing quote, which the plain-string rule and the ' +
      'escape-string rule both close at the identical index -- passing under either rule and so ' +
      'passing even with the escape-string branch disabled entirely. Proven decorative by ' +
      'mutation (SMI-6680 report); this version uses an ODD count so a `/*` exposed by the ' +
      'wrong (plain-string) closing point swallows the following ALTER TABLE into a runaway ' +
      'comment, while the correct escape-aware closing point keeps it visible.)',
    () => {
      const sql =
        "SELECT e'prefix \\\\\\' /*';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;\n' +
        '/* trailing comment, must still be stripped */'
      const stripped = stripComments(sql)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
      expect(stripped).not.toMatch(/trailing comment/)
    }
  )

  it(
    "allows doubled quotes inside an escape string (E'it''s'), which Postgres accepts " +
      'alongside backslash-escaping within the same literal',
    () => {
      // Doubling alone (no backslash in the string) is not a real differentiator here: if an
      // E-string closed too early because doubling were unimplemented, the leftover quote just
      // starts a NEW standard-quoted string, whose own (pre-existing, untouched) doubling support
      // resynchronizes to the same final boundary by coincidence -- a broken-doubling
      // implementation would pass this shape identically to a correct one, the exact decorative-
      // test trap CLAUDE.md's SMI-6598 rule warns about. Mixing a doubled pair with a
      // backslash-escaped quote in the SAME literal breaks that coincidence: verified in node that
      // a doubling-unaware E-string scanner mis-closes after "it", then (lacking backslash-escape
      // awareness in the fallback standard-string branch it lands in) also mis-closes the
      // remaining `'s \' fine'` right after the backslash, leaving a stray quote that starts an
      // unterminated string -- which leaves the real comment below un-stripped (still literal
      // "string" content) where the correct implementation strips it.
      const sql =
        "SELECT E'it''s \\' fine';\n" +
        '/* real comment, must be stripped */ ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/real comment/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )

  it(
    'only treats E/e as an escape-string opener when it is not the tail of a longer ' +
      'identifier, checked via the preceding character',
    () => {
      // `type` ends in 'e', but the character right before it ('p') is an identifier character,
      // so the quote after it is NOT an escape-string opener. This parses as plain text `type`
      // followed by an ordinary single-quoted string 'x' -- not valid SQL on its own (`type` isn't
      // a legal token there), but it proves the scanner doesn't misparse the quote boundary.
      const sanity = "SELECT type'x';"
      expect(stripComments(sanity)).toBe(sanity)

      // Differentiator: CASE also ends in 'E'. If the preceding-character guard were missing, the
      // backslash right before the first quote would be wrongly read as an escape-string escape,
      // swallowing the real comment that follows as literal (unstripped) string content instead of
      // genuinely stripping it -- proving the guard, not just documenting it.
      const sql =
        "SELECT CASE'\\' /* would stay hidden if wrongly treated as an escape string */' END;\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/would stay hidden/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )

  it(
    'agrees that a plain string ends at the quote right after a backslash -- under ' +
      'standard_conforming_strings=on the backslash is literal, not an escape',
    () => {
      const sql =
        "SELECT 'a\\' /* real comment -- only stripped if the string closed at the quote right " +
        "after the backslash */';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/only stripped if the string closed/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )
})
