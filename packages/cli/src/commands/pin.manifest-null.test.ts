/**
 * @fileoverview SMI-6733 Phase 2 F5 — pin/unpin against a manifest whose
 * `installedSkills` classifies `ok` but is `null` (ADR-171 § 5's nullish
 * carve-out: byte-identical to absent in CAS canonical form). Before the
 * fix, a bare `manifest.installedSkills[key]` subscript in pin.ts threw
 * `TypeError: Cannot read properties of null (reading '<key>')`; pin/unpin
 * must now read through `installedSkillsOf()` and degrade to the same
 * "not found in manifest" error an empty manifest already produces.
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

// ============================================================================
// Tests
// ============================================================================

describe('pin/unpin against a manifest with installedSkills: null (SMI-6733 Phase 2 F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pin: reports the normal "not found in manifest" error instead of throwing', async () => {
    mockLoadManifest.mockResolvedValue(NULL_INSTALLED_SKILLS_MANIFEST)

    const cmd = createPinCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

    // Positive assertion on the actual output a real "not installed" skill
    // produces against a normal (non-null) empty manifest — not merely
    // "did not throw", which would also pass if the command silently no-opped.
    expect(exitCode).toBe(1)
    expect(mockUpdateManifestEntry).not.toHaveBeenCalled()
    expect(consoleOutput.join(' ')).toContain('not found in manifest')
  })

  it('unpin: reports the normal "not found in manifest" error instead of throwing', async () => {
    mockLoadManifest.mockResolvedValue(NULL_INSTALLED_SKILLS_MANIFEST)

    const cmd = createUnpinCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

    expect(exitCode).toBe(1)
    expect(mockUpdateManifestEntry).not.toHaveBeenCalled()
    expect(consoleOutput.join(' ')).toContain('not found in manifest')
  })
})
