/**
 * Unit tests for SMI-4588 Wave 2 Step 2 — `generateSuggestionChain`.
 * PR #2 of the Wave 2 stack.
 *
 * Coverage (decision #11 — 3-tier fall-through):
 *   1. Tier 1 wins when `${author}-${token}` is collision-free.
 *   2. Tier 2 wins when tier 1 collides; packDomain segment included.
 *   3. Tier 3 wins when tiers 1 and 2 both collide; shortHash suffix added.
 *   4. All tiers exhaust → `exhausted: true` and full chain returned.
 *   5. `packDomain` absent → tier 2 skipped (deduped against tier 3).
 *   6. `shortHash` is deterministic — same input produces same output.
 *   7. Pre-candidate inventory contract — candidate skill must NOT be in
 *      the inventory (Edit 7).
 *   8. No author + no tag fallback → `local-` prefix (plan §1 path 3).
 */

import { describe, expect, it } from 'vitest'

import type { InventoryEntry } from '../../src/audit/collision-detector.types.js'
import {
  computeShortHash,
  generateSuggestionChain,
  sanitizeSegment,
} from '../../src/audit/suggestion-chain.js'

const entry = (identifier: string, kind: InventoryEntry['kind'] = 'command'): InventoryEntry => ({
  kind,
  source_path: `/tmp/${identifier}.md`,
  identifier,
  triggerSurface: [identifier],
})

describe('sanitizeSegment', () => {
  it('lowercases and replaces non-alphanumerics', () => {
    expect(sanitizeSegment('Anthropic Inc.')).toBe('anthropic-inc')
  })
  it('dedupes consecutive separators', () => {
    expect(sanitizeSegment('foo  bar___baz')).toBe('foo-bar-baz')
  })

  // SMI-4733 ReDoS hardening: defense-in-depth length cap at 256 chars.
  // Two of four callers (`token`, `packDomain`) have no upstream cap;
  // unbounded input on the regex chain below caused polynomial backtracking
  // (CodeQL alert 93). CodeQL re-scan is the regression gate; here we
  // assert correctness.
  it('accepts 256-char input at boundary', () => {
    const input = 'a'.repeat(256)
    expect(sanitizeSegment(input)).toBe(input)
  })

  it('returns empty string on input > 256 chars; chain falls through that tier', () => {
    expect(sanitizeSegment('a'.repeat(257))).toBe('')

    // Over-long `packDomain` must not throw; the suggestion chain falls
    // through to the no-packDomain shape (tier 1 + tier 3 only) per the
    // existing empty-segment behavior in `generateSuggestionChain`.
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: 'x'.repeat(300),
      authorPath: '/repo/x',
      existingInventory: [],
    })
    expect(result.candidates[0]).toBe('anthropic-ship')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[1]).toMatch(/^anthropic-ship-[0-9a-f]{4}$/)
    expect(result.exhausted).toBe(false)
  })

  it('handles 200 dashes (correctness; no timing assertion)', () => {
    expect(sanitizeSegment('-'.repeat(200) + 'x')).toBe('x')
  })
})

describe('computeShortHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeShortHash('/path/to/skill', 'ship', 'codehelper')
    const b = computeShortHash('/path/to/skill', 'ship', 'codehelper')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{4}$/)
  })
  it('differs across inputs', () => {
    const a = computeShortHash('/p1', 'ship', 'a')
    const b = computeShortHash('/p2', 'ship', 'a')
    expect(a).not.toBe(b)
  })
})

describe('generateSuggestionChain', () => {
  it('tier 1 wins when ${author}-${token} is collision-free', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: 'codehelper',
      authorPath: '/repo/anthropic/codehelper',
      existingInventory: [entry('ship'), entry('release')],
    })
    expect(result.exhausted).toBe(false)
    expect(result.candidates[0]).toBe('anthropic-ship')
    expect(result.candidates).toHaveLength(3)
    // Walk: tier 1 does not collide → recommended is tier 1.
    expect(result.candidates[0]).toBe('anthropic-ship')
  })

  it('tier 2 wins when tier 1 collides; packDomain segment included', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: 'codehelper',
      authorPath: '/repo/anthropic/codehelper',
      existingInventory: [entry('anthropic-ship')],
    })
    expect(result.candidates[0]).toBe('anthropic-ship')
    expect(result.candidates[1]).toBe('anthropic-codehelper-ship')
    expect(result.exhausted).toBe(false)
  })

  it('tier 3 wins when tiers 1 and 2 collide; shortHash suffix added', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: 'codehelper',
      authorPath: '/repo/anthropic/codehelper',
      existingInventory: [entry('anthropic-ship'), entry('anthropic-codehelper-ship')],
    })
    expect(result.candidates[2]).toMatch(/^anthropic-codehelper-ship-[0-9a-f]{4}$/)
    expect(result.exhausted).toBe(false)
  })

  it('all tiers exhausted → exhausted: true', () => {
    const hash = computeShortHash('/repo/x', 'ship', 'codehelper')
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: 'codehelper',
      authorPath: '/repo/x',
      existingInventory: [
        entry('anthropic-ship'),
        entry('anthropic-codehelper-ship'),
        entry(`anthropic-codehelper-ship-${hash}`),
      ],
    })
    expect(result.exhausted).toBe(true)
    expect(result.candidates).toHaveLength(3)
  })

  it('packDomain absent → tier 2 skipped, deduped vs tier 3', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: null,
      authorPath: '/repo/x',
      existingInventory: [],
    })
    // Tier 1 always emitted; tier 2 absent (no packDomain); tier 3 keeps
    // shortHash suffix without the packDomain segment.
    expect(result.candidates[0]).toBe('anthropic-ship')
    // Two candidates total — tier 2 is null, dedupe handles overlap.
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[1]).toMatch(/^anthropic-ship-[0-9a-f]{4}$/)
  })

  it('no author and no tag fallback → local- prefix', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: null,
      packDomain: null,
      authorPath: '/repo/x',
      existingInventory: [],
    })
    expect(result.candidates[0]).toBe('local-ship')
    expect(result.exhausted).toBe(false)
  })

  it('falls back to tagFallback when author is null', () => {
    const result = generateSuggestionChain({
      token: 'ship',
      author: null,
      tagFallback: 'release-tools',
      packDomain: null,
      authorPath: '/repo/x',
      existingInventory: [],
    })
    expect(result.candidates[0]).toBe('release-tools-ship')
  })

  it('candidate skill is NOT in pre-candidate inventory (Edit 7)', () => {
    // The candidate skill itself ("ship") MUST be excluded from the
    // inventory — otherwise tier 1 would self-collide.
    const result = generateSuggestionChain({
      token: 'ship',
      author: 'anthropic',
      packDomain: null,
      authorPath: '/repo/x',
      // Critically: NOT including entry('ship') here.
      existingInventory: [entry('release')],
    })
    expect(result.candidates[0]).toBe('anthropic-ship')
    expect(result.exhausted).toBe(false)
  })

  it('empty token → empty candidates + exhausted', () => {
    const result = generateSuggestionChain({
      token: '...',
      author: 'anthropic',
      packDomain: null,
      authorPath: '/repo/x',
      existingInventory: [],
    })
    expect(result.candidates).toHaveLength(0)
    expect(result.exhausted).toBe(true)
  })
})
