/**
 * SMI-7121 (retro of PR #3103, finding 4): every runbook section the stale-marker watcher's
 * alert message names must exist as a heading in the handover runbook, so the alert text cannot
 * drift from the runbook silently. The section names are READ from the migration (each
 * `v_section := '...'` assignment), never copied here. The same holds for every section the
 * autochain workflow's alert messages cite (`section "Name"` and `section 8.x`), read from
 * .github/workflows/indexer-backfill-autochain.yml.
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
const WORKFLOW = join(ROOT, '.github', 'workflows', 'indexer-backfill-autochain.yml')
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

// The workflow check needs only the runbook: an encrypted migration is irrelevant to it, and the
// workflow is tracked in this repo, so its absence is a failure (asserted below), never a skip.
const workflowSkipReason = runbookPresent
  ? ''
  : `runbook ${RUNBOOK} is absent (docs/internal submodule not checked out, as in CI)`

/** Every literal the watcher assigns to v_section. */
function sectionNames(sql: string): string[] {
  return [...sql.matchAll(/v_section\s*:=\s*'((?:[^']|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'")
  )
}

/** Quoted section names the workflow cites: `section "Name"` or `section \\"Name\\"` (jq-escaped). */
function workflowQuotedSections(yml: string): string[] {
  return [...yml.matchAll(/section\s+\\?"([^"\\]+)\\?"/g)].map((m) => m[1])
}

/** Numbered references the workflow cites: `section 8.1`. */
function workflowNumberedSections(yml: string): string[] {
  return [...yml.matchAll(/section\s+(\d+(?:\.\d+)*[a-z]?)(?![\w.]*\w)/g)].map((m) => m[1])
}

/** Heading numbers ("8.1", "8.1a") exactly as written in the runbook. */
function headingNumbers(md: string): string[] {
  return md
    .split('\n')
    .map((l) => /^#{1,6}\s+(\d+(?:\.\d+)*[a-z]?)\.?\s/.exec(l)?.[1])
    .filter((h): h is string => h !== undefined)
}

/** Names/numbers from `wanted` that `have` does not contain. */
function missingFrom(wanted: string[], have: string[]): string[] {
  const set = new Set(have)
  return wanted.filter((w) => !set.has(w))
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

  it('the workflow extractors work, and the matcher reports a missing section', () => {
    const yml = 'MSG="x, section \\"Alpha one\\"." and section 8.1 (ack) and section "Beta"'
    expect(workflowQuotedSections(yml)).toEqual(['Alpha one', 'Beta'])
    expect(workflowNumberedSections(yml)).toEqual(['8.1'])
    expect(workflowNumberedSections('see section "Beta".')).toEqual([])
    const synthetic = '## 8. Halts\n### 8.1 Alpha one\n### 8.1a Other\n'
    expect(headingNumbers(synthetic)).toEqual(['8', '8.1', '8.1a'])
    // known-positive: present names are not reported
    expect(missingFrom(['Alpha one'], headings(synthetic))).toEqual([])
    expect(missingFrom(['8.1'], headingNumbers(synthetic))).toEqual([])
    // known-negative: absent names and numbers ARE reported, so the check cannot pass vacuously
    expect(missingFrom(['Alpha one renamed'], headings(synthetic))).toEqual(['Alpha one renamed'])
    expect(missingFrom(['8.9'], headingNumbers(synthetic))).toEqual(['8.9'])
    // a renamed cited heading in a synthetic runbook is detected
    const renamed = synthetic.replace('Alpha one', 'Alpha 1')
    expect(missingFrom(['Alpha one'], headings(renamed))).toEqual(['Alpha one'])
  })

  it.skipIf(workflowSkipReason !== '')(
    'each section the autochain workflow cites exists in backfill-autochain-handover.md',
    () => {
      expect(existsSync(WORKFLOW), `workflow ${WORKFLOW} is missing`).toBe(true)
      const yml = readFileSync(WORKFLOW, 'utf8')
      const quoted = workflowQuotedSections(yml)
      const numbered = workflowNumberedSections(yml)
      // non-vacuity: the workflow is known to cite both kinds
      expect(quoted.length, 'no quoted section names extracted from the workflow').toBeGreaterThan(
        0
      )
      expect(numbered.length, 'no numbered sections extracted from the workflow').toBeGreaterThan(0)
      const md = readFileSync(RUNBOOK, 'utf8')
      const missingNames = missingFrom(quoted, headings(md))
      const missingNumbers = missingFrom(numbered, headingNumbers(md))
      expect(
        [...missingNames, ...missingNumbers],
        `sections cited by the workflow but absent from the runbook`
      ).toEqual([])
    }
  )

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
