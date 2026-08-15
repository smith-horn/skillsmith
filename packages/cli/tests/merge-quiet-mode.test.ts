/**
 * SMI-5893 (Wave 7 Step 4): `skillsmith merge`'s `isQuietModeEnabled()` fallback.
 *
 * The CLI's new root-level --quiet (packages/cli/src/index.ts) claims the
 * LONG-form `--quiet` token ahead of this command's own local
 * `-q, --quiet` whenever both are registered on the same composed program,
 * leaving `options.quiet` at its commander-declared default (`false`, not
 * `undefined` — this command's flag has an explicit default, unlike
 * install.ts/registry-install.action.ts) even though the user asked for
 * quiet output. `options.quiet || isQuietModeEnabled()` is the fallback
 * that keeps this command quiet in that case, via the SKILLSMITH_QUIET env
 * var root's preAction hook sets. This suite isolates that fallback
 * directly (no --quiet/-q flag passed at all) rather than reproducing the
 * full root-collision, since createMergeCommand() runs standalone here,
 * outside the composed root program. No prior test file existed for
 * merge.ts — this is a minimal, focused suite scoped to the fallback this
 * wave introduces, not full command coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  checkSchemaCompatibility: vi.fn(() => ({ isCompatible: true, action: 'none', message: '' })),
  mergeSkillDatabases: vi.fn(() => ({
    skillsAdded: 1,
    skillsUpdated: 0,
    skillsSkipped: 0,
    conflicts: [],
    duration: 5,
  })),
  dbClose: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}))

vi.mock('@skillsmith/core/telemetry', () => ({
  withTelemetry: <TArgs extends readonly unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn> | TReturn
  ) => fn,
}))

vi.mock('@skillsmith/core', () => ({
  openDatabase: (...args: unknown[]) => {
    mocks.openDatabase(...args)
    return { close: mocks.dbClose }
  },
  checkSchemaCompatibility: () => mocks.checkSchemaCompatibility(),
  mergeSkillDatabases: () => mocks.mergeSkillDatabases(),
  // SMI-5893: real check against process.env so the `options.quiet ||
  // isQuietModeEnabled()` fallback is exercised faithfully.
  isQuietModeEnabled: () =>
    process.env['SKILLSMITH_QUIET']?.toLowerCase() === 'true' ||
    process.env['SKILLSMITH_QUIET'] === '1',
}))

const originalConsoleLog = console.log
const mockConsoleLog = vi.fn()

describe('SMI-5893 (Wave 7 Step 4): merge — isQuietModeEnabled() fallback', () => {
  const ORIGINAL_SKILLSMITH_QUIET = process.env['SKILLSMITH_QUIET']

  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
  })

  afterEach(() => {
    console.log = originalConsoleLog
    if (ORIGINAL_SKILLSMITH_QUIET === undefined) {
      delete process.env['SKILLSMITH_QUIET']
    } else {
      process.env['SKILLSMITH_QUIET'] = ORIGINAL_SKILLSMITH_QUIET
    }
  })

  it('suppresses the merge banner/results via SKILLSMITH_QUIET even without --quiet/-q', async () => {
    process.env['SKILLSMITH_QUIET'] = 'true'

    const { createMergeCommand } = await import('../src/commands/merge.js')
    const cmd = createMergeCommand()

    await cmd.parseAsync(['node', 'test', '/tmp/source.db', '/tmp/target.db'])

    const allOutput = mockConsoleLog.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(allOutput).not.toContain('Skillsmith Database Merge')
    expect(allOutput).not.toContain('Merging databases')
  })

  it('shows the merge banner when SKILLSMITH_QUIET is unset and no local quiet flag is passed', async () => {
    delete process.env['SKILLSMITH_QUIET']

    const { createMergeCommand } = await import('../src/commands/merge.js')
    const cmd = createMergeCommand()

    await cmd.parseAsync(['node', 'test', '/tmp/source.db', '/tmp/target.db'])

    const allOutput = mockConsoleLog.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(allOutput).toContain('Skillsmith Database Merge')
  })
})
