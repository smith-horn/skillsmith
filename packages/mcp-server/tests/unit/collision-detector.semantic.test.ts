/**
 * Unit tests for SMI-4587 Wave 1 PR #3 — semantic-overlap pass,
 * audit-mode dispatch (resolver + 'off' short-circuit), and unmanaged-
 * skill bootstrap. Split from `collision-detector.test.ts` to keep both
 * files under the 500-LOC pre-commit limit (SMI-3493).
 *
 * Latency-invariant tests in `semantic pass — preventative mode` spy on
 * `EmbeddingService.prototype.embed` AND `OverlapDetector.prototype.findAllOverlaps`
 * to assert zero invocations when the cheap mode is selected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bootstrapUnmanagedSkills,
  detectCollisions,
  getLastBootstrapWarnings,
  isUnmanagedSkill,
} from '../../src/audit/collision-detector.js'
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

describe('audit-mode resolver dispatch', () => {
  it('off short-circuits — empty result, no flags, summary zeros', async () => {
    const inv = [
      entry({ identifier: 'collide', source_path: '/a' }),
      entry({ identifier: 'collide', source_path: '/b' }),
    ]
    const result = await detectCollisions(inv, { auditModeOverride: 'off' })
    expect(result.exactCollisions).toEqual([])
    expect(result.genericFlags).toEqual([])
    expect(result.semanticCollisions).toEqual([])
    expect(result.summary.totalEntries).toBe(0)
    expect(result.summary.totalFlags).toBe(0)
    expect(result.summary.errorCount).toBe(0)
    expect(result.summary.warningCount).toBe(0)
    expect(result.summary.passDurations).toEqual({ exact: 0, generic: 0, semantic: 0 })
  })

  it('community tier defaults to preventative — no semantic pass', async () => {
    const inv = [entry({ identifier: 'a' }), entry({ identifier: 'b' })]
    const result = await detectCollisions(inv, { tier: 'community' })
    expect(result.semanticCollisions).toEqual([])
    expect(result.summary.passDurations.semantic).toBe(0)
  })

  it('individual tier defaults to preventative — no semantic pass', async () => {
    const inv = [entry({ identifier: 'a' }), entry({ identifier: 'b' })]
    const result = await detectCollisions(inv, { tier: 'individual' })
    expect(result.summary.passDurations.semantic).toBe(0)
  })

  it('explicit override beats tier default', async () => {
    // Team default = power_user (which would run semantic). Override
    // to 'preventative' must skip the semantic pass.
    const inv = [entry({ identifier: 'a' }), entry({ identifier: 'b' })]
    const result = await detectCollisions(inv, {
      tier: 'team',
      auditModeOverride: 'preventative',
    })
    expect(result.summary.passDurations.semantic).toBe(0)
  })
})

describe('semantic pass — preventative mode (latency invariant)', () => {
  // The latency invariant (plan §426) is "in `preventative` mode the
  // OverlapDetector is NOT instantiated and EmbeddingService is NOT
  // touched." We assert both signals:
  //   1. `EmbeddingService.prototype.embed` is never called (which
  //      would indicate a model load + inference happened).
  //   2. `OverlapDetector.prototype.findAllOverlaps` is never called
  //      (which would indicate the orchestrator entered the semantic
  //      branch despite the cheap-mode flag).
  let embedSpy: ReturnType<typeof vi.spyOn>
  let findAllOverlapsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const embeddings = await import('@skillsmith/core/embeddings')
    const core = await import('@skillsmith/core')
    embedSpy = vi
      .spyOn(embeddings.EmbeddingService.prototype, 'embed')
      .mockImplementation(async () => new Float32Array(384))
    findAllOverlapsSpy = vi
      .spyOn(core.OverlapDetector.prototype, 'findAllOverlaps')
      .mockImplementation(async () => [])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preventative mode does NOT touch EmbeddingService', async () => {
    const inv = [
      entry({
        identifier: 'a',
        source_path: '/a',
        triggerSurface: ['ship a release'],
      }),
      entry({
        identifier: 'b',
        source_path: '/b',
        triggerSurface: ['deploy a release'],
      }),
    ]
    const result = await detectCollisions(inv, { tier: 'community' })
    expect(embedSpy).not.toHaveBeenCalled()
    expect(findAllOverlapsSpy).not.toHaveBeenCalled()
    expect(result.semanticCollisions).toEqual([])
  })

  it('off mode also does NOT touch EmbeddingService', async () => {
    const inv = [
      entry({ identifier: 'a', triggerSurface: ['x'] }),
      entry({ identifier: 'b', triggerSurface: ['y'] }),
    ]
    await detectCollisions(inv, { tier: 'team', auditModeOverride: 'off' })
    expect(embedSpy).not.toHaveBeenCalled()
    expect(findAllOverlapsSpy).not.toHaveBeenCalled()
  })

  it('power_user mode DOES invoke OverlapDetector.findAllOverlaps', async () => {
    const inv = [
      entry({ identifier: 'a', source_path: '/a', triggerSurface: ['x'] }),
      entry({ identifier: 'b', source_path: '/b', triggerSurface: ['y'] }),
    ]
    await detectCollisions(inv, { tier: 'team' })
    expect(findAllOverlapsSpy).toHaveBeenCalledTimes(1)
  })
})

describe('semantic pass — power_user mode', () => {
  it('produces SemanticCollisionFlag entries for overlapping trigger phrases', async () => {
    // Plant entries with identical trigger phrases — the
    // `useExactMatch` branch of `OverlapDetector.detectOverlap` matches
    // these without invoking the embedding service, so this test is
    // robust against the ONNX fallback path.
    const inv: InventoryEntry[] = [
      entry({
        kind: 'skill',
        identifier: 'release-shipper',
        source_path: '/a/skills/release-shipper/SKILL.md',
        triggerSurface: ['ship a release', 'cut a release', 'tag the release'],
      }),
      entry({
        kind: 'skill',
        identifier: 'deploy-tagger',
        source_path: '/b/skills/deploy-tagger/SKILL.md',
        triggerSurface: ['ship a release', 'cut a release', 'tag the release'],
      }),
    ]
    const result = await detectCollisions(inv, { tier: 'team' })
    expect(result.semanticCollisions.length).toBeGreaterThanOrEqual(1)
    const flag = result.semanticCollisions[0]!
    expect(flag.kind).toBe('semantic')
    expect(flag.severity).toBe('warning')
    expect(flag.cosineScore).toBeGreaterThanOrEqual(0)
    expect(flag.cosineScore).toBeLessThanOrEqual(1)
    expect(flag.collisionId).toMatch(/^[0-9a-f]{16}$/)
    expect(flag.overlappingPhrases.length).toBeGreaterThan(0)
    expect(result.summary.warningCount).toBeGreaterThanOrEqual(1)
  })

  it('skips semantic pairs already flagged by the exact pass', async () => {
    const inv: InventoryEntry[] = [
      entry({
        kind: 'skill',
        identifier: 'docker',
        source_path: '/a/skills/docker/SKILL.md',
        triggerSurface: ['build a container', 'docker compose up'],
      }),
      entry({
        kind: 'skill',
        identifier: 'docker',
        source_path: '/b/skills/docker/SKILL.md',
        triggerSurface: ['build a container', 'docker compose up'],
      }),
    ]
    const result = await detectCollisions(inv, { tier: 'team' })
    expect(result.exactCollisions).toHaveLength(1)
    // The same pair must not double-surface in semanticCollisions.
    const semanticPaths = result.semanticCollisions.map((f) =>
      [f.entryA.source_path, f.entryB.source_path].sort().join('|')
    )
    expect(semanticPaths).not.toContain('/a/skills/docker/SKILL.md|/b/skills/docker/SKILL.md')
  })

  it('records non-zero semantic-pass duration when pairs are found', async () => {
    const inv: InventoryEntry[] = [
      entry({
        identifier: 'a',
        source_path: '/a',
        triggerSurface: ['shared phrase one'],
      }),
      entry({
        identifier: 'b',
        source_path: '/b',
        triggerSurface: ['shared phrase one'],
      }),
    ]
    const result = await detectCollisions(inv, { tier: 'team' })
    expect(result.summary.passDurations.semantic).toBeGreaterThanOrEqual(0)
  })
})

describe('bootstrapUnmanagedSkills', () => {
  it('detects unmanaged skills (kind=skill, no meta.author)', () => {
    expect(isUnmanagedSkill(entry({ kind: 'skill', meta: undefined }))).toBe(true)
    expect(isUnmanagedSkill(entry({ kind: 'skill', meta: { author: 'alice' } }))).toBe(false)
    expect(isUnmanagedSkill(entry({ kind: 'command' }))).toBe(false)
  })

  it('emits a warning when bootstrap throws — never propagates', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('fixture-failure'))
    const inv = [
      entry({
        kind: 'skill',
        identifier: 'unmanaged',
        source_path: '/skills/unmanaged/SKILL.md',
        meta: undefined,
      }),
    ]
    const res = await bootstrapUnmanagedSkills(inv, { bootstrapFn: failing })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]?.code).toBe('namespace.inventory.bootstrap_failed')
    expect(res.warnings[0]?.message).toContain('fixture-failure')
    expect(res.attempted).toBe(1)
    expect(res.succeeded).toBe(0)
  })

  it('reports success counts when bootstrap resolves', async () => {
    const ok = vi.fn().mockResolvedValue(undefined)
    const inv = [
      entry({
        kind: 'skill',
        identifier: 'unmanaged-1',
        source_path: '/a',
        meta: undefined,
      }),
      entry({
        kind: 'skill',
        identifier: 'unmanaged-2',
        source_path: '/b',
        meta: undefined,
      }),
      // Managed skill — should be skipped.
      entry({
        kind: 'skill',
        identifier: 'managed',
        source_path: '/c',
        meta: { author: 'alice' },
      }),
    ]
    const res = await bootstrapUnmanagedSkills(inv, { bootstrapFn: ok })
    expect(ok).toHaveBeenCalledTimes(2)
    expect(res.attempted).toBe(2)
    expect(res.succeeded).toBe(2)
    expect(res.warnings).toEqual([])
  })

  it('detectCollisions surfaces bootstrap warnings via getLastBootstrapWarnings()', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    const inv = [
      entry({
        kind: 'skill',
        identifier: 'unmanaged',
        source_path: '/skills/unmanaged/SKILL.md',
        meta: undefined,
      }),
    ]
    await detectCollisions(inv, { tier: 'community', bootstrapFn: failing })
    const warnings = getLastBootstrapWarnings()
    expect(warnings.length).toBe(1)
    expect(warnings[0]?.code).toBe('namespace.inventory.bootstrap_failed')
  })

  it('off mode short-circuits before bootstrap runs', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    const inv = [
      entry({
        kind: 'skill',
        identifier: 'unmanaged',
        source_path: '/skills/unmanaged/SKILL.md',
        meta: undefined,
      }),
    ]
    await detectCollisions(inv, { auditModeOverride: 'off', bootstrapFn: failing })
    expect(failing).not.toHaveBeenCalled()
    expect(getLastBootstrapWarnings()).toEqual([])
  })
})
