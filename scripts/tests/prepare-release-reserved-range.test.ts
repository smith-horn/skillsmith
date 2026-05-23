/**
 * prepare-release: reserved version-range guard (SMI-4207 / ADR-115).
 *
 * Covers checkReservedVersionRanges (the @skillsmith/core 2.x skip rule),
 * resolveNpmLookups's reserved-range filtering of `latest`, and the integration
 * between the two guards.
 *
 * Split out of prepare-release.test.ts (SMI-5141) to keep that file under the
 * 500-line CI gate. The npm-collision rule matrix lives in
 * prepare-release-collision.test.ts; config/version-sync assertions remain in
 * prepare-release.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

// ESM-safe module mocks (must be declared before importing SUT).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

import { writeFileSync } from 'fs'

import { PACKAGE_SPECS } from '../lib/version-utils'

import {
  checkVersionCollision,
  checkReservedVersionRanges,
  resolveNpmLookups,
  RESERVED_RANGES,
  type BumpPlan,
} from '../prepare-release'

const mockedExecFileSync = vi.mocked(execFileSync)
const mockedWriteFileSync = vi.mocked(writeFileSync)

const coreSpec = PACKAGE_SPECS.find((s) => s.shortName === 'core')!

function plan(newVersion: string, current = '0.4.17'): BumpPlan {
  return { spec: coreSpec, currentVersion: current, newVersion }
}

describe('checkReservedVersionRanges — @skillsmith/core 2.x skip rule (SMI-4207)', () => {
  const mcpServerSpec = PACKAGE_SPECS.find((s) => s.shortName === 'mcp-server')!
  const cliSpec = PACKAGE_SPECS.find((s) => s.shortName === 'cli')!

  function planFor(spec: (typeof PACKAGE_SPECS)[number], newVersion: string): BumpPlan {
    return { spec, currentVersion: '0.0.0', newVersion }
  }

  it('refuses @skillsmith/core@2.0.0 (lower bound of reserved range)', () => {
    const result = checkReservedVersionRanges([plan('2.0.0')])
    expect(result.ok).toBe(false)
    const msg = result.errors[0]!
    expect(msg).toContain('@skillsmith/core')
    expect(msg).toContain('2.0.0')
    expect(msg).toContain('2.x')
    expect(msg).toContain('3.0.0')
    expect(msg).toContain('ADR-115')
    // SMI-4531: canonical Rule 1 message no longer includes the script path —
    // the ADR pointer is the durable artifact.
    expect(msg).toContain('permanently deprecated on npm')
    // Must not mention any override flag — this rule is unconditional.
    expect(msg).not.toMatch(/--allow-downgrade/)
    expect(msg).not.toMatch(/--force/)
  })

  it('refuses @skillsmith/core@2.1.3 (would be the next unpublished 2.x patch)', () => {
    const result = checkReservedVersionRanges([plan('2.1.3')])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('2.1.3')
  })

  it('refuses @skillsmith/core@2.99.99 (upper boundary inside reserved range)', () => {
    const result = checkReservedVersionRanges([plan('2.99.99')])
    expect(result.ok).toBe(false)
  })

  it('proceeds for @skillsmith/core@3.0.0 (first allowed post-reserved major)', () => {
    const result = checkReservedVersionRanges([plan('3.0.0')])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('proceeds for @skillsmith/core@0.6.0 (below reserved range)', () => {
    const result = checkReservedVersionRanges([plan('0.6.0')])
    expect(result.ok).toBe(true)
  })

  it('proceeds for @skillsmith/core@1.9.9 (below reserved range — 1.x unreserved)', () => {
    const result = checkReservedVersionRanges([plan('1.9.9')])
    expect(result.ok).toBe(true)
  })

  it('does NOT refuse @skillsmith/mcp-server@2.0.0 (rule scoped to core only)', () => {
    const result = checkReservedVersionRanges([planFor(mcpServerSpec, '2.0.0')])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('does NOT refuse @skillsmith/cli@2.1.0 (rule scoped to core only)', () => {
    const result = checkReservedVersionRanges([planFor(cliSpec, '2.1.0')])
    expect(result.ok).toBe(true)
  })

  it('catches core violation even when other packages in the plan are fine', () => {
    const result = checkReservedVersionRanges([
      planFor(cliSpec, '0.6.0'),
      plan('2.1.3'),
      planFor(mcpServerSpec, '0.5.0'),
    ])
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('@skillsmith/core')
    expect(result.errors[0]).toContain('2.1.3')
  })

  it('is a pure function — no writeFileSync, no execFileSync', () => {
    mockedWriteFileSync.mockClear()
    mockedExecFileSync.mockClear()
    checkReservedVersionRanges([plan('2.1.3'), plan('3.0.0')])
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it('RESERVED_RANGES is configured for @skillsmith/core', () => {
    expect(RESERVED_RANGES['@skillsmith/core']).toBe('>=2.0.0 <3.0.0')
  })
})

describe('resolveNpmLookups — excludes reserved range from latest (SMI-4207)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  // Production scenario: npm returns the full mixed 0.x + 2.x list; latest must be 0.5.1,
  // not 2.1.2 — otherwise normal patch bumps on the live 0.5.x line are blocked by the
  // orphaned 2.x entries.
  it('core with 0.x and 2.x published → latest reflects only live 0.x line', async () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify([
        '0.1.0',
        '0.1.1',
        '0.2.0',
        '0.4.0',
        '0.4.17',
        '0.5.0',
        '0.5.1',
        '2.0.0',
        '2.0.1',
        '2.1.0',
        '2.1.2',
      ]) as never
    )
    const lookups = await resolveNpmLookups([plan('0.5.2')])
    const lookup = lookups.get('@skillsmith/core')!
    expect(lookup.latest).toBe('0.5.1')
    // allVersions retains full list so Rule 3 isPublished still protects against
    // replaying any published version.
    expect(lookup.allVersions).toContain('2.1.2')
    expect(lookup.allVersions).toContain('0.5.1')
  })

  it('core with only reserved-range versions → latest is null (all filtered)', async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify(['2.0.0', '2.1.0', '2.1.2']) as never)
    const lookups = await resolveNpmLookups([plan('3.0.0')])
    const lookup = lookups.get('@skillsmith/core')!
    expect(lookup.latest).toBeNull()
    expect(lookup.allVersions).toHaveLength(3)
  })

  it('mcp-server (no reserved range configured) → latest uses full list', async () => {
    const mcpSpec = PACKAGE_SPECS.find((s) => s.shortName === 'mcp-server')!
    mockedExecFileSync.mockReturnValue(JSON.stringify(['0.4.8', '0.4.9']) as never)
    const lookups = await resolveNpmLookups([
      { spec: mcpSpec, currentVersion: '0.4.9', newVersion: '0.4.10' },
    ])
    const lookup = lookups.get('@skillsmith/mcp-server')!
    expect(lookup.latest).toBe('0.4.9')
  })
})

describe('checkVersionCollision × reserved range — integration (SMI-4207)', () => {
  // End-to-end: production lookup (0.x + 2.x) + proposing 0.5.2 → collision guard must pass
  // because `latest` is now computed as 0.5.1 after reserved-range filtering.
  it('proposing 0.5.2 against mixed 0.x/2.x published → passes (latest=0.5.1)', () => {
    const lookups = new Map([
      [
        coreSpec.name,
        {
          latest: '0.5.1', // resolveNpmLookups would filter 2.x; assert behavior downstream
          allVersions: ['0.4.17', '0.5.0', '0.5.1', '2.0.0', '2.1.0', '2.1.2'],
        },
      ],
    ])
    const result = checkVersionCollision([plan('0.5.2')], lookups, { allowDowngrade: false })
    expect(result.ok).toBe(true)
  })

  // Proposing a 2.x version: checkReservedVersionRanges must fire first (it runs before
  // checkVersionCollision in main()), but even if operators run checkVersionCollision alone,
  // proposing 2.1.2 still fails Rule 3 because 2.1.2 remains in allVersions.
  it('proposing 2.1.2 still caught by Rule 3 (isPublished) even if reserved guard bypassed', () => {
    const lookups = new Map([
      [
        coreSpec.name,
        {
          latest: '0.5.1',
          allVersions: ['0.5.1', '2.0.0', '2.1.0', '2.1.2'],
        },
      ],
    ])
    const result = checkVersionCollision([plan('2.1.2')], lookups, { allowDowngrade: true })
    expect(result.ok).toBe(false)
    // SMI-4531: canonical Rule 3 message — capitalized "Revert". With Rule 1
    // also firing for 2.1.2 (it's reserved), checkVersionCollision's defensive
    // Rule 1 check wins; either message is acceptable. Assert on the
    // unconditional-refuse signal that's present in BOTH canonical messages.
    expect(result.errors[0]).not.toMatch(/--allow-downgrade/)
    expect(result.errors[0]).toMatch(/reserved 2\.x range|Revert to release/)
  })
})
