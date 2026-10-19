/**
 * SMI-7142 (plan change 1e): the pg_cron resume job and the workflow's GitHub `schedule` fallback must
 * run on the SAME cron line. Two places state it -- the migration's `cron.schedule(...)` literal and
 * `on.schedule[0].cron` in .github/workflows/indexer-backfill-autochain.yml -- and
 * backfill-busy-window.test.ts proves the YAML line places two ticks inside every open window, so the
 * migration must not drift from it.
 *
 * THIS TEST FAILS, IT NEVER SKIPS, WHEN THE MIGRATION IS GIT-CRYPT CIPHERTEXT. A skip would turn a
 * locked checkout into a green run that compared nothing (SMI-5984 shape, and the a0d784a60 lesson: a
 * check that does not need a precondition must not inherit another check's skip). This deliberately
 * does NOT use readMigrationText(): that returns null, and a suite built on it skips, when
 * SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED=1. Here that variable changes nothing. The unlock is a CI
 * prerequisite of this check, not a condition under which it is allowed to be absent.
 *
 * Every predicate is paired with a known-negative run through the same code path.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { stripComments } from '../lib/sql-statement-guards.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MIGRATION = join(
  ROOT,
  'supabase',
  'migrations',
  '20261017000000_backfill_autochain_resume_pg_cron.sql'
)
const WORKFLOW = join(ROOT, '.github', 'workflows', 'indexer-backfill-autochain.yml')
const JOB = 'backfill-autochain-resume'
const COMMAND = 'SELECT public.invoke_backfill_autochain_resume()'
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

/** The migration's text. THROWS on a missing file or on ciphertext, whatever the environment says. */
function migrationSql(bytes: Buffer, path: string): string {
  if (bytes.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    throw new Error(
      `${path} is git-crypt-encrypted (encrypted): the cron parity check cannot compare ciphertext. ` +
        'Unlock the repository before running this suite; this check never skips.'
    )
  }
  return bytes.toString('utf8')
}

function loadMigration(): string {
  expect(existsSync(MIGRATION), `migration missing: ${MIGRATION}`).toBe(true)
  return migrationSql(readFileSync(MIGRATION), MIGRATION)
}

/** The `schedule` entries of the shipped workflow. */
function workflowCrons(): string[] {
  const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as {
    on?: { schedule?: Array<{ cron?: unknown }> }
  }
  const schedule = doc.on?.schedule
  expect(Array.isArray(schedule), 'the workflow has no on.schedule').toBe(true)
  return schedule!.map((s) => {
    expect(typeof s.cron, 'a schedule entry has no cron string').toBe('string')
    return s.cron as string
  })
}

/** Every `cron.schedule('<job>', '<literal>', ...)` for `job`, comments removed first. */
function scheduledLiterals(sql: string, job: string): string[] {
  const re = new RegExp(
    `cron\\.schedule\\(\\s*'${job}'\\s*,\\s*'([^']*)'\\s*,\\s*\\$\\$([^$]*)\\$\\$`,
    'g'
  )
  return [...stripComments(sql).matchAll(re)].map((m) => `${m[1]}\t${m[2]}`)
}

/** Every daily single-quoted cron literal in the SQL (the schedule and the smoke's comparison). */
function dailyCronLiterals(sql: string): string[] {
  return [...stripComments(sql).matchAll(/'([0-9,]+ [0-9,]+ \* \* \*)'/g)].map((m) => m[1])
}

describe('SMI-7142 -- the pg_cron resume schedule equals the workflow schedule', () => {
  it('the migration schedules the resume job on exactly the workflow cron line', () => {
    const crons = workflowCrons()
    expect(
      crons,
      'exactly one workflow schedule entry, so "the" cron line is unambiguous'
    ).toHaveLength(1)
    const found = scheduledLiterals(loadMigration(), JOB)
    expect(found, `exactly one cron.schedule for ${JOB}`).toHaveLength(1)
    const [literal, command] = found[0].split('\t')
    expect(literal, `migration cron ${literal} !== workflow cron ${crons[0]}`).toBe(crons[0])
    expect(command).toBe(COMMAND)
  })

  it("every daily cron literal in the migration, including the smoke block's, is the workflow line", () => {
    const [cron] = workflowCrons()
    const literals = dailyCronLiterals(loadMigration())
    // non-vacuity: the schedule call and the smoke comparison are both daily literals
    expect(literals.length).toBeGreaterThanOrEqual(2)
    expect(literals.filter((l) => l !== cron)).toEqual([])
  })

  it('known-negative: an edited minute list or hour list is detected, and so is a dropped job', () => {
    const [cron] = workflowCrons()
    const sql = loadMigration()
    // Anchored on the call: the header comment quotes the same literal and would take a bare replace.
    const call = /(cron\.schedule\(\s*'backfill-autochain-resume',\s*')([^']*)(')/
    const editedMinutes = sql.replace(
      call,
      (_m, a: string, lit: string, c: string) => a + lit.replace('3,23,43', '3,23,44') + c
    )
    expect(editedMinutes).not.toBe(sql)
    expect(scheduledLiterals(editedMinutes, JOB)[0].split('\t')[0]).not.toBe(cron)
    const editedHours = sql.replace(
      call,
      (_m, a: string, lit: string, c: string) => a + lit.replace('21,22', '21,23') + c
    )
    expect(editedHours).not.toBe(sql)
    expect(scheduledLiterals(editedHours, JOB)[0].split('\t')[0]).not.toBe(cron)
    // the smoke literal drifting alone is caught by the all-literals predicate
    const smokeOnly = sql.replace("IS DISTINCT FROM '3,23,43 ", "IS DISTINCT FROM '3,23,44 ")
    expect(smokeOnly).not.toBe(sql)
    expect(dailyCronLiterals(smokeOnly).filter((l) => l !== cron)).not.toEqual([])
    // a renamed job leaves no literal for the real one
    expect(scheduledLiterals(sql.replaceAll(`'${JOB}'`, "'other-job'"), JOB)).toEqual([])
    // a commented-out schedule is not a schedule
    expect(scheduledLiterals(`-- cron.schedule('${JOB}', '1 1 * * *', $$x$$)`, JOB)).toEqual([])
  })

  it('an encrypted migration FAILS the check (it does not skip), even when a lock is declared expected', () => {
    const ciphertext = Buffer.concat([GIT_CRYPT_MAGIC, Buffer.from('....binary....')])
    const previous = process.env.SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED
    try {
      for (const declared of [undefined, '1']) {
        if (declared === undefined) delete process.env.SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED
        else process.env.SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED = declared
        expect(
          () => migrationSql(ciphertext, MIGRATION),
          `declared-locked=${declared ?? 'unset'}`
        ).toThrow(/encrypted/)
      }
    } finally {
      if (previous === undefined) delete process.env.SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED
      else process.env.SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED = previous
    }
    // known-positive control: plaintext passes through untouched
    expect(migrationSql(Buffer.from('-- plain'), MIGRATION)).toBe('-- plain')
  })
})
