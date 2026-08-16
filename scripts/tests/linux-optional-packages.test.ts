/**
 * SMI-6050 Wave 1 — tests for scripts/lib/linux-optional-packages.mjs.
 *
 * See docs/internal/implementation/smi-6050-worktree-linux-optional-platform-binaries.md
 * ("What Changes" #1). Fixture-based: a minimal synthetic
 * package-lock.json-shaped object covering root-level, nested-under-a-
 * dependency, denylisted, and non-linux positions, plus CPU/libc variant
 * pairs and a same-family/different-nesting-depth pair — the exact shapes
 * the plan doc's Wave 1 Step 2 calls out.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deriveLinuxOptionalPackagePaths,
  resolveVersionMarker,
} from '../lib/linux-optional-packages.mjs'

const scratchDirs: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linux-optional-packages-test-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Writes a synthetic package-lock.json fixture to a fresh scratch dir and
 * returns its path. `packages` is merged onto a minimal root ("") entry so
 * every fixture is a structurally-valid lockfile.
 */
function writeFixtureLockfile(packages: Record<string, unknown>): string {
  const dir = scratchDir()
  const lockfilePath = join(dir, 'package-lock.json')
  writeFileSync(
    lockfilePath,
    JSON.stringify(
      {
        name: 'linux-optional-packages-fixture',
        version: '0.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'linux-optional-packages-fixture', version: '0.0.0' },
          ...packages,
        },
      },
      null,
      2
    )
  )
  return lockfilePath
}

describe('deriveLinuxOptionalPackagePaths', () => {
  it('returns a root-level linux-only entry', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@turbo/linux-arm64': {
        version: '2.9.14',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([
      'node_modules/@turbo/linux-arm64',
    ])
  })

  it('returns a nested-under-dependency linux-only entry with its full relative path intact', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu': {
        version: '1.2.4',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([
      'node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu',
    ])
  })

  it('excludes a denylisted-family entry (@napi-rs/keyring-linux-*)', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@napi-rs/keyring-linux-arm64-gnu': {
        version: '1.2.0',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([])
  })

  it('excludes @supabase/cli-linux-* and @vscode/vsce-sign-linux-*', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@supabase/cli-linux-arm64': {
        version: '2.111.0',
        os: ['linux'],
        cpu: ['arm64'],
      },
      'node_modules/@vscode/vsce-sign-linux-arm64': {
        version: '2.0.6',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([])
  })

  it('does NOT exclude @cloudflare/workerd-linux-* (reversed during plan-review)', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@cloudflare/workerd-linux-arm64': {
        version: '1.20260714.1',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([
      'node_modules/@cloudflare/workerd-linux-arm64',
    ])
  })

  it('excludes a non-linux entry (os: ["darwin"])', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@turbo/darwin-arm64': {
        version: '2.9.14',
        os: ['darwin'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([])
  })

  it('excludes an entry with no os field at all', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/lodash': {
        version: '4.17.21',
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([])
  })

  it('returns both entries of a CPU/libc-variant pair as distinct entries', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/lightningcss-linux-arm64-gnu': {
        version: '1.33.0',
        os: ['linux'],
        cpu: ['arm64'],
      },
      'node_modules/lightningcss-linux-x64-gnu': {
        version: '1.33.0',
        os: ['linux'],
        cpu: ['x64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([
      'node_modules/lightningcss-linux-arm64-gnu',
      'node_modules/lightningcss-linux-x64-gnu',
    ])
  })

  it('keeps two same-family entries at different nesting depths distinct', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@rolldown/binding-linux-arm64-gnu': {
        version: '1.5.0',
        os: ['linux'],
        cpu: ['arm64'],
      },
      'node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu': {
        version: '1.2.4',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    const result = deriveLinuxOptionalPackagePaths(lockfilePath)
    expect(result).toHaveLength(2)
    expect(result).toContain('node_modules/@rolldown/binding-linux-arm64-gnu')
    expect(result).toContain('node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu')
    // Distinguishable as separate strings, not deduplicated by family name.
    expect(new Set(result).size).toBe(2)
  })

  it('returns zero matches (empty array, not a throw) when nothing is linux-only', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/lodash': { version: '4.17.21' },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([])
  })

  it('returns results sorted lexicographically', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@turbo/linux-x64': { version: '2.9.14', os: ['linux'], cpu: ['x64'] },
      'node_modules/@astrojs/compiler-binding-linux-arm64-gnu': {
        version: '0.3.2',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(deriveLinuxOptionalPackagePaths(lockfilePath)).toEqual([
      'node_modules/@astrojs/compiler-binding-linux-arm64-gnu',
      'node_modules/@turbo/linux-x64',
    ])
  })
})

describe('resolveVersionMarker', () => {
  it('returns the correct version string for a given path', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@turbo/linux-arm64': {
        version: '2.9.14',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(resolveVersionMarker(lockfilePath, 'node_modules/@turbo/linux-arm64')).toBe('2.9.14')
  })

  it('resolves distinct versions for same-family entries at different nesting depths', () => {
    const lockfilePath = writeFixtureLockfile({
      'node_modules/@rolldown/binding-linux-arm64-gnu': {
        version: '1.5.0',
        os: ['linux'],
        cpu: ['arm64'],
      },
      'node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu': {
        version: '1.2.4',
        os: ['linux'],
        cpu: ['arm64'],
      },
    })
    expect(
      resolveVersionMarker(lockfilePath, 'node_modules/@rolldown/binding-linux-arm64-gnu')
    ).toBe('1.5.0')
    expect(
      resolveVersionMarker(
        lockfilePath,
        'node_modules/astro/node_modules/@rolldown/binding-linux-arm64-gnu'
      )
    ).toBe('1.2.4')
  })

  it('throws a diagnosable error for a path with no lockfile entry', () => {
    const lockfilePath = writeFixtureLockfile({})
    expect(() => resolveVersionMarker(lockfilePath, 'node_modules/does-not-exist')).toThrow(
      /no resolved "version" found/
    )
  })
})
