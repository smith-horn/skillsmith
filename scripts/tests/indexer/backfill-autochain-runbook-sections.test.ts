/**
 * SMI-7121 (retro of PR #3103, finding 4): every runbook section the stale-marker watcher's
 * alert message names must exist as a heading in the handover runbook, so the alert text cannot
 * drift from the runbook silently. The section names are READ from the migration (each
 * `v_section := '...'` assignment), never copied here.
 *
 * docs/internal is a private submodule that CI does not check out, so this test SKIPS, with a
 * printed reason, when the runbook is absent (and likewise when the migration is still
 * git-crypt-encrypted). It constrains local runs and any checkout with the submodule.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MIGRATION = join(
  ROOT,
  'supabase',
  'migrations',
  '20261016000000_backfill_autochain_markers.sql'
)
const RUNBOOK = join(ROOT, 'docs', 'internal', 'runbooks', 'backfill-autochain-handover.md')

const migrationBytes = existsSync(MIGRATION) ? readFileSync(MIGRATION) : null
const migrationEncrypted =
  migrationBytes !== null && migrationBytes.subarray(0, 9).toString('latin1') === '\0GITCRYPT'
const runbookPresent = existsSync(RUNBOOK)

const skipReason = !runbookPresent
  ? `runbook ${RUNBOOK} is absent (docs/internal submodule not checked out, as in CI)`
  : migrationEncrypted
    ? `migration ${MIGRATION} is git-crypt-encrypted`
    : ''
if (skipReason) console.warn(`[backfill-autochain-runbook-sections] SKIPPED: ${skipReason}`)

/** Every literal the watcher assigns to v_section. */
function sectionNames(sql: string): string[] {
  return [...sql.matchAll(/v_section\s*:=\s*'((?:[^']|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'")
  )
}

/** Markdown heading texts, with any leading section number ("8.4 ") removed. */
function headings(md: string): string[] {
  return md
    .split('\n')
    .map((l) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)?.[1])
    .filter((h): h is string => h !== undefined)
    .map((h) => h.replace(/^\d+(\.\d+)*\.?\s+/, ''))
}

describe('watcher runbook sections exist', () => {
  it('the extractors work on known-positive and known-negative text', () => {
    expect(sectionNames("v_section := 'A b';\n  v_section := 'It''s c';")).toEqual([
      'A b',
      "It's c",
    ])
    expect(sectionNames("v_runbook := 'x';")).toEqual([])
    expect(
      headings('## 8. Halts\n### 8.4 A deferred chain did not resume\ntext A deferred chain')
    ).toEqual(['Halts', 'A deferred chain did not resume'])
  })

  it.skipIf(skipReason !== '')(
    'each section the migration names is a heading in backfill-autochain-handover.md',
    () => {
      expect(migrationBytes, `migration missing: ${MIGRATION}`).not.toBeNull()
      const names = sectionNames(migrationBytes!.toString('utf8'))
      // positive control: the two sections the plan requires before Wave 2b merges
      expect(names).toEqual(
        expect.arrayContaining([
          'A deferred chain did not resume',
          'Resume after a failed resume dispatch',
        ])
      )
      const have = new Set(headings(readFileSync(RUNBOOK, 'utf8')))
      const missing = names.filter((n) => !have.has(n))
      expect(
        missing,
        `sections named by the watcher but absent from the runbook: ${missing.join(' | ')}`
      ).toEqual([])
    }
  )
})
