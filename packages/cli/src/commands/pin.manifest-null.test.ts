/**
 * @fileoverview SMI-6733 Phase 2 F5 — pin/unpin against a manifest whose
 * `installedSkills` classifies `ok` but holds no usable record. ADR-171 § 5's
 * nullish carve-out admits TWO such shapes and they are indistinguishable in
 * the CAS canonical form: an explicit `null`, and the key being absent. Before
 * the fix, a bare `manifest.installedSkills[key]` subscript in pin.ts threw
 * `TypeError: Cannot read properties of null (reading '<key>')`; pin/unpin
 * must now read through `installedSkillsOf()` and degrade to the same
 * "not found in manifest" error an empty manifest already produces.
 *
 * Every case here is driven against both shapes. Covering only the explicit
 * `null` leaves a one-token mutation alive — see NULLISH_DOCUMENTS below.
 * @see SMI-6733, docs/internal/adr/171-manifest-read-state-contract.md §5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ============================================================================
// Module mocks — must be declared before imports that use them
// ============================================================================

vi.mock('../utils/require-tier.js', () => ({
  requireTier: vi.fn().mockResolvedValue(undefined),
}))

const mockLoadManifest = vi.fn()
const mockUpdateManifestEntry = vi.fn()

vi.mock('../utils/manifest.js', () => ({
  loadManifest: () => mockLoadManifest(),
  updateManifestEntry: (fn: (m: unknown) => unknown) => mockUpdateManifestEntry(fn),
}))

// ============================================================================
// Import after mocks are set up
// ============================================================================

import { createPinCommand, createUnpinCommand } from './pin.js'
import type { SkillManifest } from '../utils/manifest.js'

// ============================================================================
// Helpers (mirrors pin.test.ts's own runCommand harness)
// ============================================================================

async function runCommand(
  cmd: Command,
  argv: string[]
): Promise<{ exitCode: number | null; consoleOutput: string[] }> {
  const output: string[] = []
  const exitCode: { value: number | null } = { value: null }

  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode.value = typeof code === 'number' ? code : null
    throw new Error(`process.exit(${code})`)
  })

  try {
    await cmd.parseAsync(['node', 'test', ...argv])
  } catch (e) {
    // Swallow process.exit throws
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('process.exit')) throw e
  } finally {
    consoleSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return { exitCode: exitCode.value, consoleOutput: output }
}

const NULL_INSTALLED_SKILLS_MANIFEST = { version: '1.0.0', installedSkills: null }

/**
 * ADR-171 § 5 admits TWO nullish shapes, not one: `installedSkills: null` and
 * the key being absent entirely. They are the same document in the
 * content-addressed canonical form § 3 requires, which is the whole reason both
 * classify `ok`.
 *
 * Only the first was covered until the cross-family gate on PR #2980 named the
 * mutation that exploits the gap: `m.installedSkills === null ? {} :
 * m.installedSkills` passes every explicit-`null` case and throws on an absent
 * key. Both shapes are driven everywhere below, so a fix handling one and not
 * the other cannot pass.
 */
const NULLISH_DOCUMENTS: ReadonlyArray<readonly [string, object]> = [
  ['installedSkills: null', NULL_INSTALLED_SKILLS_MANIFEST],
  ['installedSkills absent', { version: '1.0.0' }],
]

// ============================================================================
// Tests
// ============================================================================

describe('pin/unpin against a manifest with a nullish installedSkills (SMI-6733 Phase 2 F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it.each(NULLISH_DOCUMENTS)(
    'pin: reports the normal "not found in manifest" error instead of throwing (%s)',
    async (_label, doc) => {
      mockLoadManifest.mockResolvedValue(doc)

      const cmd = createPinCommand()
      const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

      // Positive assertion on the actual output a real "not installed" skill
      // produces against a normal (non-null) empty manifest — not merely
      // "did not throw", which would also pass if the command silently no-opped.
      expect(exitCode).toBe(1)
      expect(mockUpdateManifestEntry).not.toHaveBeenCalled()
      expect(consoleOutput.join(' ')).toContain('not found in manifest')
    }
  )

  it.each(NULLISH_DOCUMENTS)(
    'unpin: reports the normal "not found in manifest" error instead of throwing (%s)',
    async (_label, doc) => {
      mockLoadManifest.mockResolvedValue(doc)

      const cmd = createUnpinCommand()
      const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

      expect(exitCode).toBe(1)
      expect(mockUpdateManifestEntry).not.toHaveBeenCalled()
      expect(consoleOutput.join(' ')).toContain('not found in manifest')
    }
  )
})

// ============================================================================
// The two sites INSIDE the updateManifestEntry callback (post-merge retro on
// cfc96eccd)
// ============================================================================

/**
 * The two tests above exercise only pin.ts's OUTER read. Both exit before
 * `updateManifestEntry` is ever called, and the mock above is a bare `vi.fn()`
 * that never invokes its argument — so neither reaches the two
 * `installedSkillsOf(m)` reads inside the callback bodies. Reverting both of
 * those to a bare `m.installedSkills[key]` subscript passed all 1146 cli tests.
 *
 * Those sites are not redundant with the outer read, and the reason is the
 * whole point of `updateManifestEntry`: it re-reads the file under the lock, so
 * the manifest the callback receives is a DIFFERENT document from the one the
 * outer guard inspected. A concurrent writer can set `installedSkills` to
 * `null` — a state ADR-171 § 5 classifies `ok` — between the two reads. The
 * outer guard found an entry; the callback then subscripts `null`.
 *
 * The fixture below is the manifest the callback sees, not the one the command
 * loads, which is why the two mocks disagree on purpose.
 */
describe('pin/unpin when the LOCKED re-read yields a nullish installedSkills', () => {
  const PINNABLE_ENTRY = {
    id: 'anthropic/commit-helper',
    name: 'commit-helper',
    version: '1.0.0',
    source: 'https://github.com/anthropic/commit-helper',
    installPath: '/home/user/.claude/skills/commit-helper',
    installedAt: '2024-01-01T00:00:00.000Z',
    lastUpdated: '2024-01-01T00:00:00.000Z',
    contentHash: 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
    originalContentHash: 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
  }

  /**
   * Drive the callback with one nullish document and hand back what it
   * returned, so the assertion can be about the callback's own output rather
   * than about the command merely not crashing.
   */
  function captureCallbackResult(doc: object): { get: () => unknown; called: () => boolean } {
    let returned: unknown
    let invoked = false
    mockUpdateManifestEntry.mockImplementation(async (fn: (m: SkillManifest) => SkillManifest) => {
      invoked = true
      returned = fn(doc as unknown as SkillManifest)
    })
    return { get: () => returned, called: () => invoked }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it.each(NULLISH_DOCUMENTS)(
    'pin: the callback returns the manifest unchanged instead of throwing (%s)',
    async (_label, doc) => {
      mockLoadManifest.mockResolvedValue({
        version: '1.0.0',
        installedSkills: { 'commit-helper': PINNABLE_ENTRY },
      })
      const callback = captureCallbackResult(doc)

      const cmd = createPinCommand()
      const { exitCode } = await runCommand(cmd, ['commit-helper'])

      // The callback actually ran — without this, every assertion below would
      // hold just as well for a test whose trigger never fires.
      expect(callback.called()).toBe(true)
      // No write: the entry the callback was asked to modify is not in the
      // document it was handed, so it returns that document untouched. Identity,
      // not deep equality — a rebuilt object would mean a write was attempted.
      expect(callback.get()).toBe(doc)
      expect(exitCode).toBeNull()
    }
  )

  it.each(NULLISH_DOCUMENTS)(
    'unpin: the callback returns the manifest unchanged instead of throwing (%s)',
    async (_label, doc) => {
      mockLoadManifest.mockResolvedValue({
        version: '1.0.0',
        installedSkills: {
          'commit-helper': { ...PINNABLE_ENTRY, pinnedVersion: 'a3f7b2c1' },
        },
      })
      const callback = captureCallbackResult(doc)

      const cmd = createUnpinCommand()
      const { exitCode } = await runCommand(cmd, ['commit-helper'])

      expect(callback.called()).toBe(true)
      expect(callback.get()).toBe(doc)
      expect(exitCode).toBeNull()
    }
  )
})
