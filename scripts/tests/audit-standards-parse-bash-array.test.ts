/**
 * Tests for `parseBashArray` in audit-standards-helpers.mjs.
 *
 * Check 47 (edge-function registration coherence, SMI-4963) parses five Bash
 * array declarations across two shell scripts. This test file verifies the
 * helper is correct for the full range of expected and edge-case inputs.
 *
 * Governance retro follow-up (SMI-4963 PR B): parseBashArray was originally
 * inlined inside Check 47. It was extracted to helpers.mjs so it can be
 * unit-tested here, matching the convention established by Check 46's
 * findUnsafeSkillsRecreateMigrations.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseBashArray: (src: string, arrayName: string) => Set<string> | null
}

const { parseBashArray } = helpers

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Wrap entries in a canonical multiline Bash array declaration. */
function mkArray(name: string, entries: string[]): string {
  const body = entries.map((e) => `  ${e}`).join('\n')
  return `${name}=(\n${body}\n)\n`
}

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------

describe('parseBashArray', () => {
  it('parses bare-word hyphenated entries', () => {
    const src = mkArray('MY_ARRAY', ['early-access-signup', 'skills-search', 'auth-device-code'])
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'auth-device-code',
      'early-access-signup',
      'skills-search',
    ])
  })

  it('parses entries with underscore (valid Supabase name)', () => {
    const src = mkArray('MY_ARRAY', ['my_function', 'another_fn'])
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['another_fn', 'my_function'])
  })

  it('strips inline # comments', () => {
    const src = `MY_ARRAY=(\n  foo  # this is a comment\n  bar\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['bar', 'foo'])
  })

  it('skips blank lines inside the array', () => {
    const src = `MY_ARRAY=(\n  foo\n\n  bar\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['bar', 'foo'])
  })

  it('parses double-quoted entries', () => {
    const src = `MY_ARRAY=(\n  "foo-bar"\n  "baz"\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['baz', 'foo-bar'])
  })

  it('parses single-quoted entries', () => {
    const src = `MY_ARRAY=(\n  'foo-bar'\n  'baz'\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['baz', 'foo-bar'])
  })

  // -------------------------------------------------------------------------
  // Empty array
  // -------------------------------------------------------------------------

  it('returns an empty Set for an empty array body', () => {
    const src = `MY_ARRAY=(\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect(result!.size).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Null cases (malformed input)
  // -------------------------------------------------------------------------

  it('returns null when the array is not present', () => {
    const src = 'OTHER_ARRAY=(\n  foo\n)\n'
    expect(parseBashArray(src, 'MY_ARRAY')).toBeNull()
  })

  it('returns null when the array has no multiline body (inline empty)', () => {
    // e.g. MY_ARRAY=() — no newline after (
    const src = 'MY_ARRAY=()\n'
    expect(parseBashArray(src, 'MY_ARRAY')).toBeNull()
  })

  it('returns null when the closing ) is missing', () => {
    const src = 'MY_ARRAY=(\n  foo\n  bar\n'
    expect(parseBashArray(src, 'MY_ARRAY')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Real-file integration: parse all five arrays from actual scripts
  // -------------------------------------------------------------------------

  it('parses NO_VERIFY_JWT_FUNCTIONS from deploy-edge-functions.sh', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('scripts/deploy-edge-functions.sh', 'utf8')
    const result = parseBashArray(src, 'NO_VERIFY_JWT_FUNCTIONS')
    expect(result).not.toBeNull()
    expect(result!.size).toBeGreaterThan(0)
    // Spot-check a known entry
    expect(result!.has('skills-search')).toBe(true)
  })

  it('parses VERIFY_JWT_FUNCTIONS from deploy-edge-functions.sh', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('scripts/deploy-edge-functions.sh', 'utf8')
    const result = parseBashArray(src, 'VERIFY_JWT_FUNCTIONS')
    expect(result).not.toBeNull()
    expect(result!.size).toBeGreaterThan(0)
    expect(result!.has('indexer')).toBe(true)
  })

  it('parses ANONYMOUS_FUNCTIONS from validate-edge-functions.sh', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('scripts/validate-edge-functions.sh', 'utf8')
    const result = parseBashArray(src, 'ANONYMOUS_FUNCTIONS')
    expect(result).not.toBeNull()
    expect(result!.size).toBeGreaterThan(0)
    expect(result!.has('health')).toBe(true)
  })

  it('parses AUTHENTICATED_FUNCTIONS from validate-edge-functions.sh', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('scripts/validate-edge-functions.sh', 'utf8')
    const result = parseBashArray(src, 'AUTHENTICATED_FUNCTIONS')
    expect(result).not.toBeNull()
    expect(result!.size).toBeGreaterThan(0)
    expect(result!.has('webhook-dlq')).toBe(true)
  })

  it('parses SERVICE_ROLE_FUNCTIONS from validate-edge-functions.sh', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('scripts/validate-edge-functions.sh', 'utf8')
    const result = parseBashArray(src, 'SERVICE_ROLE_FUNCTIONS')
    expect(result).not.toBeNull()
    expect(result!.size).toBeGreaterThan(0)
    expect(result!.has('indexer')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  it('deduplicates repeated entries (returns Set not Array)', () => {
    const src = `MY_ARRAY=(\n  foo\n  foo\n  bar\n)\n`
    const result = parseBashArray(src, 'MY_ARRAY')
    expect(result).not.toBeNull()
    expect(result!.size).toBe(2)
    expect([...result!].sort()).toEqual(['bar', 'foo'])
  })
})
