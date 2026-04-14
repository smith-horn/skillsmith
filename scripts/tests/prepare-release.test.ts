/**
 * Tests for prepare-release script logic
 * Tests pure functions only; does not execute the script end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

// ESM-safe module mocks (must be declared before importing SUT).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

import {
  PACKAGE_SPECS,
  CORE_DEPENDENTS,
  ROOT_DIR,
  readPackageVersion,
  readVersionConstant,
  isValidSemver,
  incrementVersion,
  compareSemver,
} from '../lib/version-utils'

import {
  fetchNpmLatest,
  checkVersionCollision,
  type BumpPlan,
  type NpmLookup,
} from '../prepare-release'

const mockedExecFileSync = vi.mocked(execFileSync)
const mockedWriteFileSync = vi.mocked(writeFileSync)

describe('PACKAGE_SPECS configuration', () => {
  it('should define all four packages', () => {
    const names = PACKAGE_SPECS.map((s) => s.shortName)
    expect(names).toContain('core')
    expect(names).toContain('mcp-server')
    expect(names).toContain('cli')
    expect(names).toContain('vscode')
    expect(PACKAGE_SPECS).toHaveLength(4)
  })

  it('should point to existing package.json files', () => {
    for (const spec of PACKAGE_SPECS) {
      const fullPath = join(ROOT_DIR, spec.packageJsonPath)
      expect(existsSync(fullPath), `${spec.packageJsonPath} should exist`).toBe(true)
    }
  })

  it('should point to existing version constant files', () => {
    for (const spec of PACKAGE_SPECS) {
      if (spec.versionConstFile) {
        const fullPath = join(ROOT_DIR, spec.versionConstFile)
        expect(existsSync(fullPath), `${spec.versionConstFile} should exist`).toBe(true)
      }
    }
  })

  it('should have version constant patterns that match the files', () => {
    for (const spec of PACKAGE_SPECS) {
      if (spec.versionConstFile && spec.versionConstPattern) {
        const version = readVersionConstant(spec.versionConstFile, spec.versionConstPattern)
        expect(version, `${spec.versionConstFile} should have a version constant`).toBeTruthy()
        expect(isValidSemver(version!)).toBe(true)
      }
    }
  })

  it('should have server.json only for mcp-server', () => {
    const mcpServer = PACKAGE_SPECS.find((s) => s.shortName === 'mcp-server')
    const others = PACKAGE_SPECS.filter((s) => s.shortName !== 'mcp-server')
    expect(mcpServer?.serverJsonPath).toBeDefined()
    for (const spec of others) {
      expect(spec.serverJsonPath).toBeUndefined()
    }
  })
})

describe('CORE_DEPENDENTS configuration', () => {
  it('should include mcp-server, cli, and enterprise', () => {
    expect(CORE_DEPENDENTS).toContain('packages/mcp-server/package.json')
    expect(CORE_DEPENDENTS).toContain('packages/cli/package.json')
    expect(CORE_DEPENDENTS).toContain('packages/enterprise/package.json')
  })
})

describe('Version sync validation (current repo state)', () => {
  it('should have matching versions in package.json and version constants', () => {
    for (const spec of PACKAGE_SPECS) {
      const pkgVersion = readPackageVersion(spec.packageJsonPath)

      if (spec.versionConstFile && spec.versionConstPattern) {
        const constVersion = readVersionConstant(spec.versionConstFile, spec.versionConstPattern)
        expect(constVersion).toBe(
          pkgVersion,
          `${spec.name}: index.ts version should match package.json`
        )
      }
    }
  })

  it('should have matching versions in server.json', () => {
    const mcpServer = PACKAGE_SPECS.find((s) => s.shortName === 'mcp-server')!
    const pkgVersion = readPackageVersion(mcpServer.packageJsonPath)
    const serverJson = JSON.parse(readFileSync(join(ROOT_DIR, mcpServer.serverJsonPath!), 'utf-8'))

    expect(serverJson.version).toBe(pkgVersion)
    expect(serverJson.packages[0].version).toBe(pkgVersion)
  })
})

describe('resolveVersion logic', () => {
  it('should resolve bump types correctly', () => {
    expect(incrementVersion('0.4.17', 'patch')).toBe('0.4.18')
    expect(incrementVersion('0.4.17', 'minor')).toBe('0.5.0')
    expect(incrementVersion('0.4.17', 'major')).toBe('1.0.0')
  })

  it('should validate explicit versions are greater than current', () => {
    expect(compareSemver('0.4.18', '0.4.17')).toBeGreaterThan(0)
    expect(compareSemver('0.4.17', '0.4.17')).toBe(0)
    expect(compareSemver('0.4.16', '0.4.17')).toBeLessThan(0)
  })
})

// -------------------------------------------------------------
// SMI-4204: pre-publish version collision guard
// -------------------------------------------------------------

const coreSpec = PACKAGE_SPECS.find((s) => s.shortName === 'core')!

function plan(newVersion: string, current = '0.4.17'): BumpPlan {
  return { spec: coreSpec, currentVersion: current, newVersion }
}

function lookup(latest: string | null, allVersions: string[] | null = null): NpmLookup {
  return { latest, allVersions: allVersions ?? (latest === null ? null : [latest]) }
}

describe('fetchNpmLatest', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  it('returns highest semver from a versions array', async () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify(['0.4.17', '0.4.18', '0.5.0', '0.4.16']) as never
    )
    const result = await fetchNpmLatest('@skillsmith/core')
    expect(result).toBe('0.5.0')
  })

  it('returns the single version when npm returns a string', async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify('1.2.3') as never)
    const result = await fetchNpmLatest('@skillsmith/core')
    expect(result).toBe('1.2.3')
  })

  it('returns null on E404 (new package)', async () => {
    mockedExecFileSync.mockImplementation(() => {
      const err: Error & { code?: string; stderr?: string } = new Error(
        'npm ERR! code E404\nnpm ERR! 404 Not Found'
      )
      err.code = 'E404'
      err.stderr = 'npm ERR! code E404\nnpm ERR! 404 Not Found'
      throw err
    })
    const result = await fetchNpmLatest('@skillsmith/brand-new')
    expect(result).toBeNull()
  })

  it('throws on network error (fail-closed)', async () => {
    mockedExecFileSync.mockImplementation(() => {
      const err: Error & { code?: string; stderr?: string } = new Error(
        'getaddrinfo ENOTFOUND registry.npmjs.org'
      )
      err.code = 'ENOTFOUND'
      err.stderr = ''
      throw err
    })
    await expect(fetchNpmLatest('@skillsmith/core')).rejects.toThrow(/fail-closed/i)
  })

  it('throws on timeout (fail-closed)', async () => {
    mockedExecFileSync.mockImplementation(() => {
      const err: Error & { code?: string; stderr?: string } = new Error(
        'Command failed: npm view ... ETIMEDOUT'
      )
      err.code = 'ETIMEDOUT'
      err.stderr = ''
      throw err
    })
    await expect(fetchNpmLatest('@skillsmith/core')).rejects.toThrow(/fail-closed/i)
  })

  it('throws on malformed JSON (fail-closed)', async () => {
    mockedExecFileSync.mockReturnValue('not json at all' as never)
    await expect(fetchNpmLatest('@skillsmith/core')).rejects.toThrow(/fail-closed/i)
  })
})

describe('checkVersionCollision — rule matrix', () => {
  // Case 1: Proposed > npm latest → proceeds
  it('Case 1: proposed > npm latest → proceeds', () => {
    const plans = [plan('0.4.19')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: false })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  // Case 2: Proposed ≤ npm latest, no flag → refuses with suggested target
  it('Case 2: proposed < npm latest, no --allow-downgrade → refuses; error lists suggested target', () => {
    // Proposed 0.4.15 < npm latest 0.4.18, and 0.4.15 is NOT in the published list
    const plans = [plan('0.4.15')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: false })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    const msg = result.errors[0]!
    expect(msg).toContain('@skillsmith/core')
    expect(msg).toContain('0.4.15')
    expect(msg).toContain('0.4.18')
    // Suggested next-available: semver.inc('0.4.18', 'patch') === '0.4.19'
    expect(msg).toContain('0.4.19')
    expect(msg).toContain('--allow-downgrade')
  })

  // Case 3: Proposed ≤ npm latest, --allow-downgrade → proceeds
  it('Case 3: proposed < npm latest with --allow-downgrade → proceeds', () => {
    const plans = [plan('0.4.15')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: true })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  // Case 4: Proposed equals published version → refuses unconditionally; error mentions no flag
  it('Case 4a: proposed equals npm latest → refuses even with --allow-downgrade', () => {
    const plans = [plan('0.4.18')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: true })
    expect(result.ok).toBe(false)
    const msg = result.errors[0]!
    expect(msg).toContain('@skillsmith/core')
    expect(msg).toContain('0.4.18')
    // Must NOT mention any override flag name
    expect(msg).not.toMatch(/--allow-downgrade/)
    expect(msg).not.toMatch(/--force-version/)
    // Must point operator at the script and rollback guidance
    expect(msg).toContain('scripts/prepare-release.ts')
    expect(msg).toContain('revert to release, do not override')
  })

  it('Case 4b: proposed is a previously-published (but not latest) version → refuses unconditionally', () => {
    // Proposed 0.4.17 is in allVersions list but is NOT latest; Rule 3 still fires.
    const plans = [plan('0.4.17')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: true })
    expect(result.ok).toBe(false)
    const msg = result.errors[0]!
    expect(msg).not.toMatch(/--allow-downgrade/)
    expect(msg).toContain('revert to release, do not override')
  })

  // Case 6: New package (npm returns E404) → proceeds
  it('Case 6: new package (npm 404) → proceeds', () => {
    const plans = [plan('0.1.0', '0.0.0')]
    const lookups = new Map([[coreSpec.name, { latest: null, allVersions: null }]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: false })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('checkVersionCollision — writeFileSync assertions for --check mode', () => {
  // Case 5: --check with conflict → exits non-zero, writeFileSync NOT called
  // We assert this at the pure-function level: checkVersionCollision returns ok=false,
  // and (crucially) the function itself performs zero I/O. A belt-and-suspenders check
  // on writeFileSync ensures the pure function does not regress.
  it('Case 5: pure check function does not invoke writeFileSync even when conflict detected', () => {
    mockedWriteFileSync.mockClear()
    const plans = [plan('0.4.18')]
    const lookups = new Map([[coreSpec.name, lookup('0.4.18', ['0.4.17', '0.4.18'])]])
    const result = checkVersionCollision(plans, lookups, { allowDowngrade: false })
    expect(result.ok).toBe(false)
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })
})

describe('fetchNpmLatest + fail-closed integration', () => {
  // Case 7: npm unreachable (network error / timeout) → refuses (fail closed)
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  it('Case 7: npm unreachable → fetchNpmLatest throws (no override flag)', async () => {
    mockedExecFileSync.mockImplementation(() => {
      const err: Error & { code?: string; stderr?: string } = new Error('ECONNREFUSED')
      err.code = 'ECONNREFUSED'
      err.stderr = 'connect ECONNREFUSED 127.0.0.1:443'
      throw err
    })
    await expect(fetchNpmLatest('@skillsmith/core')).rejects.toThrow()
    // There is deliberately no flag to bypass this — the guard refuses closed.
  })
})

// -------------------------------------------------------------
// SMI-4188: shared-fixture parity smoke test (plan §Decision 4 / issue #2)
// Ensures the fixtures used by check-publish-collision.test.ts are also
// consumed here, so any drift in the fixture contract surfaces in both
// suites simultaneously.
// -------------------------------------------------------------

describe('SMI-4188: shared npm-view fixtures parity', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  it('core-clean fixture: fetchNpmLatest agrees with check-publish-collision on highest version', async () => {
    const fixture = readFileSync(
      join(ROOT_DIR, 'scripts/tests/fixtures/npm-view/core-clean.json'),
      'utf8'
    )
    mockedExecFileSync.mockReturnValue(fixture as never)
    const latest = await fetchNpmLatest('@skillsmith/core')
    // Same max as evaluateCollision derives in check-publish-collision.test.ts.
    expect(latest).toBe('0.5.3')
  })

  it('core-2x-overhang fixture: fetchNpmLatest surfaces the 2.x overhang (production reality)', async () => {
    const fixture = readFileSync(
      join(ROOT_DIR, 'scripts/tests/fixtures/npm-view/core-2x-overhang.json'),
      'utf8'
    )
    mockedExecFileSync.mockReturnValue(fixture as never)
    const latest = await fetchNpmLatest('@skillsmith/core')
    expect(latest).toBe('2.1.2')
  })
})
