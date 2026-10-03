/**
 * `skillsmith list` reporting for undeterminable update state (ADR-175 § 5).
 *
 * Why this file exists. The cross-family pre-merge gate on PR #2992 named a
 * mutation that survived the whole suite: move `warnUndetermined` one line
 * later, past the `--outdated` early return. A `--outdated` run against a
 * wholly unreadable database then prints **nothing at all** and exits 0 —
 * because the green "All installed skills are up to date." is gated on
 * `undetermined.length === 0` and the yellow partial line on
 * `undetermined.length < skills.length`, so with the warning unreachable both
 * are correctly suppressed and nothing replaces them.
 *
 * That is SMI-6946's original defect reproduced by relocating one line: silent,
 * exit 0, no diagnostic. Nothing observed this region — `warnUndetermined`
 * appeared in zero test files, so no mutation to it could be caught.
 *
 * **Relocation is the class the author's own mutation inventory did not
 * contain**, which is why a reviewer who did not write the code found it. The
 * assertions here are therefore about ORDER and REACHABILITY, not only content:
 * each case pins that the warning is reached on the path it covers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { InstalledSkill } from '../src/utils/skills-directory.js'

const getInstalledSkills = vi.fn<() => Promise<InstalledSkill[]>>()

vi.mock('../src/utils/skills-directory.js', () => ({
  getInstalledSkills: (...args: unknown[]) =>
    (getInstalledSkills as unknown as (...a: unknown[]) => Promise<InstalledSkill[]>)(...args),
  getInstalledSkillsForClient: vi.fn(async () => []),
  getLocalSkillsDirDisplay: vi.fn(() => './.claude/skills'),
}))

import { listAction } from '../src/commands/manage.action.js'
import { getCliLogger } from '../src/cli-logger.js'

function skill(name: string, updateStatus: InstalledSkill['updateStatus'], reason?: string) {
  return {
    name,
    path: `/tmp/skills/${name}`,
    version: '1.0.0',
    trustTier: 'community',
    installDate: '2026-10-03',
    updateStatus,
    updateStatusReason: reason,
    installedVia: 'claude-code',
    scope: 'global',
    untracked: false,
  } as unknown as InstalledSkill
}

const CORRUPT = 'the local database at ~/.skillsmith/skills.db is corrupt'

let logged: string[]
let warned: string[]

beforeEach(() => {
  logged = []
  warned = []
  getInstalledSkills.mockReset()
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(' '))
  })
  // The logger is a memoized singleton, so replacing the method on the
  // instance is seen by `manage.update-status.ts`, which captured the same
  // object at module load.
  vi.spyOn(getCliLogger(), 'warn').mockImplementation(((...a: unknown[]) => {
    warned.push(a.map(String).join(' '))
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const all = () => logged.join('\n')

describe('--outdated when nothing could be determined', () => {
  it('warns rather than printing nothing — the relocation mutation', async () => {
    getInstalledSkills.mockResolvedValue([
      skill('alpha', 'unknown', CORRUPT),
      skill('beta', 'unknown', CORRUPT),
    ])

    await listAction({ outdated: true })

    // The load-bearing assertion. Move the warning past the `return` and this
    // is the only thing that goes red: the two console lines are legitimately
    // suppressed in this state, so output falls to empty and exit stays 0.
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(CORRUPT)
    expect(warned[0]).toMatch(/No skill's update status could be determined/)
  })

  it('does not claim every skill is up to date', async () => {
    getInstalledSkills.mockResolvedValue([skill('alpha', 'unknown', CORRUPT)])

    await listAction({ outdated: true })

    // Kills the wrong-scope mutation: source `undetermined` from `filtered`
    // instead of `skills` and it is always empty under `--outdated` (which
    // keeps only 'available'), so this green line prints on a fully corrupt
    // database — ADR-175 § 5's second false statement, restored.
    expect(all()).not.toContain('All installed skills are up to date')
    // And the partial line must not appear either: it would only restate the
    // warning when nothing at all was checked.
    expect(all()).not.toContain('No updates found among the skills that could be checked')
  })
})

describe('--outdated when some could be determined', () => {
  it('reports what was established and warns about the rest', async () => {
    getInstalledSkills.mockResolvedValue([
      skill('alpha', 'current'),
      skill('beta', 'unknown', CORRUPT),
    ])

    await listAction({ outdated: true })

    expect(all()).toContain('No updates found among the skills that could be checked')
    expect(all()).not.toContain('All installed skills are up to date')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/1 of 2 skills' update status could not be determined/)
  })

  it('still warns when the table renders instead of the empty-set branch', async () => {
    // The SECOND `warnUndetermined` call site, after `displaySkillsTable`.
    // Relocating that one is a separate mutation from the first, and without
    // this case it survives.
    getInstalledSkills.mockResolvedValue([
      skill('alpha', 'available'),
      skill('beta', 'unknown', CORRUPT),
    ])

    await listAction({ outdated: true })

    expect(all()).toContain('Installed Skills')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(CORRUPT)
  })
})

describe('the paired presence/absence control', () => {
  // Without this, an implementation that warned unconditionally would satisfy
  // every assertion above. Silence is correct here and nowhere else.
  it('says nothing when every skill was actually checked', async () => {
    getInstalledSkills.mockResolvedValue([skill('alpha', 'current'), skill('beta', 'current')])

    await listAction({ outdated: true })

    expect(warned).toHaveLength(0)
    expect(all()).toContain('All installed skills are up to date')
  })

  it('warns on the plain list path too, not only under --outdated', async () => {
    getInstalledSkills.mockResolvedValue([
      skill('alpha', 'current'),
      skill('beta', 'unknown', CORRUPT),
    ])

    await listAction({})

    expect(all()).toContain('Installed Skills')
    // Rendered as "Unknown", never "Up to date" — the table's own half of § 5.
    expect(all()).toContain('Unknown')
    expect(warned).toHaveLength(1)
  })
})
