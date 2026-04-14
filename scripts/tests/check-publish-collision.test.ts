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

  it('handles 2.x overhang fixture (production reality: 2.1.2 > 0.5.3)', () => {
    const exec = fakeExec(loadFixture('core-2x-overhang.json'))
    // Target 0.5.4 is < 2.1.2 overhang — must still block.
    const res = evaluateCollision('@skillsmith/core', '0.5.4', { exec })
    expect(res.code).toBe(1)
    expect(res.message).toContain('2.1.2')
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
})
