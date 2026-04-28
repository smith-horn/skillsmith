/**
 * SMI-4188: Tests for scripts/check-publish-collision.mjs.
 *
 * Shares fixtures with prepare-release.test.ts under
 * scripts/tests/fixtures/npm-view/. Drift between the two collision
 * implementations is caught by asserting both pass or both fail on
 * identical fixtures.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { evaluateCollision } from '../check-publish-collision.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures', 'npm-view')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

// Build a fake execFileSync that returns stdout OR throws an error with stderr.
function fakeExec(stdout: string | null, stderr: string | null = null) {
  return (() => {
    if (stderr !== null) {
      const err = new Error('Command failed') as Error & { stderr: string }
      err.stderr = stderr
      throw err
    }
    if (stdout === null) {
      const err = new Error('unexpected') as Error
      throw err
    }
    return stdout
  }) as unknown as typeof import('node:child_process').execFileSync
}

describe('evaluateCollision', () => {
  it('exits 0 when proposed > max and not in versions', () => {
    const exec = fakeExec(loadFixture('core-clean.json'))
    const res = evaluateCollision('@skillsmith/core', '0.5.4', { exec })
    expect(res.code).toBe(0)
    expect(res.message).toContain('safe to publish')
  })

  it('exits 1 when proposed < max and not exact-equal published', () => {
    // core-clean has 0.5.1, 0.5.2, 0.5.3. Target 0.5.0 is not published but < max.
    const exec = fakeExec(loadFixture('core-clean.json'))
    const res = evaluateCollision('@skillsmith/core', '0.5.0', { exec })
    expect(res.code).toBe(1)
    expect(res.message).toContain('highest published')
    expect(res.message).toContain('0.5.3')
  })

  it('exits 1 when proposed is exact-equal a published version (no flag reference)', () => {
    const exec = fakeExec(loadFixture('core-clean.json'))
    const res = evaluateCollision('@skillsmith/core', '0.5.2', { exec })
    expect(res.code).toBe(1)
    expect(res.message).toContain('already published')
    // Diagnostic MUST NOT reference any override / bypass flag.
    expect(res.message).not.toMatch(/override|--allow|--force|bypass|flag/i)
  })

  describe('gating path: proposed < latest AND not exact-equal (plan §2 Step 3 issue #1)', () => {
    it('blocks proposed below latest, not in versions (0.5.0 vs versions=[0.5.1–0.5.3])', () => {
      const exec = fakeExec(loadFixture('core-clean.json'))
      const res = evaluateCollision('@skillsmith/core', '0.5.0', { exec })
      expect(res.code).toBe(1)
    })

    it('blocks proposed exact-equal published (0.5.2 vs versions=[0.5.1–0.5.3])', () => {
      const exec = fakeExec(loadFixture('core-clean.json'))
      const res = evaluateCollision('@skillsmith/core', '0.5.2', { exec })
      expect(res.code).toBe(1)
    })

    it('passes proposed above latest (0.6.0 vs versions=[0.5.1–0.5.3])', () => {
      const exec = fakeExec(loadFixture('core-clean.json'))
      const res = evaluateCollision('@skillsmith/core', '0.6.0', { exec })
      expect(res.code).toBe(0)
    })
  })

  it('handles 2.x overhang fixture: 0.5.4 passes because 2.1.2 is reserved (SMI-4530)', () => {
    // Pre-SMI-4530 this test asserted code=1 because 2.1.2 was treated as a
    // valid "max" anchor. SMI-4207 / ADR-115 declared 2.x permanently
    // reserved on @skillsmith/core; the SMI-4530 fix wires
    // check-publish-collision.mjs into the same shared filter that
    // prepare-release.ts has used since SMI-4207. After the fix, 0.5.4 vs
    // [0.5.1, 0.5.2, 0.5.3, 2.x] computes max from the LIVE pool (0.5.3) and
    // passes. The diagnostic must reference the live max, not 2.1.2.
    const exec = fakeExec(loadFixture('core-2x-overhang.json'))
    const res = evaluateCollision('@skillsmith/core', '0.5.4', { exec })
    expect(res.code).toBe(0)
    expect(res.message).toContain('safe to publish')
    expect(res.message).toContain('0.5.3')
    expect(res.message).not.toContain('2.1.2')
  })

  it('exits 0 on 404 stderr (new package)', () => {
    const exec = fakeExec(null, loadFixture('404-stderr.txt'))
    const res = evaluateCollision('@skillsmith/new-pkg', '0.0.1', { exec })
    expect(res.code).toBe(0)
    expect(res.message).toContain('new package')
  })

  it('exits 1 on network error (ENOTFOUND) — fail closed', () => {
    const exec = fakeExec(null, loadFixture('network-error.txt'))
    const res = evaluateCollision('@skillsmith/core', '0.6.0', { exec })
    expect(res.code).toBe(1)
    expect(res.message).toContain('failed to query npm view')
  })

  it('exits 1 on timeout (treated as generic failure, fail closed)', () => {
    const timeoutExec = (() => {
      const err = new Error('ETIMEDOUT') as Error & { stderr: string; code: string }
      err.stderr = ''
      err.code = 'ETIMEDOUT'
      throw err
    }) as unknown as typeof import('node:child_process').execFileSync
    const res = evaluateCollision('@skillsmith/core', '0.6.0', { exec: timeoutExec })
    expect(res.code).toBe(1)
    expect(res.message).toContain('failed to query npm view')
  })

  // SMI-4530: reserved-range carve-out. These tests pin the contract that
  // check-publish-collision.mjs honors @skillsmith/core's permanently-reserved
  // 2.x range — the same carve-out prepare-release.ts has had since SMI-4207.
  // The drift between these two guards is what blocked PR #824's publish.
  describe('SMI-4530 reserved-range carve-out (@skillsmith/core 2.x)', () => {
    it('skips reserved 2.x range when computing max for @skillsmith/core (proposed 0.5.7)', () => {
      // Mirrors PR #824's release: live 0.5.6 + orphaned 2.x. 0.5.7 must pass.
      const exec = fakeExec(loadFixture('core-2x-overhang.json'))
      const res = evaluateCollision('@skillsmith/core', '0.5.7', { exec })
      expect(res.code).toBe(0)
      expect(res.message).toContain('safe to publish')
      // Diagnostic must reference the LIVE max (0.5.3 in fixture), not 2.1.2.
      expect(res.message).toContain('0.5.3')
      expect(res.message).not.toContain('2.1.2')
    })

    it('refuses target inside reserved range with ADR-115 pointer', () => {
      const exec = fakeExec(loadFixture('core-2x-overhang.json'))
      const res = evaluateCollision('@skillsmith/core', '2.1.3', { exec })
      expect(res.code).toBe(1)
      expect(res.message).toContain('ADR-115')
      expect(res.message).toContain('reserved 2.x range')
    })

    it('refuses target equal to a reserved-range published version (full-list check)', () => {
      // 2.1.2 is both reserved AND already published. Either branch may catch
      // it; both produce code=1. We assert code=1 and that the message names
      // the version 2.1.2 so the operator knows what was rejected.
      const exec = fakeExec(loadFixture('core-2x-overhang.json'))
      const res = evaluateCollision('@skillsmith/core', '2.1.2', { exec })
      expect(res.code).toBe(1)
      expect(res.message).toContain('2.1.2')
    })

    it('does not apply reserved-range carve-out to other packages (mcp-server)', () => {
      // Synthetic fixture: hypothetical mcp-server with a 2.0.0 that is NOT
      // reserved. Target 0.4.13 must be refused (because 2.0.0 > 0.4.13).
      const synthetic = JSON.stringify(['0.4.12', '2.0.0'])
      const exec = fakeExec(synthetic)
      const res = evaluateCollision('@skillsmith/mcp-server', '0.4.13', { exec })
      expect(res.code).toBe(1)
      expect(res.message).toContain('2.0.0')
    })

    it('handles package whose entire published history is in reserved range', () => {
      // Synthetic: @skillsmith/core with only 2.x entries (live history empty).
      const synthetic = JSON.stringify(['2.0.0', '2.1.0', '2.1.2'])
      const exec = fakeExec(synthetic)
      const res = evaluateCollision('@skillsmith/core', '0.5.7', { exec })
      expect(res.code).toBe(0)
      expect(res.message).toMatch(/no live versions published yet/i)
    })

    it('preserves npm view E404 fail-open semantics post-refactor', () => {
      // E404 must short-circuit BEFORE the new filter logic runs.
      const exec = fakeExec(null, loadFixture('404-stderr.txt'))
      const res = evaluateCollision('@skillsmith/core', '0.5.7', { exec })
      expect(res.code).toBe(0)
      expect(res.message).toContain('new package')
    })

    it('preserves npm view parse-error fail-closed semantics post-refactor', () => {
      // Malformed JSON output → parse error → code=1 ("failed to parse").
      const exec = fakeExec('not valid json {{{')
      const res = evaluateCollision('@skillsmith/core', '0.5.7', { exec })
      expect(res.code).toBe(1)
      expect(res.message).toContain('failed to parse')
    })
  })
})
