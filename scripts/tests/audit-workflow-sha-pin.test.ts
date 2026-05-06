/**
 * Tests for the GitHub Actions SHA-pin detector (Check 42 in audit-standards.mjs).
 * SMI-4758
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - .mjs helper has no typings
import { findUnpinnedActionUses } from '../audit-workflow-sha-pin-helpers.mjs'

const FIXTURE_DIR = join(__dirname, 'fixtures', 'workflow-sha-pin')
const read = (name: string) => readFileSync(join(FIXTURE_DIR, name), 'utf8')

describe('findUnpinnedActionUses', () => {
  describe('should-flag fixtures', () => {
    it('flags floating tag (actions/setup-node@v6)', () => {
      const violations = findUnpinnedActionUses(read('should-flag-floating-tag.yml'), 'fixture')
      expect(violations).toHaveLength(1)
      expect(violations[0].kind).toBe('floating-tag')
      expect(violations[0].value).toBe('actions/setup-node@v6')
    })

    it('flags branch ref (actions/checkout@main)', () => {
      const violations = findUnpinnedActionUses(read('should-flag-branch-ref.yml'), 'fixture')
      expect(violations).toHaveLength(1)
      expect(violations[0].kind).toBe('branch-ref')
      expect(violations[0].value).toBe('actions/checkout@main')
    })

    it('flags reusable-workflow floating ref', () => {
      const violations = findUnpinnedActionUses(
        read('should-flag-reusable-workflow-floating.yml'),
        'fixture'
      )
      expect(violations).toHaveLength(1)
      expect(violations[0].kind).toBe('floating-tag')
      expect(violations[0].value).toBe('org/repo/.github/workflows/build.yml@v2')
    })
  })

  describe('should-pass fixtures', () => {
    it('passes SHA-pinned action refs', () => {
      const violations = findUnpinnedActionUses(read('should-pass-sha-pinned.yml'), 'fixture')
      expect(violations).toEqual([])
    })

    it('passes SHA-pinned reusable workflow', () => {
      const violations = findUnpinnedActionUses(
        read('should-pass-reusable-workflow-sha.yml'),
        'fixture'
      )
      expect(violations).toEqual([])
    })

    it('passes local action (./.github/actions/foo)', () => {
      const violations = findUnpinnedActionUses(read('should-pass-local-action.yml'), 'fixture')
      expect(violations).toEqual([])
    })

    it('passes Docker image refs (docker://...)', () => {
      const violations = findUnpinnedActionUses(read('should-pass-docker-image.yml'), 'fixture')
      expect(violations).toEqual([])
    })
  })

  describe('repo invariant', () => {
    it('every workflow under .github/workflows/ is SHA-pinned', () => {
      // Repo-wide spot check from the plan: after PR #975 06267d27, every
      // remote `uses:` must be SHA-pinned.
      const repoRoot = join(__dirname, '..', '..')
      const workflowDir = join(repoRoot, '.github', 'workflows')
      const files = readdirSync(workflowDir).filter(
        (f) => f.endsWith('.yml') || f.endsWith('.yaml')
      )
      const allViolations: Array<{ file: string; line: number; value: string; kind: string }> = []
      for (const file of files) {
        const content = readFileSync(join(workflowDir, file), 'utf8')
        const violations = findUnpinnedActionUses(content, file)
        for (const v of violations) {
          allViolations.push({ file, ...v })
        }
      }
      expect(allViolations).toEqual([])
    })
  })
})
