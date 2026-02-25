/**
 * @fileoverview Tests for pin.ts — pin/unpin manifest commands
 * @see SMI-skill-version-tracking Wave 2
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
// Helpers
// ============================================================================

function buildManifest(overrides: Partial<SkillManifest['installedSkills']> = {}): SkillManifest {
  return {
    version: '1.0.0',
    installedSkills: {
      'commit-helper': {
        id: 'anthropic/commit-helper',
        name: 'commit-helper',
        version: '1.0.0',
        source: 'https://github.com/anthropic/commit-helper',
        installPath: '/home/user/.claude/skills/commit-helper',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        contentHash: 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
        originalContentHash: 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
      },
      ...overrides,
    },
  }
}

/**
 * Run a commander command programmatically with the given argv.
 * Captures console output and process.exit calls.
 */
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

// ============================================================================
// Tests
// ============================================================================

describe('createPinCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('writes pinnedVersion (8-char hash) to manifest entry', async () => {
    const manifest = buildManifest()
    mockLoadManifest.mockResolvedValue(manifest)

    let capturedUpdateFn: ((m: SkillManifest) => SkillManifest) | null = null
    mockUpdateManifestEntry.mockImplementation(
      async (fn: (m: SkillManifest) => SkillManifest) => {
        capturedUpdateFn = fn
      }
    )

    const cmd = createPinCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

    expect(exitCode).toBeNull()
    expect(mockUpdateManifestEntry).toHaveBeenCalledOnce()

    // Apply the update function and verify pinnedVersion is set
    const updated = capturedUpdateFn!(manifest)
    const entry = updated.installedSkills['commit-helper']!
    expect(entry.pinnedVersion).toBe('a3f7b2c1')
    expect(consoleOutput.join(' ')).toContain('a3f7b2c1')
  })

  it('uses contentHash first, falls back to originalContentHash', async () => {
    const manifest = buildManifest({
      'no-content-hash': {
        id: 'test/no-content-hash',
        name: 'no-content-hash',
        version: '1.0.0',
        source: 'https://github.com/test/no-content-hash',
        installPath: '/home/user/.claude/skills/no-content-hash',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        originalContentHash: 'deadbeef1234567890abcdef',
      },
    })
    mockLoadManifest.mockResolvedValue(manifest)

    let capturedUpdateFn: ((m: SkillManifest) => SkillManifest) | null = null
    mockUpdateManifestEntry.mockImplementation(
      async (fn: (m: SkillManifest) => SkillManifest) => {
        capturedUpdateFn = fn
      }
    )

    const cmd = createPinCommand()
    await runCommand(cmd, ['no-content-hash'])

    const updated = capturedUpdateFn!(manifest)
    expect(updated.installedSkills['no-content-hash']?.pinnedVersion).toBe('deadbeef')
  })

  it('exits with error when skill is not in manifest', async () => {
    mockLoadManifest.mockResolvedValue(buildManifest())
    const cmd = createPinCommand()
    const { exitCode } = await runCommand(cmd, ['nonexistent-skill'])
    expect(exitCode).toBe(1)
  })

  it('exits with warning when no hash is available', async () => {
    const manifest = buildManifest({
      'no-hash-skill': {
        id: 'test/no-hash-skill',
        name: 'no-hash-skill',
        version: '1.0.0',
        source: 'https://github.com/test/no-hash-skill',
        installPath: '/home/user/.claude/skills/no-hash-skill',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    })
    mockLoadManifest.mockResolvedValue(manifest)
    const cmd = createPinCommand()
    const { exitCode } = await runCommand(cmd, ['no-hash-skill'])
    expect(exitCode).toBe(1)
  })
})

describe('createUnpinCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('removes pinnedVersion from manifest entry', async () => {
    const manifest = buildManifest({
      'commit-helper': {
        id: 'anthropic/commit-helper',
        name: 'commit-helper',
        version: '1.0.0',
        source: 'https://github.com/anthropic/commit-helper',
        installPath: '/home/user/.claude/skills/commit-helper',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
        contentHash: 'a3f7b2c1d4e5f6a7b8c9d0e1f2a3b4c5',
        pinnedVersion: 'a3f7b2c1',
      },
    })
    mockLoadManifest.mockResolvedValue(manifest)

    let capturedUpdateFn: ((m: SkillManifest) => SkillManifest) | null = null
    mockUpdateManifestEntry.mockImplementation(
      async (fn: (m: SkillManifest) => SkillManifest) => {
        capturedUpdateFn = fn
      }
    )

    const cmd = createUnpinCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])

    expect(exitCode).toBeNull()
    expect(mockUpdateManifestEntry).toHaveBeenCalledOnce()

    // Apply the update function and verify pinnedVersion is removed
    const updated = capturedUpdateFn!(manifest)
    expect(updated.installedSkills['commit-helper']?.pinnedVersion).toBeUndefined()
    expect(consoleOutput.join(' ')).toContain('Unpinned')
  })

  it('prints dim message when skill is not pinned (no-op)', async () => {
    const manifest = buildManifest()
    mockLoadManifest.mockResolvedValue(manifest)
    const cmd = createUnpinCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, ['commit-helper'])
    expect(exitCode).toBeNull()
    expect(mockUpdateManifestEntry).not.toHaveBeenCalled()
    expect(consoleOutput.join(' ')).toContain('not pinned')
  })

  it('exits with error when skill is not in manifest', async () => {
    mockLoadManifest.mockResolvedValue(buildManifest())
    const cmd = createUnpinCommand()
    const { exitCode } = await runCommand(cmd, ['nonexistent-skill'])
    expect(exitCode).toBe(1)
  })
})
