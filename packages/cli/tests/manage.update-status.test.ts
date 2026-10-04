/**
 * `unknown` must never be rendered as "Up to date" (ADR-175 § 5, SMI-6946).
 *
 * This is the regression test for the live defect: a corrupt `skills.db` made
 * `skillsmith manage` / `list` report every installed skill as current, with
 * exit code 0 and no diagnostic. The mechanism was a `boolean` — the renderer
 * mapped `false` to "Up to date", and a database fault produced `false`.
 *
 * The assertions below are therefore about **what the user sees**, not about
 * what the driver threw. Asserting only that an error was raised is exactly the
 * assertion that passes while a caller swallows it, which is how this shipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { displaySkillsTable } from '../src/commands/manage.action.js'
import type { InstalledSkill } from '../src/utils/skills-directory.js'

function skill(name: string, overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    name,
    path: `/skills/${name}`,
    version: '1.0.0',
    trustTier: 'verified',
    installDate: '2026-01-01',
    updateStatus: 'current',
    installedVia: 'claude-code',
    scope: 'global',
    untracked: false,
    ...overrides,
  }
}

describe('displaySkillsTable — update-status rendering', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function render(skills: InstalledSkill[]): string {
    displaySkillsTable(skills)
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
  }

  it('renders an unknown status as "Unknown", not "Up to date"', () => {
    const out = render([
      skill('corrupt-db-skill', {
        updateStatus: 'unknown',
        updateStatusReason: 'the local database at /tmp/skills.db is corrupt',
      }),
    ])

    expect(out).toContain('Unknown')
    // The load-bearing assertion. Before this change the same input rendered
    // "Up to date" — a positive false statement about data we could not read.
    expect(out).not.toContain('Up to date')
  })

  it('still renders a checked-and-current skill as "Up to date"', () => {
    // The paired PRESENCE assertion for the absence above. Without it, a
    // renderer that printed "Unknown" for everything — or printed nothing at
    // all — would satisfy the previous test.
    const out = render([skill('current-skill', { updateStatus: 'current' })])
    expect(out).toContain('Up to date')
    expect(out).not.toContain('Unknown')
  })

  it('still renders an available update as "Available"', () => {
    const out = render([skill('stale-skill', { updateStatus: 'available' })])
    expect(out).toContain('Available')
    expect(out).not.toContain('Up to date')
  })

  it('renders all three states distinctly in one table', () => {
    // Guards against a renderer that collapses two states onto one label: with
    // all three present, every label must appear.
    const out = render([
      skill('a', { updateStatus: 'available' }),
      skill('b', { updateStatus: 'current' }),
      skill('c', { updateStatus: 'unknown', updateStatusReason: 'locked' }),
    ])
    expect(out).toContain('Available')
    expect(out).toContain('Up to date')
    expect(out).toContain('Unknown')
  })
})
