/**
 * Tests for CI Documentation Drift Check (SMI-3883)
 */

import { describe, it, expect } from 'vitest'
import {
  detectNewMcpTools,
  detectNewCliCommands,
  detectVersionBumps,
  detectSecurityFeatures,
  detectVscodeChanges,
  detectMigrations,
  run,
  type PrData,
} from '../ci/check-doc-drift'

describe('SMI-3882: check-doc-drift', () => {
  // Helper to create PrData
  function prData(overrides: Partial<PrData> = {}): PrData {
    return {
      title: 'feat: test PR',
      body: '',
      files: [],
      diff: '',
      ...overrides,
    }
  }

  describe('detectNewMcpTools', () => {
    it('should detect new MCP tool without README updates (test 1: fail)', () => {
      const files = ['packages/mcp-server/src/index.ts']
      const diff = '+  newToolSchema,\n+  anotherSchema]\n'
      const gaps = detectNewMcpTools(files, diff)
      expect(gaps.length).toBe(4)
      expect(gaps.every((g) => g.severity === 'fail')).toBe(true)
      expect(gaps.map((g) => g.surface)).toContain('README.md')
      expect(gaps.map((g) => g.surface)).toContain('packages/mcp-server/README.md')
    })

    it('should pass when MCP tool + README updated (test 2: pass)', () => {
      const files = [
        'packages/mcp-server/src/index.ts',
        'README.md',
        'packages/mcp-server/README.md',
        'packages/website/src/pages/docs/mcp-server.astro',
        'CLAUDE.md',
      ]
      const diff = '+  newToolSchema,\n'
      const gaps = detectNewMcpTools(files, diff)
      expect(gaps.length).toBe(0)
    })

    it('should return no gaps when index.ts not changed', () => {
      const files = ['packages/mcp-server/src/tools/search.ts']
      const diff = '+  something'
      const gaps = detectNewMcpTools(files, diff)
      expect(gaps.length).toBe(0)
    })
  })

  describe('detectNewCliCommands', () => {
    it('should detect new CLI command without doc updates', () => {
      const files = ['packages/cli/src/commands/new-cmd.ts']
      const diff = "+  .command('new-cmd')\n"
      const gaps = detectNewCliCommands(files, diff)
      expect(gaps.length).toBe(2)
      expect(gaps.every((g) => g.severity === 'fail')).toBe(true)
    })

    it('should pass when CLI command + docs updated', () => {
      const files = [
        'packages/cli/src/commands/new-cmd.ts',
        'packages/website/src/pages/docs/cli.astro',
        'packages/cli/README.md',
      ]
      const diff = "+  .command('new-cmd')\n"
      const gaps = detectNewCliCommands(files, diff)
      expect(gaps.length).toBe(0)
    })
  })

  describe('detectVersionBumps', () => {
    it('should pass when version bump + CHANGELOG present (test 3: pass)', () => {
      const files = ['packages/core/package.json', 'packages/core/CHANGELOG.md']
      const gaps = detectVersionBumps(files)
      expect(gaps.length).toBe(0)
    })

    it('should fail when version bump + no CHANGELOG (test 4: fail)', () => {
      const files = ['packages/core/package.json']
      const gaps = detectVersionBumps(files)
      expect(gaps.length).toBe(1)
      expect(gaps[0].severity).toBe('fail')
      expect(gaps[0].surface).toBe('packages/core/CHANGELOG.md')
    })

    it('should check root package.json separately', () => {
      const files = ['package.json']
      const gaps = detectVersionBumps(files)
      expect(gaps.length).toBe(1)
      expect(gaps[0].surface).toBe('CHANGELOG.md')
    })
  })

  describe('detectSecurityFeatures', () => {
    it('should pass when security files + security.astro present (test 7: pass)', () => {
      const files = [
        'packages/core/src/security/scanner.ts',
        'packages/website/src/pages/docs/security.astro',
      ]
      const gaps = detectSecurityFeatures(files)
      expect(gaps.length).toBe(0)
    })

    it('should warn when security files + no security.astro (test 8: warn)', () => {
      const files = ['packages/core/src/security/scanner.ts']
      const gaps = detectSecurityFeatures(files)
      expect(gaps.length).toBe(1)
      expect(gaps[0].severity).toBe('warn')
    })

    it('should ignore test files in security paths', () => {
      const files = ['packages/core/src/security/scanner.test.ts']
      const gaps = detectSecurityFeatures(files)
      expect(gaps.length).toBe(0)
    })
  })

  describe('detectVscodeChanges', () => {
    it('should warn when VS Code src changes + no CHANGELOG (test 9: warn)', () => {
      const files = ['packages/vscode-extension/src/extension.ts']
      const gaps = detectVscodeChanges(files)
      expect(gaps.length).toBe(1)
      expect(gaps[0].severity).toBe('warn')
    })

    it('should pass when VS Code src changes + CHANGELOG present', () => {
      const files = [
        'packages/vscode-extension/src/extension.ts',
        'packages/vscode-extension/CHANGELOG.md',
      ]
      const gaps = detectVscodeChanges(files)
      expect(gaps.length).toBe(0)
    })
  })

  describe('detectMigrations', () => {
    it('should pass when migration + core CHANGELOG present (test 10: pass)', () => {
      const files = [
        'packages/core/src/database/migrations/065-new-table.ts',
        'packages/core/CHANGELOG.md',
      ]
      const gaps = detectMigrations(files)
      expect(gaps.length).toBe(0)
    })

    it('should warn when migration + no core CHANGELOG', () => {
      const files = ['packages/core/src/database/migrations/065-new-table.ts']
      const gaps = detectMigrations(files)
      expect(gaps.length).toBe(1)
      expect(gaps[0].severity).toBe('warn')
    })
  })

  describe('run (integration)', () => {
    it('should skip when [skip-doc-drift] in PR body (test 5: skip)', () => {
      const result = run(
        prData({
          body: 'Hotfix: [skip-doc-drift]',
          files: ['packages/core/package.json'],
        })
      )
      expect(result.verdict).toBe('skip')
    })

    it('should pass when only test files changed (test 6: pass)', () => {
      const result = run(
        prData({
          files: ['packages/core/src/foo.test.ts', 'packages/mcp-server/src/bar.spec.ts'],
        })
      )
      expect(result.verdict).toBe('pass')
      expect(result.reason).toContain('No non-test source files')
    })

    it('should use highest severity when multiple gaps (test 11: highest wins)', () => {
      const result = run(
        prData({
          files: [
            'packages/core/package.json',
            'packages/vscode-extension/src/extension.ts',
            'packages/core/src/index.ts',
          ],
          diff: '',
        })
      )
      // Version bump without CHANGELOG = fail, VS Code without CHANGELOG = warn
      expect(result.verdict).toBe('fail')
      expect(result.gaps.length).toBeGreaterThanOrEqual(2)
    })

    it('should pass for deps-only PR with no source files (test 12: pass)', () => {
      const result = run(
        prData({
          files: ['package.json', 'package-lock.json'],
        })
      )
      // package.json is not a source file pattern, so no non-test source detected
      expect(result.verdict).toBe('pass')
    })

    it('should pass when source changes have no doc requirements', () => {
      const result = run(
        prData({
          files: ['packages/core/src/utils.ts'],
          diff: '+ export function helper() {}',
        })
      )
      expect(result.verdict).toBe('pass')
    })

    it('should include gap details in reason when failing', () => {
      const result = run(
        prData({
          files: ['packages/core/package.json', 'packages/core/src/index.ts'],
          diff: '',
        })
      )
      expect(result.verdict).toBe('fail')
      expect(result.reason).toContain('Documentation drift detected')
    })
  })
})
