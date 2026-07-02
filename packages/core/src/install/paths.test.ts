/**
 * SMI-5390: Tests for `enumerateHarnessPresence`.
 *
 * `existsSync` is mocked via vi.mock('node:fs') so the tests never touch
 * the real filesystem. The hoisted spy is shared between the mock factory
 * and the test bodies via the vi.hoisted closure — same pattern as
 * pythonIncremental.hardening.test.ts (SMI-4315/4316).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted runs before vi.mock factories so we can share the spy instance.
const { existsSyncSpy } = vi.hoisted(() => ({
  existsSyncSpy: vi.fn<(p: string) => boolean>(() => false),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: (p: string) => existsSyncSpy(p) }
})

import { CLIENT_IDS, CLIENT_NATIVE_PATHS, enumerateHarnessPresence } from './paths.js'

describe('enumerateHarnessPresence (SMI-5390)', () => {
  beforeEach(() => {
    existsSyncSpy.mockReset()
    existsSyncSpy.mockReturnValue(false)
  })

  it('returns one entry for every ClientId in CLIENT_IDS', () => {
    const result = enumerateHarnessPresence()
    expect(result).toHaveLength(CLIENT_IDS.length)
    const returnedHarnesses = result.map((r) => r.harness)
    expect(returnedHarnesses).toEqual(expect.arrayContaining([...CLIENT_IDS]))
  })

  it('reports present: true for harnesses whose directory exists', () => {
    // Make only claude-code and cursor appear on disk.
    existsSyncSpy.mockImplementation(
      (p) => p === CLIENT_NATIVE_PATHS['claude-code'] || p === CLIENT_NATIVE_PATHS['cursor']
    )

    const result = enumerateHarnessPresence()

    expect(result.find((r) => r.harness === 'claude-code')?.present).toBe(true)
    expect(result.find((r) => r.harness === 'cursor')?.present).toBe(true)
    expect(result.find((r) => r.harness === 'copilot')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'windsurf')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'agents')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'opencode')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'hermes')?.present).toBe(false)
  })

  it('reports all harnesses absent when existsSync returns false for every path', () => {
    existsSyncSpy.mockReturnValue(false)
    const result = enumerateHarnessPresence()
    expect(result.every((r) => r.present === false)).toBe(true)
  })

  it('reports all harnesses present when existsSync returns true for every path', () => {
    existsSyncSpy.mockReturnValue(true)
    const result = enumerateHarnessPresence()
    expect(result.every((r) => r.present === true)).toBe(true)
  })

  it('returns the canonical CLIENT_NATIVE_PATHS path for each harness', () => {
    const result = enumerateHarnessPresence()
    for (const entry of result) {
      expect(entry.path).toBe(CLIENT_NATIVE_PATHS[entry.harness])
    }
  })

  it('calls existsSync exactly once per harness', () => {
    enumerateHarnessPresence()
    expect(existsSyncSpy).toHaveBeenCalledTimes(CLIENT_IDS.length)
  })
})

describe('opencode + hermes ClientIds (SMI-5456 Wave 1 Step 5)', () => {
  it('CLIENT_IDS includes opencode and hermes', () => {
    expect(CLIENT_IDS).toContain('opencode')
    expect(CLIENT_IDS).toContain('hermes')
    expect(CLIENT_IDS).toHaveLength(7)
  })

  it('opencode resolves to ~/.config/opencode/skills', () => {
    expect(CLIENT_NATIVE_PATHS.opencode.endsWith('/.config/opencode/skills')).toBe(true)
  })

  it('hermes resolves to ~/.hermes/skills', () => {
    expect(CLIENT_NATIVE_PATHS.hermes.endsWith('/.hermes/skills')).toBe(true)
  })
})
