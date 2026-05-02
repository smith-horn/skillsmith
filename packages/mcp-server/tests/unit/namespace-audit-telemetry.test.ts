/**
 * Unit tests for SMI-4587 Wave 1 Step 8a — server telemetry emitter.
 *
 * Decision #7: aggregate-only. Negative-space assertions are the
 * load-bearing tests here — the body must NOT contain `auditId`, file
 * paths, identifiers, skill names, or any other free-form text from the
 * user's filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  emitAuditCompleteEvent,
  type AuditCompleteContext,
} from '../../src/tools/namespace-audit/telemetry.js'
import { newAuditId } from '../../src/audit/audit-history.js'
import type {
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  SemanticCollisionFlag,
} from '../../src/audit/collision-detector.types.js'
import type { InventoryEntry } from '../../src/utils/local-inventory.types.js'

function entry(overrides: Partial<InventoryEntry>): InventoryEntry {
  return {
    kind: 'skill',
    source_path: '/Users/me/.claude/skills/secret-skill/SKILL.md',
    identifier: 'secret-skill',
    triggerSurface: ['ship the rocket'],
    ...overrides,
  }
}

function resultWithEverything(): InventoryAuditResult {
  const a = entry({ source_path: '/abs/a/SKILL.md', identifier: 'docker' })
  const b = entry({ source_path: '/abs/b/SKILL.md', identifier: 'docker' })
  const c = entry({ source_path: '/abs/c/SKILL.md', identifier: 'run' })
  const d = entry({ source_path: '/abs/d/SKILL.md', identifier: 'release-shipper' })
  const e = entry({ source_path: '/abs/e/SKILL.md', identifier: 'deploy-tagger' })

  const exactFlag: ExactCollisionFlag = {
    kind: 'exact',
    collisionId: 'cafef00d12345678' as ExactCollisionFlag['collisionId'],
    identifier: 'docker',
    entries: [a, b],
    severity: 'error',
    reason: 'identifier collision',
  }
  const genericFlag: GenericTokenFlag = {
    kind: 'generic',
    collisionId: 'deadbeefdeadbeef' as GenericTokenFlag['collisionId'],
    identifier: 'run',
    entry: c,
    matchedTokens: ['run'],
    severity: 'warning',
    reason: 'matches stoplist',
  }
  const semFlag: SemanticCollisionFlag = {
    kind: 'semantic',
    collisionId: '00112233aabbccdd' as SemanticCollisionFlag['collisionId'],
    entryA: d,
    entryB: e,
    cosineScore: 0.9,
    overlappingPhrases: [
      { phrase1: 'tag the release', phrase2: 'cut a release', similarity: 0.91 },
    ],
    severity: 'warning',
    reason: 'overlap above threshold',
  }

  return {
    auditId: newAuditId(),
    inventory: [a, b, c, d, e],
    exactCollisions: [exactFlag],
    genericFlags: [genericFlag],
    semanticCollisions: [semFlag],
    summary: {
      totalEntries: 5,
      totalFlags: 3,
      errorCount: 1,
      warningCount: 2,
      durationMs: 12.34,
      passDurations: { exact: 1, generic: 2, semantic: 9.34 },
    },
  }
}

const baseCtx: AuditCompleteContext = {
  tier: 'community',
  audit_mode: 'preventative',
  resolved_auto: 0,
  resolved_manual: 0,
  resolved_skipped: 0,
  user_id: null,
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  delete process.env.SKILLSMITH_TELEMETRY
  delete process.env.SKILLSMITH_API_URL
  delete process.env.SKILLSMITH_API_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.SKILLSMITH_TELEMETRY
  delete process.env.SKILLSMITH_API_URL
  delete process.env.SKILLSMITH_API_KEY
})

describe('emitAuditCompleteEvent — short-circuit behaviour', () => {
  it('audit_mode=off → no fetch, returns null (decision #7 defense-in-depth)', async () => {
    const ret = await emitAuditCompleteEvent(
      resultWithEverything(),
      { ...baseCtx, audit_mode: 'off' },
      { fetchImpl: fetchSpy as unknown as typeof fetch }
    )
    expect(ret).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('SKILLSMITH_TELEMETRY=0 → no fetch', async () => {
    process.env.SKILLSMITH_TELEMETRY = '0'
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('SKILLSMITH_TELEMETRY=off → no fetch', async () => {
    process.env.SKILLSMITH_TELEMETRY = 'off'
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('emitAuditCompleteEvent — preventative mode payload shape', () => {
  it('emits exactly one fetch with aggregate-only metadata', async () => {
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://api.skillsmith.app/functions/v1/events')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit & { body: string }).body) as {
      event: string
      anonymous_id: string | null
      metadata: Record<string, unknown>
    }
    expect(body.event).toBe('namespace_audit_complete')
    expect(body.metadata.tier).toBe('community')
    expect(body.metadata.audit_mode).toBe('preventative')
    expect(body.metadata.collisions).toEqual({ exact: 1, generic: 1, semantic: 1 })
    expect(body.metadata.resolved_auto).toBe(0)
    expect(body.metadata.resolved_manual).toBe(0)
    expect(body.metadata.resolved_skipped).toBe(0)
  })

  it('omits user_id when null (aggregate-only default)', async () => {
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit & { body: string }).body
    ) as { metadata: Record<string, unknown> }
    expect(body.metadata).not.toHaveProperty('user_id')
  })

  it('includes user_id when caller passes a hashed actor proxy', async () => {
    await emitAuditCompleteEvent(
      resultWithEverything(),
      { ...baseCtx, user_id: 'hashed-actor-deadbeef' },
      { fetchImpl: fetchSpy as unknown as typeof fetch }
    )
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit & { body: string }).body
    ) as { metadata: Record<string, unknown> }
    expect(body.metadata.user_id).toBe('hashed-actor-deadbeef')
  })

  it('hashes API key into anonymous_id (sha256 hex, never raw key)', async () => {
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      apiKey: 'sk_live_super_secret_token_12345',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit & { body: string }).body
    ) as { anonymous_id: string }
    expect(body.anonymous_id).toMatch(/^[0-9a-f]{64}$/)
    expect(body.anonymous_id).not.toContain('sk_live')
    expect(body.anonymous_id).not.toContain('super_secret')
  })

  it('falls back to anonymous_id=null when no API key is available', async () => {
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      apiKey: null,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit & { body: string }).body
    ) as { anonymous_id: string | null }
    expect(body.anonymous_id).toBeNull()
  })

  it('respects SKILLSMITH_API_URL override', async () => {
    process.env.SKILLSMITH_API_URL = 'https://staging.skillsmith.app'
    await emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://staging.skillsmith.app/functions/v1/events',
      expect.any(Object)
    )
  })

  it('swallows fetch errors — telemetry never breaks the audit', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(
      emitAuditCompleteEvent(resultWithEverything(), baseCtx, {
        fetchImpl: failing as unknown as typeof fetch,
      })
    ).resolves.not.toThrow()
    expect(failing).toHaveBeenCalledTimes(1)
  })
})

describe('emitAuditCompleteEvent — negative-space (decision #7)', () => {
  // Load-bearing assertions: payload MUST NOT leak any user-filesystem
  // identifiers, paths, skill names, or auditId into the telemetry stream.
  it('payload contains no auditId / paths / identifiers / skill names', async () => {
    const result = resultWithEverything()
    await emitAuditCompleteEvent(result, baseCtx, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })
    const rawBody = (fetchSpy.mock.calls[0]![1] as RequestInit & { body: string }).body

    // auditId never crosses the boundary.
    expect(rawBody).not.toContain(result.auditId)

    // None of the absolute paths from inventory leak.
    for (const e of result.inventory) {
      expect(rawBody).not.toContain(e.source_path)
      expect(rawBody).not.toContain(e.identifier)
    }

    // Collision-flag identifiers don't leak either.
    expect(rawBody).not.toContain('docker')
    expect(rawBody).not.toContain('release-shipper')
    expect(rawBody).not.toContain('deploy-tagger')

    // No collisionIds.
    expect(rawBody).not.toContain('cafef00d12345678')
    expect(rawBody).not.toContain('deadbeefdeadbeef')
    expect(rawBody).not.toContain('00112233aabbccdd')

    // No overlapping-phrase free text.
    expect(rawBody).not.toContain('tag the release')
    expect(rawBody).not.toContain('cut a release')
    expect(rawBody).not.toContain('matches stoplist')
    expect(rawBody).not.toContain('overlap above threshold')

    // What MUST be present: aggregate counts + tier + audit_mode.
    expect(rawBody).toContain('"namespace_audit_complete"')
    expect(rawBody).toContain('"exact":1')
    expect(rawBody).toContain('"generic":1')
    expect(rawBody).toContain('"semantic":1')
    expect(rawBody).toContain('"tier":"community"')
    expect(rawBody).toContain('"audit_mode":"preventative"')
  })
})
