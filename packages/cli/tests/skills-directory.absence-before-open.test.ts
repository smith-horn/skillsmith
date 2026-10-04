/**
 * Absence is established BEFORE the open (ADR-175 § 5, SMI-6946).
 *
 * Why this file exists. The CLI CHANGELOG claims *"absence is now established
 * before the open, where no driver's behaviour can mask it"* and nothing tested
 * it. The cross-family gate on PR #2992 found that dropping the
 * `&& existsSync(dbPath)` conjunct changes **nothing** on the native driver —
 * an absent path throws `SQLITE_CANTOPEN`, `classifyOpenFailure` re-stats, and
 * the status is still `current`. It changes behaviour only on the WASM driver,
 * which **succeeds** on a missing path and hands back an empty in-memory
 * database, so the absence resurfaces as a per-skill query failure and renders
 * `unknown` for every skill. That is the governance finding this gate was
 * added for, and it was reachable on any `npx` install without a native build.
 *
 * This asserts the **mechanism, not the outcome**, which is the whole point: a
 * test that only checked the resulting status would pass on the native driver
 * with the gate deleted, and the CLI suite has no WASM-driver arm to catch it.
 * Asserting that the open is never ATTEMPTED for an absent path holds for every
 * driver, present and future, because it does not depend on what any driver
 * does with a missing file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const openCliDatabase = vi.fn()

vi.mock('../src/utils/open-database.js', () => ({
  openCliDatabase: (...args: unknown[]) => openCliDatabase(...args),
}))

import { getSkillsFromDirectory } from '../src/utils/skills-directory.js'

let dir: string
let skillsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi6946-absence-'))
  skillsDir = join(dir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  openCliDatabase.mockReset()
  // Returning a usable-enough handle for the present-path arm. The repository
  // construction is irrelevant here — only whether the open was attempted.
  openCliDatabase.mockResolvedValue({ close: vi.fn(), prepare: vi.fn(), exec: vi.fn() })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the open is gated on the database existing', () => {
  it('never attempts an open for a path that does not exist', async () => {
    const absent = join(dir, 'definitely-absent', 'skills.db')

    await getSkillsFromDirectory(skillsDir, absent)

    // Delete the `existsSync` conjunct and this goes red. Nothing else in
    // either package does — the native driver's SQLITE_CANTOPEN is re-stated
    // into the same `current` outcome, so an outcome assertion is blind here.
    expect(openCliDatabase).not.toHaveBeenCalled()
  })

  it('does attempt an open for a path that exists — the paired presence arm', async () => {
    // Without this, a gate that NEVER opened would satisfy the arm above, and
    // that function is its own defect: no skill would ever report an update.
    const present = join(dir, 'skills.db')
    writeFileSync(present, 'not a real database, but it exists')

    await getSkillsFromDirectory(skillsDir, present)

    expect(openCliDatabase).toHaveBeenCalledTimes(1)
    expect(openCliDatabase).toHaveBeenCalledWith(present, { readonly: true })
  })

  it('never attempts an open when no path was supplied at all', async () => {
    await getSkillsFromDirectory(skillsDir)

    expect(openCliDatabase).not.toHaveBeenCalled()
  })
})
