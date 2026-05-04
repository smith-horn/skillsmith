/**
 * Unit tests for the audit exclusions loader, matcher, and tier-revalidation
 * gate (SMI-4590 Wave 4 PR 3). Mirrors the test plan in §8 of
 * `docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getExclusionsPath,
  isExcluded,
  loadExclusions,
  tierAllowsAuditMode,
} from '../../../src/audit/exclusions.js'
import type { ExcludableEntry, ExclusionsConfig } from '../../../src/audit/exclusions.types.js'

let tmpDir: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smi-4590-exclusions-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  warnSpy.mockRestore()
})

function writeConfig(content: string): string {
  const path = join(tmpDir, 'audit-exclusions.json')
  writeFileSync(path, content, 'utf-8')
  return path
}

describe('loadExclusions', () => {
  it('returns parsed config for a valid file (test 1: round-trip)', async () => {
    const path = writeConfig(
      JSON.stringify({
        version: 1,
        exclusions: [
          { kind: 'command', identifier: '/ship', reason: 'Both packs are mine.' },
          { kind: 'skill', skillId: 'anthropic/code-helper', reason: 'Compatibility.' },
        ],
      })
    )
    const config = await loadExclusions({ configPath: path })
    expect(config.version).toBe(1)
    expect(config.exclusions).toHaveLength(2)
    expect(config.exclusions[0]).toMatchObject({ kind: 'command', identifier: '/ship' })
  })

  it('returns empty config when file is missing (test 2: ENOENT)', async () => {
    const config = await loadExclusions({ configPath: join(tmpDir, 'nope.json') })
    expect(config).toEqual({ version: 1, exclusions: [] })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns empty config and warns on malformed JSON (test 3)', async () => {
    const path = writeConfig('{ "version": 1, "exclusions": [')
    const config = await loadExclusions({ configPath: path })
    expect(config).toEqual({ version: 1, exclusions: [] })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed JSON'))
  })

  it('returns empty config and warns on unknown version (test 4)', async () => {
    const path = writeConfig(JSON.stringify({ version: 2, exclusions: [] }))
    const config = await loadExclusions({ configPath: path })
    expect(config).toEqual({ version: 1, exclusions: [] })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unrecognized schema'))
  })

  it('rejects entries missing required fields', async () => {
    const path = writeConfig(
      JSON.stringify({
        version: 1,
        exclusions: [{ kind: 'command', identifier: '/ship' }],
      })
    )
    const config = await loadExclusions({ configPath: path })
    expect(config.exclusions).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unrecognized schema'))
  })

  it('rejects entries with unknown kind', async () => {
    const path = writeConfig(
      JSON.stringify({
        version: 1,
        exclusions: [{ kind: 'mcp-tool', identifier: 'foo', reason: 'no' }],
      })
    )
    const config = await loadExclusions({ configPath: path })
    expect(config.exclusions).toEqual([])
  })

  it('returns empty config on read errors other than ENOENT (warn-and-empty)', async () => {
    const config = await loadExclusions({ configPath: tmpDir })
    expect(config).toEqual({ version: 1, exclusions: [] })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('read failed'))
  })
})

describe('getExclusionsPath', () => {
  it('joins configDir with the standard filename', () => {
    expect(getExclusionsPath({ configDir: '/tmp/foo' })).toBe('/tmp/foo/audit-exclusions.json')
  })

  it('falls back to ~/.skillsmith when configDir is unset', () => {
    const path = getExclusionsPath()
    expect(path).toMatch(/\.skillsmith[\\/]audit-exclusions\.json$/)
  })
})

describe('isExcluded', () => {
  const config: ExclusionsConfig = {
    version: 1,
    exclusions: [
      { kind: 'command', identifier: '/ship', reason: 'mine' },
      { kind: 'skill', skillId: 'anthropic/code-helper', reason: 'compat' },
    ],
  }

  it('matches a command entry by identifier', () => {
    const entry: ExcludableEntry = { kind: 'command', commandIdentifier: '/ship' }
    expect(isExcluded(entry, config)).toBe(true)
  })

  it('matches a skill entry by skillId', () => {
    const entry: ExcludableEntry = { kind: 'skill', skillId: 'anthropic/code-helper' }
    expect(isExcluded(entry, config)).toBe(true)
  })

  it('does not match when the identifier differs', () => {
    const entry: ExcludableEntry = { kind: 'command', commandIdentifier: '/other' }
    expect(isExcluded(entry, config)).toBe(false)
  })

  it('does not cross kinds (command exclusion does not match a skill entry)', () => {
    const entry: ExcludableEntry = { kind: 'skill', skillId: '/ship' }
    expect(isExcluded(entry, config)).toBe(false)
  })

  it('returns false against an empty config', () => {
    const empty: ExclusionsConfig = { version: 1, exclusions: [] }
    const entry: ExcludableEntry = { kind: 'command', commandIdentifier: '/ship' }
    expect(isExcluded(entry, empty)).toBe(false)
  })
})

describe('tierAllowsAuditMode (test 5: tier-revalidation gate)', () => {
  // Eligibility table from exclusions.ts JSDoc. Each row is one tier.
  const cases: Array<
    [Parameters<typeof tierAllowsAuditMode>[0], Parameters<typeof tierAllowsAuditMode>[1], boolean]
  > = [
    // community
    ['community', 'preventative', true],
    ['community', 'off', true],
    ['community', 'power_user', false],
    ['community', 'governance', false],
    // individual
    ['individual', 'preventative', true],
    ['individual', 'off', true],
    ['individual', 'power_user', false],
    ['individual', 'governance', false],
    // team
    ['team', 'preventative', true],
    ['team', 'off', true],
    ['team', 'power_user', true],
    ['team', 'governance', false],
    // enterprise
    ['enterprise', 'preventative', true],
    ['enterprise', 'off', true],
    ['enterprise', 'power_user', true],
    ['enterprise', 'governance', true],
  ]

  it.each(cases)('tier=%s mode=%s -> %s', (tier, mode, expected) => {
    expect(tierAllowsAuditMode(tier, mode)).toBe(expected)
  })

  it('Free / Individual users cannot opt into power_user (CLI rejects)', () => {
    expect(tierAllowsAuditMode('community', 'power_user')).toBe(false)
    expect(tierAllowsAuditMode('individual', 'power_user')).toBe(false)
  })

  it('Only Enterprise can select governance', () => {
    expect(tierAllowsAuditMode('community', 'governance')).toBe(false)
    expect(tierAllowsAuditMode('individual', 'governance')).toBe(false)
    expect(tierAllowsAuditMode('team', 'governance')).toBe(false)
    expect(tierAllowsAuditMode('enterprise', 'governance')).toBe(true)
  })
})
