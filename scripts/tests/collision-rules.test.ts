/**
 * SMI-4531: Tests for scripts/lib/collision-rules.mjs.
 *
 * Pin the canonical error strings as a stable contract — both
 * scripts/check-publish-collision.mjs and scripts/prepare-release.ts now
 * consume this module. Drift between those two implementations was the
 * SMI-4530 failure mode and must not return.
 *
 * MUTATION SAFEGUARD — DO NOT EDIT THESE STRINGS WITHOUT AN SMI REF:
 *
 *   Rule 1: "${pkg}: proposed ${target} falls inside the reserved 2.x range
 *           (>=2.0.0 <3.0.0). This range is permanently deprecated on npm —
 *           the next major must jump to 3.0.0 or later. No override flag
 *           applies. See ADR-115 (...)."
 *
 *   Rule 3: "${pkg}: proposed ${target} is already published on npm (highest
 *           published: ${maxForDiagnostic | "(none — all reserved)"}).
 *           Different content under the same version is the failure mode
 *           this guard exists to prevent. Revert to release, do not override."
 *
 *   Rule 2: "${pkg}: proposed ${target} <= highest published ${liveMax}.
 *           Note: "highest published" spans all dist-tags — npm refuses to
 *           republish any existing semver. Suggested next-available:
 *           ${suggested}. To override (TS only): pass --allow-downgrade."
 */
import { describe, it, expect } from 'vitest'

import {
  evaluateReservedRange,
  evaluateAlreadyPublished,
  evaluateLiveMax,
  evaluateCollisionRules,
} from '../lib/collision-rules.mjs'

// ---------------------------------------------------------------------------
// Rule 1: reserved-range refuse
// ---------------------------------------------------------------------------

describe('evaluateReservedRange (Rule 1)', () => {
  it('passes for non-reserved versions', () => {
    expect(evaluateReservedRange('@skillsmith/core', '0.5.7')).toEqual({ ok: true })
    expect(evaluateReservedRange('@skillsmith/core', '3.0.0')).toEqual({ ok: true })
    expect(evaluateReservedRange('@skillsmith/mcp-server', '2.5.0')).toEqual({ ok: true })
  })

  it('passes for invalid semver (caller surfaces a separate error)', () => {
    expect(evaluateReservedRange('@skillsmith/core', 'not-a-version')).toEqual({ ok: true })
  })

  it('refuses @skillsmith/core inside the reserved 2.x range with the canonical message', () => {
    const res = evaluateReservedRange('@skillsmith/core', '2.5.0')
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ ok: false })
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: proposed 2.5.0 falls inside the reserved 2.x range (>=2.0.0 <3.0.0). ' +
        'This range is permanently deprecated on npm — the next major must jump to 3.0.0 or later. ' +
        'No override flag applies. See ADR-115 (docs/internal/adr/115-skillsmith-core-version-namespace-reconciliation.md).'
    )
  })

  it('refuses at both range boundaries (2.0.0 and 2.99.99)', () => {
    expect(evaluateReservedRange('@skillsmith/core', '2.0.0').ok).toBe(false)
    expect(evaluateReservedRange('@skillsmith/core', '2.99.99').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 3: already-published refuse
// ---------------------------------------------------------------------------

describe('evaluateAlreadyPublished (Rule 3)', () => {
  it('passes when target is not in allVersions', () => {
    expect(evaluateAlreadyPublished('@skillsmith/core', '0.5.10', ['0.5.7', '0.5.8'])).toEqual({
      ok: true,
    })
  })

  it('refuses with the canonical message when target is already published', () => {
    const res = evaluateAlreadyPublished('@skillsmith/core', '0.5.7', ['0.5.6', '0.5.7', '0.5.8'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: proposed 0.5.7 is already published on npm (highest published: 0.5.8). ' +
        'Different content under the same version is the failure mode this guard exists to prevent. ' +
        'Revert to release, do not override.'
    )
    expect(res.maxForDiagnostic).toBe('0.5.8')
  })

  it('uses live max (post-reserved-filter) for the diagnostic when both live and reserved entries exist', () => {
    const res = evaluateAlreadyPublished('@skillsmith/core', '0.5.7', [
      '0.5.6',
      '0.5.7',
      '2.0.0',
      '2.1.2',
    ])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    // live = [0.5.6, 0.5.7]; max = 0.5.7
    expect(res.message).toContain('highest published: 0.5.7')
    expect(res.maxForDiagnostic).toBe('0.5.7')
  })

  it('renders "(none — all reserved)" when every published entry sits in the reserved range', () => {
    // Synthetic: target equals one of the reserved entries; nothing live to anchor.
    const res = evaluateAlreadyPublished('@skillsmith/core', '2.1.2', ['2.0.0', '2.1.0', '2.1.2'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: proposed 2.1.2 is already published on npm (highest published: (none — all reserved)). ' +
        'Different content under the same version is the failure mode this guard exists to prevent. ' +
        'Revert to release, do not override.'
    )
  })

  it('does not refuse when allVersions is empty', () => {
    expect(evaluateAlreadyPublished('@skillsmith/core', '1.0.0', [])).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Rule 2: live-max <= refuse (with --allow-downgrade override hook)
// ---------------------------------------------------------------------------

describe('evaluateLiveMax (Rule 2)', () => {
  it('passes when proposed > live max', () => {
    expect(evaluateLiveMax('@skillsmith/core', '0.5.10', ['0.5.7', '0.5.8'])).toEqual({ ok: true })
  })

  it('passes when live pool is empty', () => {
    expect(evaluateLiveMax('@skillsmith/core', '1.0.0', [])).toEqual({ ok: true })
  })

  it('refuses with the canonical message when proposed <= live max', () => {
    const res = evaluateLiveMax('@skillsmith/core', '0.5.5', ['0.5.7', '0.5.8'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: proposed 0.5.5 <= highest published 0.5.8. ' +
        'Note: "highest published" spans all dist-tags — npm refuses to republish any existing semver. ' +
        'Suggested next-available: 0.5.9. ' +
        'To override (TS only): pass --allow-downgrade.'
    )
    expect(res.suggestedNext).toBe('0.5.9')
  })

  it('honors allowDowngrade=true', () => {
    expect(
      evaluateLiveMax('@skillsmith/core', '0.5.5', ['0.5.7', '0.5.8'], { allowDowngrade: true })
    ).toEqual({ ok: true })
  })

  it('passes for invalid semver targets (caller surfaces separately)', () => {
    expect(evaluateLiveMax('@skillsmith/core', 'garbage', ['0.5.7'])).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// evaluateCollisionRules — orchestrator: precedence 1 → 3 → 2
// ---------------------------------------------------------------------------

describe('evaluateCollisionRules (orchestrator)', () => {
  it('Rule 1 wins over Rule 3 (reserved AND already-published)', () => {
    // 2.1.2 is reserved AND published — Rule 1 message must win.
    const res = evaluateCollisionRules('@skillsmith/core', '2.1.2', ['2.0.0', '2.1.2'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.rule).toBe(1)
    expect(res.message).toContain('falls inside the reserved 2.x range')
  })

  it('Rule 3 wins over Rule 2 (already-published AND <= live max)', () => {
    // 0.5.7 is published AND <= live max 0.5.8 — Rule 3 must win.
    const res = evaluateCollisionRules('@skillsmith/core', '0.5.7', ['0.5.6', '0.5.7', '0.5.8'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.rule).toBe(3)
    expect(res.message).toContain('already published on npm')
  })

  it('Rule 2 fires when Rules 1 and 3 pass but proposed <= live max', () => {
    const res = evaluateCollisionRules('@skillsmith/core', '0.5.5', ['0.5.6', '0.5.7', '0.5.8'])
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.rule).toBe(2)
    expect(res.suggestedNext).toBe('0.5.9')
  })

  it('passes with proceed message when target > live max and not reserved or published', () => {
    const res = evaluateCollisionRules('@skillsmith/core', '0.5.10', ['0.5.7', '0.5.8'])
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: proposed 0.5.10 > highest published 0.5.8, safe to publish'
    )
  })

  it('passes with "all reserved" proceed message when no live anchor exists', () => {
    // Synthetic case: every published entry is reserved, target is fresh + non-reserved.
    const res = evaluateCollisionRules('@skillsmith/core', '0.5.10', ['2.0.0', '2.1.2'])
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.message).toBe(
      '@skillsmith/core: no live versions published yet (all entries inside reserved range), proceeding'
    )
  })

  it('honors allowDowngrade only for Rule 2 (Rules 1 and 3 still refuse)', () => {
    // Rule 1 still refuses with allowDowngrade=true.
    expect(
      evaluateCollisionRules('@skillsmith/core', '2.5.0', [], { allowDowngrade: true }).ok
    ).toBe(false)
    // Rule 3 still refuses with allowDowngrade=true.
    expect(
      evaluateCollisionRules('@skillsmith/core', '0.5.7', ['0.5.7', '0.5.8'], {
        allowDowngrade: true,
      }).ok
    ).toBe(false)
    // Rule 2 passes with allowDowngrade=true.
    expect(
      evaluateCollisionRules('@skillsmith/core', '0.5.5', ['0.5.7', '0.5.8'], {
        allowDowngrade: true,
      }).ok
    ).toBe(true)
  })

  it('handles a non-reserved package (no Rule 1 carve-out applies)', () => {
    // @skillsmith/mcp-server has no reserved range; 2.5.0 is fine.
    const res = evaluateCollisionRules('@skillsmith/mcp-server', '0.5.0', ['0.4.12', '0.4.13'])
    expect(res.ok).toBe(true)
  })
})
