/**
 * Tests for CI Change Classifier (SMI-2187)
 */

import { describe, it, expect } from 'vitest'
import {
  classifyChanges,
  matchesPatterns,
  type Tier,
  type ClassificationResult,
} from '../ci/classify-changes'

describe('SMI-2187: CI Change Classifier', () => {
  describe('matchesPatterns', () => {
    it('should match glob patterns', () => {
      expect(matchesPatterns('docs/adr/001.md', ['docs/**'])).toBe(true)
      expect(matchesPatterns('README.md', ['**/*.md'])).toBe(true)
      expect(matchesPatterns('packages/core/src/index.ts', ['packages/**/*.ts'])).toBe(true)
    })

    it('should not match non-matching patterns', () => {
      expect(matchesPatterns('src/index.ts', ['docs/**'])).toBe(false)
      expect(matchesPatterns('package.json', ['**/*.md'])).toBe(false)
    })

    it('should handle dotfiles', () => {
      expect(matchesPatterns('.eslintrc.json', ['.eslintrc*'])).toBe(true)
      expect(matchesPatterns('.gitignore', ['.gitignore'])).toBe(true)
    })
  })

  describe('classifyChanges', () => {
    describe('docs tier', () => {
      it('should classify markdown-only changes as docs', () => {
        const result = classifyChanges(['README.md', 'docs/adr/001.md'])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
      })

      it('should classify LICENSE changes as docs', () => {
        const result = classifyChanges(['LICENSE'])
        expect(result.tier).toBe('docs')
      })

      it('should classify issue templates as docs', () => {
        const result = classifyChanges(['.github/ISSUE_TEMPLATE/bug.md'])
        expect(result.tier).toBe('docs')
      })

      it('should classify CODEOWNERS as docs', () => {
        const result = classifyChanges(['.github/CODEOWNERS'])
        expect(result.tier).toBe('docs')
      })
    })

    describe('config tier', () => {
      it('should classify eslint config as config', () => {
        const result = classifyChanges(['.eslintrc.json'])
        expect(result.tier).toBe('config')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(false)
      })

      it('should classify tsconfig as config', () => {
        const result = classifyChanges(['tsconfig.json'])
        expect(result.tier).toBe('config')
      })

      it('should classify vitest config as config', () => {
        const result = classifyChanges(['vitest.config.ts'])
        expect(result.tier).toBe('config')
      })

      it('should classify husky hooks as config', () => {
        const result = classifyChanges(['.husky/pre-commit'])
        expect(result.tier).toBe('config')
      })
    })

    describe('deps tier', () => {
      it('should classify package.json as deps', () => {
        const result = classifyChanges(['package.json'])
        expect(result.tier).toBe('deps')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
      })

      it('should classify package-lock.json as code (always full CI)', () => {
        // package-lock.json is in ALWAYS_FULL_CI
        const result = classifyChanges(['package-lock.json'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
      })

      it('should classify workspace package.json as deps', () => {
        const result = classifyChanges(['packages/core/package.json'])
        expect(result.tier).toBe('deps')
      })

      it('should classify nvmrc as deps', () => {
        const result = classifyChanges(['.nvmrc'])
        expect(result.tier).toBe('deps')
      })
    })

    describe('code tier', () => {
      it('should classify TypeScript files as code', () => {
        const result = classifyChanges(['packages/core/src/index.ts'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
      })

      it('should classify supabase functions as code', () => {
        const result = classifyChanges(['supabase/functions/indexer/index.ts'])
        expect(result.tier).toBe('code')
      })

      it('should classify scripts as code', () => {
        const result = classifyChanges(['scripts/audit-standards.mjs'])
        expect(result.tier).toBe('code')
      })
    })

    describe('mixed changes', () => {
      it('should use highest tier for mixed docs+code', () => {
        const result = classifyChanges(['README.md', 'packages/core/src/index.ts'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
      })

      it('should use highest tier for mixed config+deps', () => {
        const result = classifyChanges(['.eslintrc.json', 'packages/core/package.json'])
        expect(result.tier).toBe('deps')
      })

      it('should use highest tier for mixed docs+config', () => {
        const result = classifyChanges(['README.md', 'vitest.config.ts'])
        expect(result.tier).toBe('config')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(false)
      })
    })

    describe('always full CI files', () => {
      it('should require full CI for ci.yml changes', () => {
        const result = classifyChanges(['.github/workflows/ci.yml'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.reason).toContain('Critical file changed')
      })

      it('should require full CI for Dockerfile changes', () => {
        const result = classifyChanges(['Dockerfile'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
      })

      it('should override other classifications for critical files', () => {
        const result = classifyChanges(['README.md', '.github/workflows/ci.yml'])
        expect(result.tier).toBe('code')
      })
    })

    describe('edge cases', () => {
      it('should handle empty file list', () => {
        const result = classifyChanges([])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
        expect(result.reason).toBe('No files changed')
      })

      it('should handle unclassified files', () => {
        const result = classifyChanges(['random-file.xyz'])
        // Unclassified files don't match any tier, so stays at docs
        expect(result.tier).toBe('docs')
      })

      it('should include changed file count in result', () => {
        const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => `packages/core/src/${f}`)
        const result = classifyChanges(files)
        expect(result.changedFiles).toHaveLength(3)
      })
    })
  })
})
