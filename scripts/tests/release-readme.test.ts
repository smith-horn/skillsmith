/**
 * Tests for scripts/lib/release-readme.ts (SMI-5663 Wave 1) — README "What's
 * New" sync, the missing half of the fix for Check 60 (SMI-5613) failing every
 * release-cadence PR since 2026-08-02.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

// ESM-safe module mock (must be declared before importing SUT) — matches the
// convention in scripts/tests/prepare-release.test.ts and
// scripts/tests/release-git.test.ts. All three fs functions are wrapped so
// individual tests can override read-side behavior for synthetic fixtures
// while defaulting to calling through to the real implementation (needed by
// the "real repo packages" tests below, which read this repo's actual
// packages/*/README.md files).
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync),
  }
})

import { syncReadmeWhatsNew } from '../lib/release-readme'
import { PACKAGE_SPECS, ROOT_DIR, type PackageSpec } from '../lib/version-utils'
import type { BumpPlan } from '../lib/release-collision'

const mockedWriteFileSync = vi.mocked(writeFileSync)
const mockedReadFileSync = vi.mocked(readFileSync)
const mockedExistsSync = vi.mocked(existsSync)

function planFor(shortName: string, newVersion: string): BumpPlan {
  const spec = PACKAGE_SPECS.find((s) => s.shortName === shortName)!
  return { spec, currentVersion: '0.0.0', newVersion }
}

describe('syncReadmeWhatsNew — real repo packages (SMI-5663 Wave 1)', () => {
  beforeEach(() => {
    mockedWriteFileSync.mockClear()
    // Critical: prevent the spy from calling through to the real
    // writeFileSync — this test must never mutate the working tree's READMEs.
    mockedWriteFileSync.mockImplementation(() => {})
  })

  it('updates and stages the README for each of the 3 packages that carry a "What\'s New" section', () => {
    const plans = [
      planFor('core', '9.9.9'),
      planFor('cli', '9.9.9'),
      planFor('mcp-server', '9.9.9'),
    ]

    const { updated } = syncReadmeWhatsNew(plans)

    expect(updated).toContain('packages/core/README.md')
    expect(updated).toContain('packages/cli/README.md')
    expect(updated).toContain('packages/mcp-server/README.md')
    expect(updated).toHaveLength(3)
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(3)
  })

  it('writes the new heading text into the file content passed to writeFileSync', () => {
    syncReadmeWhatsNew([planFor('core', '9.9.9')])

    const write = mockedWriteFileSync.mock.calls.find((c) =>
      String(c[0]).endsWith('packages/core/README.md')
    )
    expect(write).toBeDefined()
    const writtenContent = String(write![1])
    expect(writtenContent).toContain("## What's New in v9.9.9")
    // The real core README's own current heading version must be gone.
    expect(writtenContent).not.toMatch(/^## What's New in v(?!9\.9\.9)/m)
  })

  it("also rewrites the core README's TOC anchor to match the new version", () => {
    syncReadmeWhatsNew([planFor('core', '9.9.9')])

    const write = mockedWriteFileSync.mock.calls.find((c) =>
      String(c[0]).endsWith('packages/core/README.md')
    )
    const writtenContent = String(write![1])
    expect(writtenContent).toContain('#whats-new-in-v999')
  })

  it('skips packages with no "What\'s New" section at all (enterprise) without writing or throwing', () => {
    const enterprisePlan = planFor('enterprise', '9.9.9')
    expect(existsSync(join(ROOT_DIR, 'packages/enterprise/README.md'))).toBe(true)

    const { updated } = syncReadmeWhatsNew([enterprisePlan])

    expect(updated).not.toContain('packages/enterprise/README.md')
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })

  it('skips a package with no README.md at all without throwing', () => {
    const fakeSpec: PackageSpec = {
      name: '@fake/package',
      shortName: 'fake',
      dir: 'packages/does-not-exist',
      packageJsonPath: 'packages/does-not-exist/package.json',
    }
    const plan: BumpPlan = { spec: fakeSpec, currentVersion: '1.0.0', newVersion: '1.0.1' }

    const { updated } = syncReadmeWhatsNew([plan])

    expect(updated).toHaveLength(0)
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })

  it('is a no-op returning an empty updated list for an empty plans array', () => {
    expect(syncReadmeWhatsNew([])).toEqual({ updated: [] })
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })
})

describe('syncReadmeWhatsNew — fail-closed on a malformed/ambiguous heading (SMI-5663 Wave 1)', () => {
  // These scenarios can't be reproduced against real repo READMEs (none are
  // malformed today), so this block overrides the read-side fs mocks for a
  // synthetic package that "exists" only inside the mock.
  const fixtureSpec: PackageSpec = {
    name: '@fixture/pkg',
    shortName: 'fixture-pkg',
    dir: 'packages/fixture-pkg',
    packageJsonPath: 'packages/fixture-pkg/package.json',
  }
  const fixturePlan: BumpPlan = {
    spec: fixtureSpec,
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
  }

  beforeEach(() => {
    mockedWriteFileSync.mockClear()
    mockedWriteFileSync.mockImplementation(() => {})
    mockedExistsSync.mockReset()
    mockedExistsSync.mockReturnValue(true)
  })

  // This is the last describe block in the file — readFileSync/existsSync are
  // left permanently overridden after it runs rather than restored to a
  // call-through default, since nothing later in this file needs real reads.
  afterEach(() => {
    mockedReadFileSync.mockReset()
  })

  it('throws when the README has a "What\'s New" heading with no parseable version', () => {
    mockedReadFileSync.mockReturnValue(
      "# Fixture\n\n## What's New\n\n- Bullet with no version\n" as unknown as Buffer
    )

    expect(() => syncReadmeWhatsNew([fixturePlan])).toThrow(
      /no "## What's New in vX\.Y\.Z" heading found/
    )
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })

  it('throws (does not silently pick the first match) when two headings exist', () => {
    mockedReadFileSync.mockReturnValue(
      "## What's New in v1.0.0\n\n- Bullet\n\n## Archive\n\n## What's New in v0.9.0\n\n- Old\n" as unknown as Buffer
    )

    expect(() => syncReadmeWhatsNew([fixturePlan])).toThrow(/ambiguous/)
    expect(mockedWriteFileSync).not.toHaveBeenCalled()
  })
})
