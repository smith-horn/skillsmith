/**
 * Unit tests for SMI-4587 Wave 1 Step 4 — exact-name collision detector.
 *
 * Generic + semantic passes (Steps 5-6) land in subsequent PRs; their
 * tests in the plan's §Tests block are wrapped as `.skip` here with a
 * comment referencing the next PR.
 */

import { describe, expect, it } from 'vitest'

import { detectCollisions, detectExactCollisions } from '../../src/audit/collision-detector.js'
import { newAuditId } from '../../src/audit/audit-history.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'

function entry(overrides: Partial<InventoryEntry>): InventoryEntry {
  return {
    kind: 'skill',
    source_path: '/tmp/SKILL.md',
    identifier: 'noop',
    triggerSurface: ['noop'],
    ...overrides,
  }
}

describe('detectExactCollisions (pure pass)', () => {
  it('flags two skills with the same identifier as severity=error', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'docker', source_path: '/a/skills/docker/SKILL.md' }),
      entry({ identifier: 'docker', source_path: '/b/skills/docker/SKILL.md' }),
    ]
    const flags = detectExactCollisions(inv, auditId)
    expect(flags).toHaveLength(1)
    expect(flags[0]?.severity).toBe('error')
    expect(flags[0]?.identifier).toBe('docker')
    expect(flags[0]?.entries).toHaveLength(2)
    expect(flags[0]?.kind).toBe('exact')
    expect(flags[0]?.collisionId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('flags cross-kind collisions (skill vs command)', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ kind: 'skill', identifier: 'ship', source_path: '/skills/ship/SKILL.md' }),
      entry({ kind: 'command', identifier: 'ship', source_path: '/commands/ship.md' }),
    ]
    const flags = detectExactCollisions(inv, auditId)
    expect(flags).toHaveLength(1)
    expect(flags[0]?.reason).toMatch(/command \/ skill/)
  })

  it('returns empty when no exact collisions present', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'docker' }),
      entry({ identifier: 'kubernetes' }),
      entry({ identifier: 'helm' }),
    ]
    expect(detectExactCollisions(inv, auditId)).toEqual([])
  })

  it('treats identifiers case-insensitively', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'Docker', source_path: '/a' }),
      entry({ identifier: 'docker', source_path: '/b' }),
      entry({ identifier: 'DOCKER', source_path: '/c' }),
    ]
    const flags = detectExactCollisions(inv, auditId)
    expect(flags).toHaveLength(1)
    expect(flags[0]?.entries).toHaveLength(3)
  })

  it('skips empty / whitespace identifiers silently', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: '', source_path: '/a' }),
      entry({ identifier: '   ', source_path: '/b' }),
      entry({ identifier: 'real', source_path: '/c' }),
    ]
    expect(detectExactCollisions(inv, auditId)).toEqual([])
  })

  it('returns flags sorted by identifier for stable report rendering', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'zulu', source_path: '/z1' }),
      entry({ identifier: 'zulu', source_path: '/z2' }),
      entry({ identifier: 'alpha', source_path: '/a1' }),
      entry({ identifier: 'alpha', source_path: '/a2' }),
    ]
    const flags = detectExactCollisions(inv, auditId)
    expect(flags.map((f) => f.identifier)).toEqual(['alpha', 'zulu'])
  })

  it('three-way collisions group all entries into one flag', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'review', source_path: '/a' }),
      entry({ identifier: 'review', source_path: '/b' }),
      entry({ identifier: 'review', source_path: '/c' }),
    ]
    const flags = detectExactCollisions(inv, auditId)
    expect(flags).toHaveLength(1)
    expect(flags[0]?.entries).toHaveLength(3)
    expect(flags[0]?.reason).toMatch(/^3 /)
  })
})

describe('detectCollisions (orchestrator)', () => {
  it('produces an InventoryAuditResult with auditId + summary', async () => {
    const inv = [entry({ identifier: 'a' }), entry({ identifier: 'b' })]
    const result = await detectCollisions(inv)
    expect(result.auditId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(result.summary.totalEntries).toBe(2)
    expect(result.exactCollisions).toEqual([])
    expect(result.summary.errorCount).toBe(0)
  })

  it('passes pre-allocated auditId through to the result', async () => {
    const auditId = newAuditId()
    const result = await detectCollisions([], { auditId })
    expect(result.auditId).toBe(auditId)
  })

  it('counts exact collisions in summary.errorCount', async () => {
    const inv = [
      entry({ identifier: 'collide', source_path: '/a' }),
      entry({ identifier: 'collide', source_path: '/b' }),
    ]
    const result = await detectCollisions(inv)
    expect(result.summary.errorCount).toBe(1)
    expect(result.summary.totalFlags).toBe(1)
  })

  it('genericFlags + semanticCollisions are empty placeholders in this PR', async () => {
    const result = await detectCollisions([entry({ identifier: 'x' })])
    expect(result.genericFlags).toEqual([])
    expect(result.semanticCollisions).toEqual([])
    expect(result.summary.passDurations.generic).toBe(0)
    expect(result.summary.passDurations.semantic).toBe(0)
  })

  it('empty inventory produces empty result', async () => {
    const result = await detectCollisions([])
    expect(result.summary.totalEntries).toBe(0)
    expect(result.summary.totalFlags).toBe(0)
    expect(result.inventory).toEqual([])
  })

  it('exact-pass duration is recorded in passDurations.exact', async () => {
    const inv = Array.from({ length: 20 }, (_, i) =>
      entry({ identifier: `s-${i}`, source_path: `/s/${i}` })
    )
    const result = await detectCollisions(inv)
    expect(result.summary.passDurations.exact).toBeGreaterThanOrEqual(0)
    expect(result.summary.durationMs).toBeGreaterThanOrEqual(result.summary.passDurations.exact)
  })
})

// Generic + semantic pass tests are deferred to subsequent PRs.
// See plan §Tests / `collision-detector.test.ts` cases 3-8, 10, 12.
describe.skip('generic-token + semantic passes (subsequent PRs)', () => {
  it.skip('Step 5: generic-token via detectGenericTriggerWords (next PR)', () => {
    /* implemented in SMI-4587 Wave 1 PR2 */
  })
  it.skip('Step 6: semantic via OverlapDetector (next PR)', () => {
    /* implemented in SMI-4587 Wave 1 PR2 */
  })
})
