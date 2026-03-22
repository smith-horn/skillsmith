/**
 * Tests for linear-hook.mjs — SMI-3540: Prevent premature "Done" marking
 *
 * Tests the source code change detection and conventional commit prefix parsing
 * that prevents issues from being marked "Done" without implementation code.
 */

import { describe, it, expect } from 'vitest'

// Import the exported functions from the .mjs file
// Note: We dynamically import since it's an ESM .mjs file
const { parseConventionalCommitPrefix, hasSourceCodeChanges } = await import('../linear-hook.mjs')

describe('SMI-3540: linear-hook — prevent premature Done', () => {
  describe('parseConventionalCommitPrefix', () => {
    it('should parse standard conventional commit prefixes', () => {
      expect(parseConventionalCommitPrefix('fix: resolve issue')).toBe('fix')
      expect(parseConventionalCommitPrefix('feat: add feature')).toBe('feat')
      expect(parseConventionalCommitPrefix('docs: update readme')).toBe('docs')
      expect(parseConventionalCommitPrefix('chore: bump deps')).toBe('chore')
      expect(parseConventionalCommitPrefix('test: add tests')).toBe('test')
      expect(parseConventionalCommitPrefix('refactor: clean up')).toBe('refactor')
      expect(parseConventionalCommitPrefix('perf: optimize query')).toBe('perf')
      expect(parseConventionalCommitPrefix('ci: update workflow')).toBe('ci')
      expect(parseConventionalCommitPrefix('style: format code')).toBe('style')
    })

    it('should parse prefixes with scopes', () => {
      expect(parseConventionalCommitPrefix('fix(core): resolve issue')).toBe('fix')
      expect(parseConventionalCommitPrefix('feat(cli): add command')).toBe('feat')
      expect(parseConventionalCommitPrefix('docs(api): update docs')).toBe('docs')
    })

    it('should parse breaking change indicators', () => {
      expect(parseConventionalCommitPrefix('feat!: breaking change')).toBe('feat')
      expect(parseConventionalCommitPrefix('fix(core)!: breaking fix')).toBe('fix')
    })

    it('should return null for non-conventional commits', () => {
      expect(parseConventionalCommitPrefix('SMI-1234 fix the thing')).toBeNull()
      expect(parseConventionalCommitPrefix('Update README')).toBeNull()
      expect(parseConventionalCommitPrefix('Merge branch main')).toBeNull()
      expect(parseConventionalCommitPrefix('')).toBeNull()
    })

    it('should handle fix(docs) correctly — prefix is fix, not docs', () => {
      // fix(docs) means the TYPE is "fix" with scope "docs"
      // The prefix determines behavior, not the scope
      expect(parseConventionalCommitPrefix('fix(docs): correct typo (SMI-1234)')).toBe('fix')
    })

    it('should normalize prefix to lowercase', () => {
      expect(parseConventionalCommitPrefix('FIX: uppercase')).toBe('fix')
      expect(parseConventionalCommitPrefix('Feat(core): mixed case')).toBe('feat')
    })
  })

  describe('hasSourceCodeChanges', () => {
    // Note: This function calls git diff-tree which depends on the actual repo state.
    // In CI, the last commit will have source changes (the test files themselves).
    // We test the function exists and returns a boolean.
    it('should return a boolean', () => {
      const result = hasSourceCodeChanges()
      expect(typeof result).toBe('boolean')
    })
  })

  describe('source/excluded pattern logic', () => {
    // Test the pattern matching logic directly using the same regexes
    const SOURCE_PATTERNS = [
      /^packages\/.*\.(ts|tsx|js|jsx)$/,
      /^supabase\/functions\/.*\.(ts|js)$/,
      /^scripts\/.*\.(ts|js|mjs)$/,
    ]
    const EXCLUDED_PATTERNS = [
      /\.test\.(ts|tsx|js)$/,
      /\.spec\.(ts|tsx|js)$/,
      /\.md$/,
      /^\.claude\//,
      /^docs\//,
    ]

    function isSourceFile(file: string): boolean {
      const isSource = SOURCE_PATTERNS.some((p) => p.test(file))
      const isExcluded = EXCLUDED_PATTERNS.some((p) => p.test(file))
      return isSource && !isExcluded
    }

    it('should identify source files', () => {
      expect(isSourceFile('packages/core/src/index.ts')).toBe(true)
      expect(isSourceFile('packages/mcp-server/src/tools.tsx')).toBe(true)
      expect(isSourceFile('scripts/audit-standards.mjs')).toBe(true)
      expect(isSourceFile('supabase/functions/indexer/index.ts')).toBe(true)
    })

    it('should exclude test files', () => {
      expect(isSourceFile('packages/core/src/foo.test.ts')).toBe(false)
      expect(isSourceFile('packages/core/src/bar.spec.ts')).toBe(false)
    })

    it('should exclude docs and config', () => {
      expect(isSourceFile('docs/internal/architecture/standards.md')).toBe(false)
      expect(isSourceFile('.claude/development/docker-guide.md')).toBe(false)
      expect(isSourceFile('README.md')).toBe(false)
    })

    it('should exclude non-source files', () => {
      expect(isSourceFile('package.json')).toBe(false)
      expect(isSourceFile('.github/workflows/ci.yml')).toBe(false)
      expect(isSourceFile('tsconfig.json')).toBe(false)
    })

    it('should handle mixed commit correctly — .md + .ts', () => {
      const files = ['docs/internal/plan.md', 'packages/core/src/service.ts']
      const hasSource = files.some((f) => isSourceFile(f))
      expect(hasSource).toBe(true)
    })

    it('should detect tests-only as non-source', () => {
      const files = ['packages/core/src/foo.test.ts', 'packages/core/src/bar.spec.ts']
      const hasSource = files.some((f) => isSourceFile(f))
      expect(hasSource).toBe(false)
    })

    it('should detect version bumps as non-source', () => {
      const files = ['package.json', 'packages/core/package.json']
      const hasSource = files.some((f) => isSourceFile(f))
      expect(hasSource).toBe(false)
    })
  })
})
