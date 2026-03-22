/**
 * Tests for CI Implementation Completeness Check (SMI-3541)
 */

import { describe, it, expect } from 'vitest'
import {
  categorizeFile,
  categorizeFiles,
  determineVerdict,
  run,
  type FileCategory,
} from '../ci/verify-implementation'

describe('SMI-3541: verify-implementation', () => {
  describe('categorizeFile', () => {
    it('should identify source files', () => {
      expect(categorizeFile('packages/core/src/index.ts')).toBe('source')
      expect(categorizeFile('packages/mcp-server/src/tools.tsx')).toBe('source')
      expect(categorizeFile('scripts/audit-standards.mjs')).toBe('source')
      expect(categorizeFile('supabase/functions/indexer/index.ts')).toBe('source')
    })

    it('should identify test files', () => {
      expect(categorizeFile('packages/core/src/foo.test.ts')).toBe('test')
      expect(categorizeFile('packages/core/src/bar.spec.ts')).toBe('test')
      expect(categorizeFile('scripts/tests/classify-changes.test.ts')).toBe('test')
    })

    it('should identify docs files', () => {
      expect(categorizeFile('README.md')).toBe('docs')
      expect(categorizeFile('docs/internal/architecture/standards.md')).toBe('docs')
      expect(categorizeFile('.claude/development/docker-guide.md')).toBe('docs')
    })

    it('should identify config files', () => {
      expect(categorizeFile('package.json')).toBe('config')
      expect(categorizeFile('.github/workflows/ci.yml')).toBe('config')
      expect(categorizeFile('tsconfig.json')).toBe('config')
      expect(categorizeFile('.eslintrc.json')).toBe('config')
    })
  })

  describe('categorizeFiles', () => {
    it('should categorize a mixed set of files', () => {
      const files = [
        'packages/core/src/index.ts',
        'packages/core/src/index.test.ts',
        'README.md',
        'package.json',
      ]
      const result = categorizeFiles(files)
      expect(result.source).toEqual(['packages/core/src/index.ts'])
      expect(result.test).toEqual(['packages/core/src/index.test.ts'])
      expect(result.docs).toEqual(['README.md'])
      expect(result.config).toEqual(['package.json'])
    })

    it('should handle empty file list', () => {
      const result = categorizeFiles([])
      expect(result.source).toEqual([])
      expect(result.test).toEqual([])
      expect(result.docs).toEqual([])
      expect(result.config).toEqual([])
    })
  })

  describe('determineVerdict', () => {
    it('should pass when no SMI refs', () => {
      const files: FileCategory = { source: [], test: [], docs: ['README.md'], config: [] }
      const result = determineVerdict([], files)
      expect(result.verdict).toBe('pass')
    })

    it('should pass when SMI refs with source files', () => {
      const files: FileCategory = {
        source: ['packages/core/src/service.ts'],
        test: [],
        docs: [],
        config: [],
      }
      const result = determineVerdict(['SMI-1234'], files)
      expect(result.verdict).toBe('pass')
    })

    it('should warn when SMI refs with only test files', () => {
      const files: FileCategory = {
        source: [],
        test: ['packages/core/src/foo.test.ts'],
        docs: [],
        config: [],
      }
      const result = determineVerdict(['SMI-1234'], files)
      expect(result.verdict).toBe('warn')
    })

    it('should fail when SMI refs with only docs/config files', () => {
      const files: FileCategory = {
        source: [],
        test: [],
        docs: ['README.md'],
        config: ['package.json'],
      }
      const result = determineVerdict(['SMI-1234'], files)
      expect(result.verdict).toBe('fail')
    })

    it('should pass when SMI refs with mixed source + docs', () => {
      const files: FileCategory = {
        source: ['packages/core/src/index.ts'],
        test: [],
        docs: ['README.md'],
        config: [],
      }
      const result = determineVerdict(['SMI-1234'], files)
      expect(result.verdict).toBe('pass')
    })

    it('should include all issues in result', () => {
      const files: FileCategory = {
        source: ['packages/core/src/index.ts'],
        test: [],
        docs: [],
        config: [],
      }
      const result = determineVerdict(['SMI-1234', 'SMI-5678'], files)
      expect(result.issues).toEqual(['SMI-1234', 'SMI-5678'])
    })
  })

  describe('run (integration)', () => {
    it('should skip when [skip-impl-check] is in PR body', () => {
      const result = run({
        title: 'docs: update CLAUDE.md (SMI-1234)',
        body: 'This is a docs-only change. [skip-impl-check]',
        commits: ['docs: update CLAUDE.md (SMI-1234)'],
        files: ['CLAUDE.md'],
      })
      expect(result.verdict).toBe('skip')
    })

    it('should pass when no SMI refs in PR', () => {
      const result = run({
        title: 'chore: update dependencies',
        body: 'Routine dep update',
        commits: ['chore: update dependencies'],
        files: ['package.json', 'package-lock.json'],
      })
      expect(result.verdict).toBe('pass')
    })

    it('should pass when SMI ref with source code', () => {
      const result = run({
        title: 'feat(core): add new service (SMI-1234)',
        body: 'Implements the new service',
        commits: ['feat(core): add new service (SMI-1234)'],
        files: ['packages/core/src/new-service.ts', 'packages/core/src/new-service.test.ts'],
      })
      expect(result.verdict).toBe('pass')
    })

    it('should fail when SMI ref with only docs', () => {
      const result = run({
        title: 'fix(SMI-1234): update docs',
        body: 'Updated the documentation',
        commits: ['fix(SMI-1234): update docs'],
        files: ['docs/internal/architecture/standards.md', 'README.md'],
      })
      expect(result.verdict).toBe('fail')
    })

    it('should extract issues from PR body commits', () => {
      const result = run({
        title: 'Feature work',
        body: 'Refs: SMI-1234, SMI-5678',
        commits: ['feat: part 1 (SMI-1234)', 'feat: part 2 (SMI-5678)'],
        files: ['packages/core/src/feature.ts'],
      })
      expect(result.verdict).toBe('pass')
      expect(result.issues).toContain('SMI-1234')
      expect(result.issues).toContain('SMI-5678')
    })
  })
})
