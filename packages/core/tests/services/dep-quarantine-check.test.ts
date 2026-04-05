/**
 * Dependency Quarantine Cross-Check Tests - SMI-3871
 */

import { describe, it, expect } from 'vitest'
import { checkDepsAgainstQuarantine } from '../../src/services/skill-installation.helpers.js'
import type {
  DepIntelResult,
  QuarantineStatus,
} from '../../src/services/skill-installation.types.js'

function makeDepIntel(overrides: Partial<DepIntelResult> = {}): DepIntelResult {
  return {
    dep_inferred_servers: [],
    dep_declared: undefined,
    dep_warnings: [],
    ...overrides,
  }
}

describe('checkDepsAgainstQuarantine', () => {
  it('returns no warnings when there are no deps', () => {
    const result = checkDepsAgainstQuarantine(makeDepIntel(), () => null)
    expect(result.warnings).toEqual([])
    expect(result.quarantinedDeps).toEqual([])
  })

  it('returns no warnings when deps are not quarantined', () => {
    const depIntel = makeDepIntel({ dep_inferred_servers: ['server-a', 'server-b'] })
    const result = checkDepsAgainstQuarantine(depIntel, () => null)
    expect(result.warnings).toEqual([])
    expect(result.quarantinedDeps).toEqual([])
  })

  it('warns about inferred server that is pending review', () => {
    const depIntel = makeDepIntel({ dep_inferred_servers: ['suspicious-server'] })
    const getStatus = (id: string): QuarantineStatus | null =>
      id === 'suspicious-server' ? 'pending' : null
    const result = checkDepsAgainstQuarantine(depIntel, getStatus)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('under review')
    expect(result.quarantinedDeps).toEqual(['suspicious-server'])
  })

  it('warns about inferred server that is confirmed malicious', () => {
    const depIntel = makeDepIntel({ dep_inferred_servers: ['malicious-server'] })
    const getStatus = (id: string): QuarantineStatus | null =>
      id === 'malicious-server' ? 'rejected' : null
    const result = checkDepsAgainstQuarantine(depIntel, getStatus)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('confirmed malicious')
    expect(result.quarantinedDeps).toEqual(['malicious-server'])
  })

  it('warns about declared MCP server dependencies', () => {
    const depIntel = makeDepIntel({
      dep_declared: {
        platform: {
          mcp_servers: [
            { name: 'bad-mcp', required: true },
            { name: 'good-mcp', required: false },
          ],
        },
      },
    })
    const getStatus = (id: string): QuarantineStatus | null =>
      id === 'bad-mcp' ? 'rejected' : null
    const result = checkDepsAgainstQuarantine(depIntel, getStatus)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('bad-mcp')
    expect(result.quarantinedDeps).toEqual(['bad-mcp'])
  })

  it('deduplicates when same dep appears in both inferred and declared', () => {
    const depIntel = makeDepIntel({
      dep_inferred_servers: ['overlap-server'],
      dep_declared: {
        platform: {
          mcp_servers: [{ name: 'overlap-server', required: true }],
        },
      },
    })
    const getStatus = (): QuarantineStatus | null => 'pending'
    const result = checkDepsAgainstQuarantine(depIntel, getStatus)
    expect(result.warnings).toHaveLength(1)
    expect(result.quarantinedDeps).toEqual(['overlap-server'])
  })

  it('handles multiple quarantined deps', () => {
    const depIntel = makeDepIntel({
      dep_inferred_servers: ['bad-a', 'good-b', 'bad-c'],
    })
    const quarantined = new Set(['bad-a', 'bad-c'])
    const getStatus = (id: string): QuarantineStatus | null =>
      quarantined.has(id) ? 'rejected' : null
    const result = checkDepsAgainstQuarantine(depIntel, getStatus)
    expect(result.warnings).toHaveLength(2)
    expect(result.quarantinedDeps).toEqual(['bad-a', 'bad-c'])
  })

  it('handles dep_declared without platform', () => {
    const depIntel = makeDepIntel({
      dep_inferred_servers: ['safe'],
      dep_declared: { skills: [{ name: 'some-skill', type: 'soft' as const }] },
    })
    const result = checkDepsAgainstQuarantine(depIntel, () => null)
    expect(result.warnings).toEqual([])
  })
})
