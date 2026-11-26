/**
 * SMI-7260: the one warning `list` prints when one of its database opens
 * failed (`warnDatabaseUnopenable`, ADR-175 § 5).
 *
 * The scan opens the one database once per directory it scans, so the opens
 * can disagree. These pin the two shapes that disagreement produces:
 *
 * (a) some rows are Unknown because the open failed, and others because their
 *     lookup failed after a good open: the second reason must still be named;
 * (b) one open failed but every listed skill was checked: the warning must say
 *     so, not read as a contradiction of "All installed skills are up to date."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledSkill } from '../src/utils/skills-directory.js'
import { warnDatabaseUnopenable } from '../src/commands/manage.update-status.js'
import { getCliLogger } from '../src/cli-logger.js'

const OPEN_REASON = 'the local database at ~/.skillsmith/skills.db could not be read'
const LOOKUP_REASON = 'the local database at ~/.skillsmith/skills.db could not be queried'
const ERROR = new Error('[Skillsmith] Could not read ~/.skillsmith/skills.db consistently.')

function row(name: string, updateStatus: InstalledSkill['updateStatus'], reason?: string) {
  return { name, updateStatus, updateStatusReason: reason } as unknown as InstalledSkill
}

let warned: string[]

beforeEach(() => {
  warned = []
  vi.spyOn(getCliLogger(), 'warn').mockImplementation(((...a: unknown[]) => {
    warned.push(a.map(String).join(' '))
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SMI-7260: warnDatabaseUnopenable', () => {
  it('(a) names a lookup failure among the Unknown rows that the open failure does not explain', () => {
    const undetermined = [row('a', 'unknown', OPEN_REASON), row('b', 'unknown', LOOKUP_REASON)]

    warnDatabaseUnopenable(ERROR, new Set([OPEN_REASON]), undetermined, 3)

    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('2 of 3')
    expect(warned[0]).toContain('could not be opened')
    expect(warned[0]).toContain(LOOKUP_REASON)
    // The open's own reason is not repeated: the error below already states it.
    expect(warned[0]).not.toContain(OPEN_REASON)
    expect(warned[0]).toContain(ERROR.message)
  })

  it('(a) adds no extra reason when the open failure explains every Unknown row (the control)', () => {
    warnDatabaseUnopenable(ERROR, new Set([OPEN_REASON]), [row('a', 'unknown', OPEN_REASON)], 1)

    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain('also:')
  })

  it('(b) says every listed skill was still checked when none is Unknown', () => {
    warnDatabaseUnopenable(ERROR, new Set([OPEN_REASON]), [], 2)

    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain("every listed skill's update status was still checked")
    expect(warned[0]).not.toContain('Shown as "Unknown"')
    expect(warned[0]).toContain(ERROR.message)
  })

  it('with no skills installed it says no update status could be checked (the control)', () => {
    warnDatabaseUnopenable(ERROR, new Set([OPEN_REASON]), [], 0)

    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('no update status could be checked')
    expect(warned[0]).not.toContain('still checked')
  })
})
