/**
 * Tests for CI Change Classifier (SMI-2187)
 */

import { describe, it, expect } from 'vitest'
import {
  classifyChanges,
  matchesPatterns,
  isValidGitRef,
  getSubmoduleMounts,
  isSubmoduleMount,
} from '../ci/classify-changes'

describe('SMI-2187: CI Change Classifier', () => {
  describe('isValidGitRef', () => {
    it('should accept valid SHA hashes', () => {
      expect(isValidGitRef('abc123')).toBe(true)
      expect(isValidGitRef('1234567890abcdef1234567890abcdef12345678')).toBe(true)
      expect(isValidGitRef('ABCDEF')).toBe(true) // uppercase
    })

    it('should accept valid branch/tag names', () => {
      expect(isValidGitRef('main')).toBe(true)
      expect(isValidGitRef('feature/my-branch')).toBe(true)
      expect(isValidGitRef('v1.0.0')).toBe(true)
      expect(isValidGitRef('refs/heads/main')).toBe(true)
      expect(isValidGitRef('HEAD')).toBe(true)
    })

    it('should reject malicious input', () => {
      expect(isValidGitRef('$(rm -rf /)')).toBe(false)
      expect(isValidGitRef('main; rm -rf /')).toBe(false)
      expect(isValidGitRef('`whoami`')).toBe(false)
      expect(isValidGitRef('main && echo pwned')).toBe(false)
      expect(isValidGitRef('main | cat /etc/passwd')).toBe(false)
    })

    it('should reject empty or whitespace refs', () => {
      expect(isValidGitRef('')).toBe(false)
      expect(isValidGitRef('   ')).toBe(false)
    })

    it('should accept short branch names', () => {
      // Short names like 'v1' or 'ab' are valid branch names
      expect(isValidGitRef('ab')).toBe(true)
      expect(isValidGitRef('v1')).toBe(true)
    })
  })

  describe('matchesPatterns', () => {
    it('should match glob patterns', () => {
      expect(
        matchesPatterns('.claude/development/docker-guide.md', ['.claude/development/**'])
      ).toBe(true)
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
        const result = classifyChanges(['README.md', '.claude/development/docker-guide.md'])
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

      it('should classify .gitmodules as config', () => {
        const result = classifyChanges(['.gitmodules'])
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

      it('should classify compose.yml as deps', () => {
        const result = classifyChanges(['compose.yml'])
        expect(result.tier).toBe('deps')
      })

      it('should classify compose.yaml as deps', () => {
        const result = classifyChanges(['compose.yaml'])
        expect(result.tier).toBe('deps')
      })

      it('should classify docker-compose.yaml as deps', () => {
        const result = classifyChanges(['docker-compose.prod.yaml'])
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

      it('should include file counts in reason for mixed changes', () => {
        const result = classifyChanges([
          'README.md',
          'packages/core/src/a.ts',
          'packages/core/src/b.ts',
        ])
        expect(result.reason).toContain('docs: 1 file(s)')
        expect(result.reason).toContain('code: 2 file(s)')
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

      it('should require full CI for post-merge-verify.yml changes (SMI-5547)', () => {
        const result = classifyChanges(['.github/workflows/post-merge-verify.yml'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
        expect(result.reason).toContain('Critical file changed')
      })

      it('should override other classifications for critical files', () => {
        const result = classifyChanges(['README.md', '.github/workflows/ci.yml'])
        expect(result.tier).toBe('code')
      })

      it('should require full CI when multiple critical files change', () => {
        const result = classifyChanges([
          'Dockerfile',
          'package-lock.json',
          '.github/workflows/ci.yml',
        ])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
        expect(result.reason).toContain('Critical file changed')
      })
    })

    describe('unmatched files (safety behavior)', () => {
      it('should default to code tier for unknown file types', () => {
        const result = classifyChanges(['random-file.xyz'])
        // Unknown files trigger code tier for safety
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
      })

      it('should include unmatched count in reason', () => {
        const result = classifyChanges(['Makefile', 'terraform/main.tf'])
        expect(result.tier).toBe('code')
        expect(result.reason).toContain('unmatched: 2 file(s)')
      })

      it('should escalate from docs to code when unknown file present', () => {
        const result = classifyChanges(['README.md', 'unknown.xyz'])
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

      it('should handle file list with empty strings', () => {
        const result = classifyChanges(['', 'README.md', ''])
        expect(result.tier).toBe('docs')
        // Verify empty strings are filtered
        expect(result.changedFiles).toHaveLength(1)
        expect(result.changedFiles[0]).toBe('README.md')
      })

      it('should include changed file count in result', () => {
        const files = ['a.ts', 'b.ts', 'c.ts'].map((f) => `packages/core/src/${f}`)
        const result = classifyChanges(files)
        expect(result.changedFiles).toHaveLength(3)
      })

      it('should handle wildcard pattern from git failure gracefully', () => {
        // When git fails, getChangedFiles returns ['**/*']
        // This doesn't match any tier, so should trigger code for safety
        const result = classifyChanges(['**/*'])
        expect(result.tier).toBe('code')
      })
    })
  })

  describe('gitlink submodule pointer bumps (SMI-5665)', () => {
    describe('classifyChanges', () => {
      it('should classify a docs/internal gitlink bump as docs', () => {
        const result = classifyChanges(['docs/internal'])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
      })

      it('should classify a .claude/skills gitlink bump as docs', () => {
        const result = classifyChanges(['.claude/skills'])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
      })

      it('should classify a .claude/plans gitlink bump as docs', () => {
        const result = classifyChanges(['.claude/plans'])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
      })

      it('should classify a .claude/hive-mind gitlink bump as docs', () => {
        const result = classifyChanges(['.claude/hive-mind'])
        expect(result.tier).toBe('docs')
        expect(result.skipDocker).toBe(true)
        expect(result.skipTests).toBe(true)
      })

      it('should classify multiple gitlink bumps together as docs', () => {
        const result = classifyChanges(['docs/internal', '.claude/skills'])
        expect(result.tier).toBe('docs')
      })

      it('should classify a gitlink bump alongside a real markdown file as docs', () => {
        const result = classifyChanges(['docs/internal', 'README.md'])
        expect(result.tier).toBe('docs')
      })

      it('should NOT down-classify a gitlink bump mixed with real code (regression guard)', () => {
        const result = classifyChanges(['docs/internal', 'packages/core/src/index.ts'])
        expect(result.tier).toBe('code')
        expect(result.skipDocker).toBe(false)
        expect(result.skipTests).toBe(false)
      })

      it('should treat a real file path merely nested under a mount as unmatched, not exact-match (boundary guard)', () => {
        // Proves the rule is exact-match on the bare mount path, not a prefix —
        // a file that happens to live under a mount directory still hits the
        // existing unmatched-files-default-to-code safety net.
        const nestedUnderDocsInternal = classifyChanges(['docs/internal/foo.ts'])
        expect(nestedUnderDocsInternal.tier).toBe('code')

        const nestedUnderClaudeSkills = classifyChanges(['.claude/skills/foo.ts'])
        expect(nestedUnderClaudeSkills.tier).toBe('code')
      })
    })

    describe('getSubmoduleMounts', () => {
      it('should parse mount paths from synthetic .gitmodules content', () => {
        const content = [
          '[submodule "docs/internal"]',
          '\tpath = docs/internal',
          '\turl = https://github.com/smith-horn/skillsmith-docs.git',
          '\tbranch = main',
          '',
          '[submodule ".claude/skills"]',
          '\tpath = .claude/skills',
          '\turl = https://github.com/smith-horn/skillsmith-strategy.git',
          '\tbranch = skills',
        ].join('\n')

        const mounts = getSubmoduleMounts(content)
        expect(mounts).toEqual(['docs/internal', '.claude/skills'])
      })

      it('should return an empty array when no "path = " lines are present (M2)', () => {
        const mounts = getSubmoduleMounts('not a valid gitmodules file, no path lines here')
        expect(mounts).toEqual([])
      })

      it('should drop an empty/whitespace-only path value rather than returning it (M2)', () => {
        const mounts = getSubmoduleMounts('[submodule "x"]\n\tpath =   \n')
        expect(mounts).toEqual([])
      })

      it('should return a superset containing all 4 known mounts when reading the real .gitmodules', () => {
        // No arg — reads the real .gitmodules from the repo root. Robust to a
        // future 5th mount being added (superset, not exact-equal).
        const mounts = getSubmoduleMounts()
        expect(mounts).toEqual(
          expect.arrayContaining([
            'docs/internal',
            '.claude/skills',
            '.claude/plans',
            '.claude/hive-mind',
          ])
        )
      })

      it('should strip a matching pair of double quotes from a path value (review finding)', () => {
        const mounts = getSubmoduleMounts('[submodule "x"]\n\tpath = "docs/internal"\n')
        expect(mounts).toEqual(['docs/internal'])
      })
    })

    describe('isSubmoduleMount (exact-match guarantee, review finding)', () => {
      it('should use plain string equality, not glob matching', () => {
        expect(isSubmoduleMount('docs/internal', ['docs/internal'])).toBe(true)
        expect(isSubmoduleMount('docs/internal', ['other/path'])).toBe(false)
      })

      it('should still match a mount path containing glob metacharacters against itself', () => {
        // minimatch('vendor/[abc]', 'vendor/[abc]') is false -- a character
        // class doesn't match its own literal text. isSubmoduleMount must not
        // have this failure mode since mount paths are data, not patterns.
        expect(isSubmoduleMount('vendor/[abc]', ['vendor/[abc]'])).toBe(true)
      })

      it('should NOT treat a "**" mount path as a wildcard matching every file', () => {
        // If a mount path ever equaled '**', passing it through minimatch
        // would match arbitrary files. Exact-match must not have this hazard.
        expect(isSubmoduleMount('packages/core/src/index.ts', ['**'])).toBe(false)
        expect(isSubmoduleMount('**', ['**'])).toBe(true)
      })

      it('classifyChanges should apply the same exact-match guarantee end-to-end', () => {
        // random-file.xyz is unrelated to any real submodule mount and must
        // still hit the safety fallback -- proves isSubmoduleMount's exact
        // match doesn't accidentally widen what counts as a mount.
        const result = classifyChanges(['random-file.xyz'])
        expect(result.tier).toBe('code')
      })
    })
  })
})
