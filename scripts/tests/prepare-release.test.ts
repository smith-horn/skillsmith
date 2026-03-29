/**
 * Tests for prepare-release script logic
 * Tests pure functions only; does not execute the script end-to-end.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

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
