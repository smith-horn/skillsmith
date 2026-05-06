/**
 * Tests for the realpath-asymmetry detector (Check 41 in audit-standards.mjs).
 * SMI-4758
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - .mjs helper has no typings
import { findRealpathAsymmetry } from '../audit-realpath-asymmetry-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(__dirname, 'fixtures', 'realpath-asymmetry')
const read = (name: string) => readFileSync(join(FIXTURE_DIR, name), 'utf8')

describe('findRealpathAsymmetry', () => {
  describe('should-flag fixtures (regression-prevention)', () => {
    it('flags SMI-4688 pre-fix skill-pack-audit pattern', () => {
      const content = read('should-flag-skill-pack-audit.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        op: 'startsWith',
      })
      const operands = [violations[0].lhs, violations[0].rhs].sort()
      expect(operands).toEqual(['packPath', 'resolvedMdPath'])
    })

    it('flags SMI-4692 pre-fix skill-installation.service pattern', () => {
      const content = read('should-flag-skill-installation-service.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      // Both startsWith and !== fire on the same logical asymmetry.
      expect(violations.length).toBeGreaterThanOrEqual(1)
      const startsWithViolation = violations.find((v) => v.op === 'startsWith')
      expect(startsWithViolation).toBeDefined()
      const operands = [startsWithViolation!.lhs, startsWithViolation!.rhs].sort()
      expect(operands).toEqual(['expectedPrefix', 'realInstallPath'])
    })
  })

  describe('should-pass fixtures (current production patterns)', () => {
    it('passes current skill-pack-audit (post-fix, both sides realpath)', () => {
      const content = read('should-pass-current-skill-pack-audit.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toEqual([])
    })

    it('passes try-catch deferred-assignment realpath pattern', () => {
      const content = read('should-pass-try-catch-reassignment.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toEqual([])
    })

    it('passes when audit-allow:realpath-asymmetry suppression comment is present', () => {
      const content = read('should-pass-suppression-comment.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toEqual([])
    })

    it('passes when suppression comment sits above a multi-line if (lookback 4)', () => {
      const content = read('should-pass-suppression-multiline-if.ts.fixture')
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toEqual([])
    })
  })

  describe('operator labeling', () => {
    it('reports the actual operator (=== vs !==) in violations', () => {
      const content = `
import { promises as fs } from 'fs'
import { resolve } from 'path'
async function f(a: string, b: string) {
  const real = await fs.realpath(a)
  const raw = resolve(b)
  if (real !== raw) return false
  return true
}
`
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      const eqViolation = violations.find((v) => v.op === '!==' || v.op === '===')
      expect(eqViolation).toBeDefined()
      expect(eqViolation?.op).toBe('!==')
    })
  })

  describe('quick reject', () => {
    it('returns no violations when file does not mention realpath', () => {
      const content = `
import { resolve } from 'path'
const a = resolve('/foo')
const b = resolve('/bar')
if (a.startsWith(b)) console.log('hi')
`
      const { violations } = findRealpathAsymmetry(content, 'fixture')
      expect(violations).toEqual([])
    })
  })
})
