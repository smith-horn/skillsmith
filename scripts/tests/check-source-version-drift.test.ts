/**
 * SMI-5120 AC #3: tests for check-source-version-drift.mjs.
 *
 * All git/npm I/O is injected, so the gate logic is exercised with zero network
 * or git. The "frozen" case is the bench-validation plant: it flags; removing
 * ANY one gate (releases below threshold, src unchanged, version not equal to
 * published) drops it out — proving the guard catches the remedy, not just the
 * diagnosis.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluatePackage,
  runSourceDriftCheck,
  semverGt,
  isReleaseBumpSubject,
  PUBLISHABLE_SPECS,
  RELEASES_THRESHOLD,
} from '../check-source-version-drift.mjs'

const ENTERPRISE = {
  name: '@smith-horn/enterprise',
  dir: 'enterprise',
  registry: 'https://npm.pkg.github.com',
}

/** A frozen-artifact IO: high release count, src changed, version == published. */
function frozenIO(overrides = {}) {
  return {
    readVersion: () => '0.1.2',
    resolveBaselineRef: () => 'baseline-sha',
    countReleasesSince: () => RELEASES_THRESHOLD + 2,
    srcChangedSince: () => true,
    publishedLatest: () => '0.1.2',
    ...overrides,
  }
}

describe('evaluatePackage', () => {
  it('flags a frozen published artifact (all gates satisfied)', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO())
    expect(r.kind).toBe('drift')
    expect(r.pkg).toBe('@smith-horn/enterprise')
    expect(r.version).toBe('0.1.2')
    expect(r.releasesElapsed).toBe(RELEASES_THRESHOLD + 2)
    expect(r.registryUnverified).toBe(false)
  })

  it('does NOT flag when release count is below threshold (recently bumped)', () => {
    const r = evaluatePackage(
      ENTERPRISE,
      frozenIO({ countReleasesSince: () => RELEASES_THRESHOLD - 1 })
    )
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('within_threshold')
  })

  it('does NOT flag when src is unchanged since the baseline', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ srcChangedSince: () => false }))
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('src_unchanged')
  })

  it('does NOT flag when the local version is ahead of published (pending publish)', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ publishedLatest: () => '0.1.1' }))
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('pending_publish')
  })

  it('does NOT flag when the local version is behind published (check-version-drift territory)', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ publishedLatest: () => '0.2.0' }))
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('behind_npm')
  })

  it('flags on the git signal when the registry is unverifiable (GitHub Packages, no token)', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ publishedLatest: () => 'unverified' }))
    expect(r.kind).toBe('drift')
    expect(r.registryUnverified).toBe(true)
  })

  it('does NOT flag a never-published package', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ publishedLatest: () => null }))
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('not_published')
  })

  it('does NOT flag when no baseline can be resolved', () => {
    const r = evaluatePackage(ENTERPRISE, frozenIO({ resolveBaselineRef: () => null }))
    expect(r.kind).toBe('clean')
    expect(r.note).toBe('no_baseline')
  })
})

describe('runSourceDriftCheck', () => {
  it('partitions results into sourceDrifted / clean and surfaces thrown IO as errors', () => {
    const specs = [
      { name: '@frozen/pkg', dir: 'frozen' },
      { name: '@healthy/pkg', dir: 'healthy' },
      { name: '@broken/pkg', dir: 'broken' },
    ]
    const io = {
      readVersion: (dir) => {
        if (dir === 'broken') throw new Error('boom')
        return '1.0.0'
      },
      resolveBaselineRef: () => 'baseline',
      countReleasesSince: (baseline) => (baseline === 'baseline' ? RELEASES_THRESHOLD + 1 : 0),
      srcChangedSince: (_baseline, dir) => dir === 'frozen',
      publishedLatest: () => '1.0.0',
    }
    const report = runSourceDriftCheck(specs, io)
    expect(report.sourceDrifted.map((d) => d.pkg)).toEqual(['@frozen/pkg'])
    expect(report.clean.map((c) => c.pkg)).toEqual(['@healthy/pkg'])
    expect(report.errors.map((e) => e.pkg)).toEqual(['@broken/pkg'])
    // The drift entry carries no internal `kind` tag.
    expect(report.sourceDrifted[0]).not.toHaveProperty('kind')
  })
})

describe('semverGt', () => {
  it('compares 3-segment semvers and treats invalid input as not-greater', () => {
    expect(semverGt('0.2.0', '0.1.9')).toBe(true)
    expect(semverGt('0.1.2', '0.1.2')).toBe(false)
    expect(semverGt('0.1.1', '0.1.2')).toBe(false)
    expect(semverGt('not-a-version', '0.1.0')).toBe(false)
  })
})

describe('isReleaseBumpSubject (countReleasesSince fallback matcher)', () => {
  it('matches the canonical 3 release-bump commit forms', () => {
    expect(isReleaseBumpSubject('chore(release): publish 0.8.0')).toBe(true)
    expect(isReleaseBumpSubject('chore: bump version to 0.8.0')).toBe(true)
    expect(isReleaseBumpSubject('chore: bump @skillsmith/core 0.8.0')).toBe(true)
  })

  it('does not match ordinary feature/fix commits', () => {
    expect(isReleaseBumpSubject('feat(core): add widget')).toBe(false)
    expect(isReleaseBumpSubject('fix: handle null')).toBe(false)
  })
})

describe('PUBLISHABLE_SPECS drift guard', () => {
  it('stays in sync with PUBLISHABLE_PACKAGES_JSON in publish.yml', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const publishYml = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8')
    const match = publishYml.match(/PUBLISHABLE_PACKAGES_JSON:\s*'(\[[^']*\])'/)
    expect(match, 'PUBLISHABLE_PACKAGES_JSON not found in publish.yml').toBeTruthy()
    const declared = JSON.parse(match[1])
    expect(PUBLISHABLE_SPECS.map((s) => s.name).sort()).toEqual([...declared].sort())
  })

  it('marks only @smith-horn/enterprise with a non-default registry', () => {
    const withRegistry = PUBLISHABLE_SPECS.filter((s) => s.registry)
    expect(withRegistry.map((s) => s.name)).toEqual(['@smith-horn/enterprise'])
    expect(withRegistry[0].registry).toBe('https://npm.pkg.github.com')
  })
})
