/**
 * Unit tests for SMI-4587 Wave 1 Steps 4–5 — exact-name + generic-token
 * collision detector passes.
 *
 * The semantic pass (Step 6) lands in a subsequent PR; its tests in the
 * plan's §Tests block are wrapped as `.skip` here with a comment.
 */

import { describe, expect, it } from 'vitest'

import {
  detectCollisions,
  detectExactCollisions,
  detectGenericTokenFlags,
} from '../../src/audit/collision-detector.js'
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

  it('semanticCollisions remains an empty placeholder until the semantic-pass PR lands', async () => {
    const result = await detectCollisions([entry({ identifier: 'x' })])
    expect(result.semanticCollisions).toEqual([])
    expect(result.summary.passDurations.semantic).toBe(0)
  })

  it('genericFlags is populated when entries carry generic-trigger names', async () => {
    const result = await detectCollisions([
      entry({ identifier: 'ship', source_path: '/skills/ship/SKILL.md' }),
    ])
    expect(result.genericFlags.length).toBeGreaterThan(0)
    expect(result.genericFlags[0]?.kind).toBe('generic')
    expect(result.summary.warningCount).toBe(result.genericFlags.length)
  })

  it('genericFlags is empty for non-generic identifiers + descriptions', async () => {
    const result = await detectCollisions([
      entry({
        identifier: 'kubernetes-helm-release',
        meta: { description: 'Manage Helm release rollouts on Kubernetes clusters.' },
      }),
      entry({
        identifier: 'terraform-stack',
        meta: { description: 'Provision Terraform stacks across cloud accounts.' },
      }),
    ])
    expect(result.genericFlags).toEqual([])
  })

  it('records generic-pass duration in passDurations.generic when flags are produced', async () => {
    const result = await detectCollisions([
      entry({ identifier: 'ship', source_path: '/a' }),
      entry({ identifier: 'review', source_path: '/b' }),
    ])
    expect(result.genericFlags.length).toBeGreaterThan(0)
    expect(result.summary.passDurations.generic).toBeGreaterThanOrEqual(0)
    expect(result.summary.durationMs).toBeGreaterThanOrEqual(result.summary.passDurations.generic)
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

describe('detectGenericTokenFlags (generic-token pass)', () => {
  it('flags a stoplist token used as a skill name with severity=warning', () => {
    const auditId = newAuditId()
    const inv = [entry({ identifier: 'ship', source_path: '/skills/ship/SKILL.md' })]
    const flags = detectGenericTokenFlags(inv, auditId)
    expect(flags).toHaveLength(1)
    const flag = flags[0]!
    expect(flag.kind).toBe('generic')
    expect(flag.identifier).toBe('ship')
    expect(flag.matchedTokens).toEqual(['ship'])
    expect(flag.severity).toBe('warning')
    expect(flag.collisionId).toMatch(/^[0-9a-f]{16}$/)
    expect(flag.entry.source_path).toBe('/skills/ship/SKILL.md')
  })

  it('flags generic tokens that appear in the description', () => {
    const auditId = newAuditId()
    const inv = [
      entry({
        identifier: 'kubernetes-helm-release',
        source_path: '/skills/k8s-helm/SKILL.md',
        meta: { description: 'Use this skill to ship rollouts to clusters.' },
      }),
    ]
    const flags = detectGenericTokenFlags(inv, auditId)
    // At least one flag for the description hit "ship"; pack helper may also
    // surface other generic tokens like "use" depending on the curated list.
    expect(flags.length).toBeGreaterThan(0)
    expect(flags.every((f) => f.kind === 'generic')).toBe(true)
    expect(flags.some((f) => f.matchedTokens.includes('ship'))).toBe(true)
  })

  it('returns empty when no entries hit the stoplist', () => {
    const auditId = newAuditId()
    const inv = [
      entry({
        identifier: 'kubernetes-helm-release',
        meta: {
          description: 'Manage Helm release rollouts across Kubernetes clusters.',
        },
      }),
      entry({
        identifier: 'terraform-stack-apply',
        meta: { description: 'Apply Terraform stack changes for cloud infrastructure.' },
      }),
    ]
    expect(detectGenericTokenFlags(inv, auditId)).toEqual([])
  })

  it('uses derivePackDomain so the suggested rename reflects mode-of-tags', () => {
    const auditId = newAuditId()
    const inv = [
      entry({
        identifier: 'plan-roadmap',
        source_path: '/a',
        meta: { tags: ['planning'] },
      }),
      entry({
        identifier: 'plan-okrs',
        source_path: '/b',
        meta: { tags: ['planning'] },
      }),
      entry({
        identifier: 'misc-helper',
        source_path: '/c',
        meta: { tags: ['misc'] },
      }),
      // Generic-name skill — should pick up "planning-ship" as the suggestion
      // because the inferred packDomain is "planning".
      entry({ identifier: 'ship', source_path: '/d', meta: { tags: ['planning'] } }),
    ]
    const flags = detectGenericTokenFlags(inv, auditId)
    const shipFlag = flags.find((f) => f.identifier === 'ship')
    expect(shipFlag).toBeDefined()
    expect(shipFlag?.reason).toContain('planning-ship')
  })

  it('produces deterministic ordering by identifier then matched token', () => {
    const auditId = newAuditId()
    const inv = [
      entry({ identifier: 'ship', source_path: '/a' }),
      entry({ identifier: 'review', source_path: '/b' }),
    ]
    const flags = detectGenericTokenFlags(inv, auditId)
    const ids = flags.map((f) => f.identifier)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it('returns empty for an empty inventory', () => {
    const auditId = newAuditId()
    expect(detectGenericTokenFlags([], auditId)).toEqual([])
  })
})

// Semantic-pass tests are deferred to a subsequent PR.
// See plan §Tests / `collision-detector.test.ts` case 12.
describe.skip('semantic pass (subsequent PR)', () => {
  it.skip('Step 6: semantic via OverlapDetector (next PR)', () => {
    /* implemented in a follow-up PR */
  })
})
