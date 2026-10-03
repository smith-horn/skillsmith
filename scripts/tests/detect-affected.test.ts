/**
 * Tests for Affected Package Detection (SMI-2190)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadWorkspacePackages,
  buildDependencyGraph,
  findPackageForFile,
  requiresAllPackages,
  findAllDependents,
  detectAffectedPackages,
  outputForGitHub,
  type PackageInfo,
  type AffectedResult,
} from '../ci/detect-affected'

// Mock the actual workspace packages for consistent testing
const mockPackages: PackageInfo[] = [
  {
    name: '@skillsmith/core',
    path: '/packages/core',
    dirName: 'core',
    dependencies: [],
    devDependencies: [],
  },
  {
    name: '@skillsmith/mcp-server',
    path: '/packages/mcp-server',
    dirName: 'mcp-server',
    dependencies: ['@skillsmith/core'],
    devDependencies: [],
  },
  {
    name: '@skillsmith/cli',
    path: '/packages/cli',
    dirName: 'cli',
    dependencies: ['@skillsmith/core'],
    devDependencies: [],
  },
  {
    name: '@smith-horn/enterprise',
    path: '/packages/enterprise',
    dirName: 'enterprise',
    dependencies: ['@skillsmith/core'],
    devDependencies: [],
  },
  {
    name: '@skillsmith/vscode-extension',
    path: '/packages/vscode-extension',
    dirName: 'vscode-extension',
    dependencies: [],
    devDependencies: [],
  },
  {
    name: '@skillsmith/website',
    path: '/packages/website',
    dirName: 'website',
    dependencies: [],
    devDependencies: [],
  },
  {
    name: 'skillsmith-cli',
    path: '/packages/skillsmith-cli',
    dirName: 'skillsmith-cli',
    dependencies: [],
    devDependencies: [],
  },
]

describe('SMI-2190: Affected Package Detection', () => {
  describe('loadWorkspacePackages', () => {
    it('should load packages from packages/ directory', () => {
      const packages = loadWorkspacePackages()
      expect(packages.length).toBeGreaterThan(0)
      expect(packages.every((p) => p.name && p.dirName)).toBe(true)
    })

    it('should include core package', () => {
      const packages = loadWorkspacePackages()
      const core = packages.find((p) => p.name === '@skillsmith/core')
      expect(core).toBeDefined()
      expect(core?.dirName).toBe('core')
    })
  })

  describe('buildDependencyGraph', () => {
    it('should map packages to their dependents', () => {
      const graph = buildDependencyGraph(mockPackages)

      // Core should have mcp-server, cli, and enterprise as dependents
      const coreDependents = graph.get('@skillsmith/core')
      expect(coreDependents).toContain('@skillsmith/mcp-server')
      expect(coreDependents).toContain('@skillsmith/cli')
      expect(coreDependents).toContain('@smith-horn/enterprise')
    })

    it('should return empty array for packages with no dependents', () => {
      const graph = buildDependencyGraph(mockPackages)

      // Website and vscode-extension have no dependents
      expect(graph.get('@skillsmith/website')).toEqual([])
      expect(graph.get('@skillsmith/vscode-extension')).toEqual([])
    })

    it('should handle circular dependencies gracefully', () => {
      const packagesWithCircular: PackageInfo[] = [
        { name: 'a', path: '/a', dirName: 'a', dependencies: ['b'], devDependencies: [] },
        { name: 'b', path: '/b', dirName: 'b', dependencies: ['a'], devDependencies: [] },
      ]
      const graph = buildDependencyGraph(packagesWithCircular)
      expect(graph.get('a')).toContain('b')
      expect(graph.get('b')).toContain('a')
    })
  })

  describe('findPackageForFile', () => {
    it('should find package for files in packages directory', () => {
      const pkg = findPackageForFile('packages/core/src/index.ts', mockPackages)
      expect(pkg?.name).toBe('@skillsmith/core')
    })

    it('should find nested files within packages', () => {
      const pkg = findPackageForFile('packages/mcp-server/src/tools/search.ts', mockPackages)
      expect(pkg?.name).toBe('@skillsmith/mcp-server')
    })

    it('should return undefined for non-package files', () => {
      expect(findPackageForFile('scripts/ci/classify.ts', mockPackages)).toBeUndefined()
      expect(findPackageForFile('docs/internal/adr/001.md', mockPackages)).toBeUndefined()
      expect(findPackageForFile('README.md', mockPackages)).toBeUndefined()
    })

    it('should handle root-level files', () => {
      expect(findPackageForFile('package.json', mockPackages)).toBeUndefined()
      expect(findPackageForFile('tsconfig.json', mockPackages)).toBeUndefined()
    })
  })

  describe('requiresAllPackages', () => {
    it('should require all packages for root package.json changes', () => {
      const result = requiresAllPackages(['package.json'])
      expect(result.required).toBe(true)
      expect(result.reason).toContain('package.json')
    })

    it('should require all packages for package-lock.json changes', () => {
      const result = requiresAllPackages(['package-lock.json'])
      expect(result.required).toBe(true)
    })

    it('should require all packages for root tsconfig changes', () => {
      const result = requiresAllPackages(['tsconfig.json'])
      expect(result.required).toBe(true)
    })

    it('should require all packages for supabase changes', () => {
      const result = requiresAllPackages(['supabase/functions/indexer/index.ts'])
      expect(result.required).toBe(true)
      expect(result.reason).toContain('Supabase')
    })

    it('should not require all packages for package-specific files', () => {
      const result = requiresAllPackages(['packages/core/src/index.ts'])
      expect(result.required).toBe(false)
    })

    it('should not require all packages for docs changes', () => {
      const result = requiresAllPackages(['docs/internal/adr/001.md', 'README.md'])
      expect(result.required).toBe(false)
    })
  })

  describe('findAllDependents', () => {
    it('should find direct dependents', () => {
      const graph = buildDependencyGraph(mockPackages)
      const dependents = findAllDependents('@skillsmith/core', graph)

      expect(dependents).toContain('@skillsmith/mcp-server')
      expect(dependents).toContain('@skillsmith/cli')
      expect(dependents).toContain('@smith-horn/enterprise')
    })

    it('should return empty for packages with no dependents', () => {
      const graph = buildDependencyGraph(mockPackages)
      const dependents = findAllDependents('@skillsmith/website', graph)
      expect(dependents).toEqual([])
    })

    it('should handle transitive dependencies', () => {
      // Create a chain: a -> b -> c (c depends on b, b depends on a)
      const chainPackages: PackageInfo[] = [
        { name: 'a', path: '/a', dirName: 'a', dependencies: [], devDependencies: [] },
        { name: 'b', path: '/b', dirName: 'b', dependencies: ['a'], devDependencies: [] },
        { name: 'c', path: '/c', dirName: 'c', dependencies: ['b'], devDependencies: [] },
      ]
      const graph = buildDependencyGraph(chainPackages)
      const dependents = findAllDependents('a', graph)

      // Both b and c should be affected when a changes
      expect(dependents).toContain('b')
      expect(dependents).toContain('c')
    })

    it('should not include duplicates', () => {
      const graph = buildDependencyGraph(mockPackages)
      const dependents = findAllDependents('@skillsmith/core', graph)
      const uniqueDependents = [...new Set(dependents)]
      expect(dependents.length).toBe(uniqueDependents.length)
    })
  })

  describe('detectAffectedPackages', () => {
    // Tests run against real workspace packages for accurate integration testing
    // The mockPackages array is used for unit tests of buildDependencyGraph, findAllDependents, etc.

    it('should return empty for no changed files', () => {
      const result = detectAffectedPackages([])
      expect(result.all).toEqual([])
      expect(result.reason).toBe('No files changed')
    })

    it('should detect directly changed packages', () => {
      const result = detectAffectedPackages(['packages/website/src/pages/index.astro'])
      expect(result.directlyChanged).toContain('@skillsmith/website')
      expect(result.all).toContain('@skillsmith/website')
    })

    it('should detect downstream dependents when core changes', () => {
      const result = detectAffectedPackages(['packages/core/src/index.ts'])

      // Core should be directly changed
      expect(result.directlyChanged).toContain('@skillsmith/core')

      // Dependents should be affected
      expect(result.all).toContain('@skillsmith/mcp-server')
      expect(result.all).toContain('@skillsmith/cli')
      expect(result.all).toContain('@smith-horn/enterprise')
    })

    it('should not affect independent packages when specific package changes', () => {
      const result = detectAffectedPackages(['packages/website/src/pages/index.astro'])

      // Website change should not affect vscode-extension
      expect(result.all).toContain('@skillsmith/website')
      expect(result.all).not.toContain('@skillsmith/vscode-extension')
      expect(result.all).not.toContain('@skillsmith/core')
    })

    it('should return all packages for root-level changes', () => {
      const allPackages = loadWorkspacePackages()
      const result = detectAffectedPackages(['package.json'])
      expect(result.all.length).toBe(allPackages.length) // All packages (SMI-3589)
      expect(result.dirNames.length).toBe(allPackages.length) // All directory names
    })

    it('should handle mixed package and non-package files', () => {
      const result = detectAffectedPackages([
        'packages/core/src/index.ts',
        'docs/internal/adr/001.md',
        'scripts/ci/classify.ts',
      ])

      // Only core and its dependents should be affected
      expect(result.directlyChanged).toContain('@skillsmith/core')
      expect(result.all.length).toBeGreaterThan(0)
    })

    it('should include reason in result', () => {
      const result = detectAffectedPackages(['packages/core/src/index.ts'])
      expect(result.reason).toContain('directly changed')
    })

    it('should handle empty strings in file list', () => {
      const result = detectAffectedPackages(['', 'packages/core/src/index.ts', ''])
      expect(result.directlyChanged).toContain('@skillsmith/core')
    })

    it('should return empty for all-empty-string input', () => {
      const result = detectAffectedPackages(['', '', ''])
      expect(result.all).toEqual([])
      expect(result.reason).toBe('No packages affected')
    })

    it('should handle whitespace-only strings', () => {
      const result = detectAffectedPackages(['  ', '\t', '\n', 'packages/core/src/index.ts'])
      expect(result.directlyChanged).toContain('@skillsmith/core')
    })
  })

  // SMI-6488: outputForGitHub() was previously untested from outside --
  // 0 of this file's pre-existing test cases touched GITHUB_OUTPUT,
  // outputForGitHub, or main(). It is now exported specifically so the
  // affected_status sentinel (the ":272" guard block) and its failure path
  // are directly testable, rather than only reachable by running the CI
  // step itself.
  describe('outputForGitHub (SMI-6488 sentinel)', () => {
    const sampleResult: AffectedResult = {
      directlyChanged: ['@skillsmith/core'],
      affectedByDependency: ['@skillsmith/mcp-server'],
      all: ['@skillsmith/core', '@skillsmith/mcp-server'],
      dirNames: ['core', 'mcp-server'],
      reason: 'directly changed: 1',
    }

    let tmpDir: string
    let originalGithubOutput: string | undefined
    let originalGithubStepSummary: string | undefined

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'detect-affected-test-'))
      originalGithubOutput = process.env.GITHUB_OUTPUT
      originalGithubStepSummary = process.env.GITHUB_STEP_SUMMARY
      delete process.env.GITHUB_STEP_SUMMARY
    })

    afterEach(() => {
      if (originalGithubOutput === undefined) {
        delete process.env.GITHUB_OUTPUT
      } else {
        process.env.GITHUB_OUTPUT = originalGithubOutput
      }
      if (originalGithubStepSummary === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY
      } else {
        process.env.GITHUB_STEP_SUMMARY = originalGithubStepSummary
      }
      rmSync(tmpDir, { recursive: true, force: true })
      vi.restoreAllMocks()
    })

    it('writes affected_status=computed LAST, after affected_packages/affected_dirs/affected_count/affected_reason', () => {
      const outputPath = join(tmpDir, 'github-output.txt')
      process.env.GITHUB_OUTPUT = outputPath

      outputForGitHub(sampleResult)

      const lines = readFileSync(outputPath, 'utf-8').trim().split('\n')
      expect(lines).toEqual([
        `affected_packages=${JSON.stringify(sampleResult.all)}`,
        `affected_dirs=${JSON.stringify(sampleResult.dirNames)}`,
        `affected_count=${sampleResult.all.length}`,
        `affected_reason=${sampleResult.reason}`,
        'affected_status=computed',
      ])
      // The sentinel's whole value is that its presence proves the four
      // writes above it landed -- assert the ordering invariant directly,
      // not just set membership.
      expect(lines[lines.length - 1]).toBe('affected_status=computed')
    })

    it('promotes result.reason to an affected_reason output distinguishing the discriminator strings', () => {
      const outputPath = join(tmpDir, 'github-output.txt')
      process.env.GITHUB_OUTPUT = outputPath

      outputForGitHub({ ...sampleResult, all: [], dirNames: [], reason: 'No packages affected' })
      const noPackagesLines = readFileSync(outputPath, 'utf-8').trim().split('\n')
      expect(noPackagesLines).toContain('affected_reason=No packages affected')

      const outputPath2 = join(tmpDir, 'github-output-2.txt')
      process.env.GITHUB_OUTPUT = outputPath2
      outputForGitHub({ ...sampleResult, all: [], dirNames: [], reason: 'No files changed' })
      const noFilesLines = readFileSync(outputPath2, 'utf-8').trim().split('\n')
      expect(noFilesLines).toContain('affected_reason=No files changed')
    })

    it('still prints the affected dirs JSON array to stdout on success', () => {
      const outputPath = join(tmpDir, 'github-output.txt')
      process.env.GITHUB_OUTPUT = outputPath
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      outputForGitHub(sampleResult)

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(sampleResult.dirNames))
    })

    it('writes the step-summary block when GITHUB_STEP_SUMMARY is set and writable', () => {
      const outputPath = join(tmpDir, 'github-output.txt')
      const summaryPath = join(tmpDir, 'github-summary.md')
      process.env.GITHUB_OUTPUT = outputPath
      process.env.GITHUB_STEP_SUMMARY = summaryPath

      outputForGitHub(sampleResult)

      const summary = readFileSync(summaryPath, 'utf-8')
      expect(summary).toContain('## Affected Packages')
      expect(summary).toContain(sampleResult.reason)
    })

    it('fails loudly (exit 1) instead of silently no-op-ing when GITHUB_OUTPUT points into a nonexistent directory (S3)', () => {
      process.env.GITHUB_OUTPUT = join(tmpDir, 'nonexistent-subdir', 'output.txt')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
        throw new Error('process.exit called')
      })

      expect(() => outputForGitHub(sampleResult)).toThrow('process.exit called')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0][0]).toContain('GITHUB_OUTPUT')
    })

    it('fails loudly (exit 1) instead of silently no-op-ing when GITHUB_OUTPUT is unset', () => {
      delete process.env.GITHUB_OUTPUT
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
        throw new Error('process.exit called')
      })

      expect(() => outputForGitHub(sampleResult)).toThrow('process.exit called')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(errorSpy.mock.calls[0][0]).toContain('<unset>')
    })
  })

  describe('integration: real packages', () => {
    it('should load actual workspace packages', () => {
      const packages = loadWorkspacePackages()

      // Verify expected packages exist
      const names = packages.map((p) => p.name)
      expect(names).toContain('@skillsmith/core')
      expect(names).toContain('@skillsmith/mcp-server')
    })

    it('should build real dependency graph', () => {
      const packages = loadWorkspacePackages()
      const graph = buildDependencyGraph(packages)

      // Core should have dependents in real packages
      const coreDependents = graph.get('@skillsmith/core')
      expect(coreDependents).toBeDefined()
      expect(coreDependents!.length).toBeGreaterThan(0)
    })
  })
})
