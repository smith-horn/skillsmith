/**
 * Fixture-driven exercise of the five later-migration detectors in
 * `private-registry-audit-trigger.detectors.ts`, plus `unprefixedMigrationFiles()`
 * (SMI-6680 F1/F6). Split out of the original `private-registry-audit-trigger.static.test.ts`
 * (SMI-6680 governance retro, PR #2860 gate) so every test file here stays a reasonable size;
 * see `private-registry-audit-trigger.pins.test.ts`'s module doc comment for the full MODEL and
 * DOES-NOT-DETECT list this suite is one tier of.
 *
 * Deliberately NOT gated by describe.skipIf(locked): every detector accepts an optional `dir`,
 * and every fixture here points it at a `mkdtempSync()` directory rather than the real
 * (git-crypt-scoped) one, so these run even when supabase/migrations/ is locked. Each detector was
 * revert-checked (SMI-6598): neuter it (`return []` at its head), confirm the matching fixture
 * below fails, restore, confirm it passes again -- see the SMI-6680 report for the pass/fail
 * counts.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  auditSinkViolations,
  disableTriggerViolations,
  grantExecuteViolations,
  laterTriggerViolations,
  triggerOrFunctionTamperViolations,
} from './private-registry-audit-trigger.detectors.ts'
import { unprefixedMigrationFiles } from './private-registry-audit-trigger.migrations.ts'

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
    // PR #2860 gate finding 5: the trg_prs_audit_truncate branch's own message ("DROP TRIGGER
    // trg_prs_audit_truncate.") contains "DROP TRIGGER trg_prs_audit" as a prefix, so that bare
    // substring can't tell this branch's message apart from the truncate branch's. The trailing
    // period below can: it's emitted right after the bare name in this branch's message, but the
    // truncate branch's message has "_truncate." there instead, so it can never contain this exact
    // substring (verified against detectors.ts's actual message text).
    [
      'DROP TRIGGER trg_prs_audit',
      'DROP TRIGGER IF EXISTS public.trg_prs_audit;',
      'DROP TRIGGER trg_prs_audit.',
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
    // Same reasoning as the DROP TRIGGER row above (PR #2860 gate finding 5).
    [
      'ALTER TRIGGER trg_prs_audit',
      'ALTER TRIGGER trg_prs_audit ON private_registry_skills RENAME TO x_old;',
      'ALTER TRIGGER trg_prs_audit.',
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
      'CREATE RULE targeting audit_logs --',
    ],
    [
      'CREATE TRIGGER on audit_logs',
      'CREATE TRIGGER trg_fake AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION noop();',
      'CREATE TRIGGER on audit_logs --',
    ],
    // PR #2860 gate finding 4 (round 1) + finding 2 (round 2, SMI-6680): every expectedSubstring
    // in this table used to be a plain label ('RENAME', 'DISABLE TRIGGER', 'DROP COLUMN', 'SET NOT
    // NULL', 'DROP TABLE audit_logs', and -- missed in round 1, caught in round 2 -- 'CREATE RULE
    // targeting audit_logs', 'CREATE TRIGGER on audit_logs', 'ALTER COLUMN ... TYPE',
    // 'ADD CONSTRAINT/CHECK') that also appear verbatim inside each row's own `stmt` -- since every
    // offender message embeds `trimmed()` (the echoed statement text), a
    // `toContain(expectedSubstring)` assertion using one of those labels can pass on the echo alone
    // and pin nothing about the branch's own message wording. Round 1 fixed five rows; round 2
    // (measured via the reviewer's own mutation recipe -- relabel a branch, confirm the affected
    // row's test still passes) found the 'ALTER COLUMN ... TYPE' and 'ADD CONSTRAINT/CHECK' rows
    // are not actually defeatable this way today (their placeholders `...`/`/` never occur in real
    // SQL), and 'CREATE RULE'/'CREATE TRIGGER on audit_logs' likewise (their prose wording doesn't
    // occur verbatim in the DDL either) -- but all four are still switched to the same
    // label-plus-`--`-separator form for consistency with the five already-hardened rows, since the
    // echoed statement (comment-stripped, so it never contains a literal `--`) can never satisfy
    // any of them regardless of what future SQL shapes these fixtures grow into.
    ['DROP TABLE audit_logs', 'DROP TABLE audit_logs;', 'DROP TABLE audit_logs --'],
    [
      'ALTER TABLE audit_logs ... RENAME',
      'ALTER TABLE audit_logs RENAME TO audit_logs_old;',
      'ALTER TABLE audit_logs ... RENAME --',
    ],
    [
      'ALTER TABLE audit_logs ... DISABLE TRIGGER',
      'ALTER TABLE audit_logs DISABLE TRIGGER ALL;',
      '... DISABLE TRIGGER --',
    ],
    [
      'ALTER TABLE audit_logs ... DROP COLUMN, with a semicolon-bearing literal earlier in the ' +
        'statement (SMI-6680 F2 measured repro)',
      "ALTER TABLE public.audit_logs ADD COLUMN note TEXT DEFAULT 'a;b', DROP COLUMN metadata;",
      '... DROP COLUMN --',
    ],
    [
      'ALTER TABLE audit_logs ... ALTER COLUMN ... TYPE',
      'ALTER TABLE audit_logs ALTER COLUMN metadata TYPE TEXT;',
      'ALTER COLUMN ... TYPE --',
    ],
    [
      'ALTER TABLE audit_logs ... SET NOT NULL',
      'ALTER TABLE audit_logs ALTER COLUMN metadata SET NOT NULL;',
      '... SET NOT NULL --',
    ],
    [
      'ALTER TABLE audit_logs ... ADD CONSTRAINT/CHECK',
      'ALTER TABLE audit_logs ADD CONSTRAINT chk_x CHECK (true);',
      'ADD CONSTRAINT/CHECK --',
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
      // PR #2860 gate finding 2: this was a bare `toContain('DROP COLUMN')` -- since this
      // fixture's own SQL literally contains "DROP COLUMN" (real DDL syntax), that assertion is
      // satisfied by the echoed statement text alone and is defeated by relabeling this branch
      // "... ALTER COLUMN ... TYPE --" (verified: the test stayed green under that swap). The
      // label-plus-`--`-separator form matches the five sibling rows in the `it.each` table below
      // and cannot be satisfied by the echo, which never contains a literal `--` (comments are
      // stripped before this detector runs).
      expect(offenders[0]).toContain('... DROP COLUMN --')
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
