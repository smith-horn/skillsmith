/**
 * SMI-5120: @smith-horn/enterprise release-tooling assertions.
 *
 * Lives in a sibling file because prepare-release.test.ts already exceeds the
 * 500-line file-length budget; new assertions must not push it further.
 *
 * Covers:
 *   1. enterprise is present in PACKAGE_SPECS with the correct shape.
 *   2. enterprise is registry-aware (publishes to GitHub Packages, not npmjs).
 *   3. the npm-existence check (resolveNpmLookups → npm view) is issued
 *      against the GitHub Packages registry for enterprise and against the
 *      default (npmjs) registry for @skillsmith/* packages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { PACKAGE_SPECS } from '../lib/version-utils'
import { resolveNpmLookups, type BumpPlan } from '../prepare-release'

const mockedExecFileSync = vi.mocked(execFileSync)

const enterpriseSpec = PACKAGE_SPECS.find((s) => s.shortName === 'enterprise')!
const coreSpec = PACKAGE_SPECS.find((s) => s.shortName === 'core')!

describe('SMI-5120: enterprise PACKAGE_SPECS entry', () => {
  it('is present and points at packages/enterprise', () => {
    expect(enterpriseSpec).toBeDefined()
    expect(enterpriseSpec.name).toBe('@smith-horn/enterprise')
    expect(enterpriseSpec.dir).toBe('packages/enterprise')
    expect(enterpriseSpec.packageJsonPath).toBe('packages/enterprise/package.json')
  })

  it('has no version constant file or server.json (version lives only in package.json)', () => {
    expect(enterpriseSpec.versionConstFile).toBeUndefined()
    expect(enterpriseSpec.versionConstPattern).toBeUndefined()
    expect(enterpriseSpec.serverJsonPath).toBeUndefined()
  })

  it('is registry-aware: targets GitHub Packages, not npmjs', () => {
    expect(enterpriseSpec.registry).toBe('https://npm.pkg.github.com')
  })

  it('does NOT skip dep-range updates (it consumes @skillsmith/core)', () => {
    // enterprise's @skillsmith/core dep range must be bumped by
    // updateWorkspaceDependencies, so skipDepRangeUpdate must be falsy.
    expect(enterpriseSpec.skipDepRangeUpdate).toBeFalsy()
  })

  it('@skillsmith/* specs have no registry override (default npmjs)', () => {
    for (const spec of PACKAGE_SPECS) {
      if (spec.name.startsWith('@skillsmith/')) {
        expect(spec.registry, `${spec.name} should use the default registry`).toBeUndefined()
      }
    }
  })
})

describe('SMI-5120: resolveNpmLookups registry-awareness', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  function planFor(spec: (typeof PACKAGE_SPECS)[number], newVersion: string): BumpPlan {
    return { spec, currentVersion: '0.0.0', newVersion }
  }

  it('issues npm view against GitHub Packages for enterprise (--registry flag present)', async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify(['0.1.0', '0.1.1', '0.1.2']) as never)

    await resolveNpmLookups([planFor(enterpriseSpec, '0.1.3')])

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockedExecFileSync.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual([
      'view',
      '@smith-horn/enterprise',
      'versions',
      '--json',
      '--registry=https://npm.pkg.github.com',
    ])
  })

  it('does NOT add a --registry flag for default-registry packages (@skillsmith/core)', async () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify(['0.7.1', '0.7.2']) as never)

    await resolveNpmLookups([planFor(coreSpec, '0.7.3')])

    const [cmd, args] = mockedExecFileSync.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual(['view', '@skillsmith/core', 'versions', '--json'])
    expect((args as string[]).some((a) => a.startsWith('--registry'))).toBe(false)
  })

  it('records enterprise lookup against its registry without a false npmjs 404', async () => {
    // GitHub Packages returns the real published list; resolveNpmLookups must
    // surface it (latest computed from the live list), not null-as-new-package.
    mockedExecFileSync.mockReturnValue(JSON.stringify(['0.1.0', '0.1.1', '0.1.2']) as never)

    const lookups = await resolveNpmLookups([planFor(enterpriseSpec, '0.1.3')])
    const lookup = lookups.get('@smith-horn/enterprise')!

    expect(lookup.allVersions).toEqual(['0.1.0', '0.1.1', '0.1.2'])
    expect(lookup.latest).toBe('0.1.2')
  })

  it('degrades gracefully (no throw) when a registry lookup is unauthenticated (E401)', async () => {
    // The documented local prepare-release flow has no GitHub Packages token, so
    // npm returns E401 for enterprise. A registry-targeted lookup must warn +
    // proceed (allVersions=null) rather than fail-close the whole release.
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error('npm error code E401') as Error & { stderr?: string }
      err.stderr = 'npm error code E401\nnpm error 401 Unauthorized'
      throw err
    })

    const lookups = await resolveNpmLookups([planFor(enterpriseSpec, '0.1.3')])
    const lookup = lookups.get('@smith-horn/enterprise')!

    expect(lookup.allVersions).toBeNull()
    expect(lookup.latest).toBeNull()
  })

  it('still fail-closes (throws) for a default-registry package on a non-404 error', async () => {
    // npmjs packages have no registry override; a non-404 error must NOT be
    // swallowed (the auth-degradation path is gated on spec.registry being set).
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error('npm error code E401') as Error & { stderr?: string }
      err.stderr = 'npm error code E401\nnpm error 401 Unauthorized'
      throw err
    })

    await expect(resolveNpmLookups([planFor(coreSpec, '0.7.3')])).rejects.toThrow(/fail-closed/)
  })
})
