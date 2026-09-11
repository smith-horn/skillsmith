/**
 * SMI-6496 Fix 2: Tests for scripts/lib/normalize-lockfile-for-freshness.mjs.
 *
 * Uses REAL lockfile pairs pulled from this repo's own git history (via
 * `git show <rev>:<path>`) for the two cases that must prove the algorithm
 * against genuine historical diffs, not only synthetic fixtures — resolving
 * the plan review's A2 concern that a synthetic-only suite would be weaker
 * than the defect it exists to catch. Synthetic fixtures cover the two cases
 * a real commit is unlikely to isolate cleanly (an internal-dependency-edge
 * add/remove in isolation, and a combined workspace-bump + real change in
 * one diff).
 *
 * Cases:
 *   1. Real pair 0d4f294bc vs its parent (workspace-version-only,
 *      release-cadence bump) -> shadow hash EQUAL.
 *   2. Real pairs 08d8cacb0 (chalk bump) and c51db0a83 (stripe bump), each
 *      vs its own parent (genuine node_modules/* changes) -> shadow hash
 *      DIFFERS.
 *   3. Synthetic: add/remove an internal dependency edge, all other
 *      versions unchanged -> shadow hash DIFFERS (proves step 3 of the
 *      algorithm neutralizes only the VALUE of an existing edge, never the
 *      key's presence/absence).
 *   4. Synthetic: workspace-version bump + a real node_modules/* change in
 *      the same diff -> shadow hash DIFFERS (the real change is not masked
 *      by version-bump noise).
 *   5. Fail-soft contract (M4): invalid JSON, a lockfile with no "packages"
 *      map, and the CLI entrypoint's own exit code / stdout / stderr
 *      contract on failure.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { computeShadowHash } from '../lib/normalize-lockfile-for-freshness.mjs'
import { makeFixtureEnv } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_SCRIPT = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')

// package-lock.json is ~1.3MB — the default execFileSync maxBuffer (1MB)
// truncates it (ENOBUFS), so every git-show read below sets a generous cap.
const MAX_BUFFER = 1024 * 1024 * 50

// SMI-4693: this reads THIS REPO's own real history (not a throwaway
// fixture repo), but the audit-standards Audit-39 check still requires the
// sanitized env on any `git` spawn in scripts/tests/** — a bare
// `git show <rev>:<path>` is a read-only lookup, but GIT_DISCOVERY_VARS
// inherited from the vitest worker could still redirect it away from
// REPO_ROOT in principle, so sanitize regardless of read-only intent.
function showAtRev(rev: string, path: string): string {
  return execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${path}`], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: makeFixtureEnv(),
  })
}

// ── Case 1-2: real git-history pairs ────────────────────────────────────────

describe('normalize-lockfile-for-freshness.mjs — real git-history pairs (SMI-6496 Fix 2)', () => {
  it('Case 1: 0d4f294bc (release-cadence bump, workspace-version-only) vs parent -> shadow hash EQUAL', () => {
    const childLock = showAtRev('0d4f294bc', 'package-lock.json')
    const childPkg = showAtRev('0d4f294bc', 'package.json')
    const parentLock = showAtRev('0d4f294bc^', 'package-lock.json')
    const parentPkg = showAtRev('0d4f294bc^', 'package.json')

    const childHash = computeShadowHash(childLock, childPkg)
    const parentHash = computeShadowHash(parentLock, parentPkg)

    expect(childHash).toBe(parentHash)
  })

  it('Case 2a: 08d8cacb0 (chore(deps): bump chalk 5.6.2 -> 6.0.0) vs parent -> shadow hash DIFFERS', () => {
    const childLock = showAtRev('08d8cacb0', 'package-lock.json')
    const childPkg = showAtRev('08d8cacb0', 'package.json')
    const parentLock = showAtRev('08d8cacb0^', 'package-lock.json')
    const parentPkg = showAtRev('08d8cacb0^', 'package.json')

    const childHash = computeShadowHash(childLock, childPkg)
    const parentHash = computeShadowHash(parentLock, parentPkg)

    expect(childHash).not.toBe(parentHash)
  })

  it('Case 2b: c51db0a83 (chore(deps): bump stripe 20.2.0 -> 22.6.1) vs parent -> shadow hash DIFFERS', () => {
    const childLock = showAtRev('c51db0a83', 'package-lock.json')
    const childPkg = showAtRev('c51db0a83', 'package.json')
    const parentLock = showAtRev('c51db0a83^', 'package-lock.json')
    const parentPkg = showAtRev('c51db0a83^', 'package.json')

    const childHash = computeShadowHash(childLock, childPkg)
    const parentHash = computeShadowHash(parentLock, parentPkg)

    expect(childHash).not.toBe(parentHash)
  })
})

// ── Case 3-4: synthetic fixtures ────────────────────────────────────────────

const PACKAGE_JSON_TEXT = JSON.stringify({ name: 'skillsmith', workspaces: ['packages/*'] })

interface LockPackageEntry {
  name?: string
  version?: string
  workspaces?: string[]
  resolved?: string
  dependencies?: Record<string, string>
}

interface Lockfile {
  name: string
  version: string
  lockfileVersion: number
  requires: boolean
  packages: Record<string, LockPackageEntry>
}

function baseLockfile(): Lockfile {
  return {
    name: 'skillsmith',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'skillsmith', version: '0.1.0', workspaces: ['packages/*'] },
      'packages/core': {
        name: '@skillsmith/core',
        version: '0.12.2',
        dependencies: { 'left-pad': '1.0.0' },
      },
      'packages/cli': {
        name: '@skillsmith/cli',
        version: '0.8.9',
        dependencies: { '@skillsmith/core': '^0.12.2' },
      },
      'node_modules/left-pad': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
      },
    },
  }
}

// Deep-enough clone for these fixtures (no functions/Dates in the shape).
function clone(value: Lockfile): Lockfile {
  return JSON.parse(JSON.stringify(value)) as Lockfile
}

/** Test-only helper: fetch a `packages[key]` entry, asserting it exists — these
 * fixtures are constructed by this same file, so a missing key is a bug in
 * the test itself, not a real "possibly undefined" case worth handling. */
function entryAt(lock: Lockfile, key: string): LockPackageEntry {
  const entry = lock.packages[key]
  if (!entry) throw new Error(`fixture bug: no packages["${key}"] entry`)
  return entry
}

function depsOf(entry: LockPackageEntry): Record<string, string> {
  if (!entry.dependencies) throw new Error('fixture bug: entry has no dependencies object')
  return entry.dependencies
}

describe('normalize-lockfile-for-freshness.mjs — synthetic fixtures (SMI-6496 Fix 2)', () => {
  it('Case 3a: adding an internal dependency edge -> shadow hash DIFFERS', () => {
    const a = baseLockfile()
    const b = clone(a)
    depsOf(entryAt(b, 'packages/cli'))['@skillsmith/mcp-server'] = '^0.7.0'
    b.packages['packages/mcp-server'] = { name: '@skillsmith/mcp-server', version: '0.7.0' }

    const hashA = computeShadowHash(JSON.stringify(a), PACKAGE_JSON_TEXT)
    const hashB = computeShadowHash(JSON.stringify(b), PACKAGE_JSON_TEXT)

    expect(hashA).not.toBe(hashB)
  })

  it('Case 3b: removing an internal dependency edge -> shadow hash DIFFERS', () => {
    const a = baseLockfile()
    depsOf(entryAt(a, 'packages/cli'))['@skillsmith/mcp-server'] = '^0.7.0'
    a.packages['packages/mcp-server'] = { name: '@skillsmith/mcp-server', version: '0.7.0' }
    const b = baseLockfile()

    const hashA = computeShadowHash(JSON.stringify(a), PACKAGE_JSON_TEXT)
    const hashB = computeShadowHash(JSON.stringify(b), PACKAGE_JSON_TEXT)

    expect(hashA).not.toBe(hashB)
  })

  it('Case 3c (control): only the VALUE of an existing internal edge changes -> shadow hash EQUAL', () => {
    // Same shape as a real workspace-version bump: the key set is
    // unchanged, only the version numbers move. This is the case the
    // algorithm exists to treat as cosmetic.
    const a = baseLockfile()
    const b = clone(a)
    entryAt(b, 'packages/core').version = '0.12.3'
    depsOf(entryAt(b, 'packages/cli'))['@skillsmith/core'] = '^0.12.3'

    const hashA = computeShadowHash(JSON.stringify(a), PACKAGE_JSON_TEXT)
    const hashB = computeShadowHash(JSON.stringify(b), PACKAGE_JSON_TEXT)

    expect(hashA).toBe(hashB)
  })

  it('Case 4: workspace-version bump combined with a real node_modules/* change -> shadow hash DIFFERS', () => {
    const a = baseLockfile()
    const b = clone(a)
    // Workspace-version-only part (would be neutral on its own — see Case 3c).
    entryAt(b, 'packages/core').version = '0.12.3'
    depsOf(entryAt(b, 'packages/cli'))['@skillsmith/core'] = '^0.12.3'
    // Real node_modules/* change riding along in the same diff — must NOT
    // be hidden behind the version-bump noise above.
    entryAt(b, 'node_modules/left-pad').version = '1.3.0'
    depsOf(entryAt(b, 'packages/core'))['left-pad'] = '1.3.0'

    const hashA = computeShadowHash(JSON.stringify(a), PACKAGE_JSON_TEXT)
    const hashB = computeShadowHash(JSON.stringify(b), PACKAGE_JSON_TEXT)

    expect(hashA).not.toBe(hashB)
  })

  it('workspace-self entry with no "name" field falls back to the directory basename (packages/skillsmith-cli shape)', () => {
    // npm omits packages["<key>"].name when it equals the directory's own
    // basename. Confirmed live against this repo's own lockfile:
    // packages/skillsmith-cli has no "name" field at all. If the `?? basename(key)`
    // fallback were missing, this workspace would silently drop out of the
    // internal-name set and an edge referencing it would NOT be neutralized.
    const a = baseLockfile()
    a.packages['packages/skillsmith-cli'] = { version: '0.5.3' } // no "name" key
    depsOf(entryAt(a, 'packages/cli'))['skillsmith-cli'] = '^0.5.2'
    const b = clone(a)
    b.packages['packages/skillsmith-cli'] = { version: '0.5.3' } // unchanged version
    depsOf(entryAt(b, 'packages/cli'))['skillsmith-cli'] = '^0.5.3' // range bump, same shape as a workspace-version bump

    const hashA = computeShadowHash(JSON.stringify(a), PACKAGE_JSON_TEXT)
    const hashB = computeShadowHash(JSON.stringify(b), PACKAGE_JSON_TEXT)

    // Both reference the SAME unchanged "packages/skillsmith-cli" version
    // (0.5.3) — the only thing that moved is the cli's declared range on it,
    // which is only cosmetic if "skillsmith-cli" was correctly recognized
    // as an internal name via the basename fallback.
    expect(hashA).toBe(hashB)
  })
})

// ── Case 5: fail-soft contract (M4) ─────────────────────────────────────────

describe('normalize-lockfile-for-freshness.mjs — fail-soft contract (SMI-6496 Fix 2, M4)', () => {
  it('computeShadowHash throws on invalid lockfile JSON', () => {
    expect(() => computeShadowHash('{not valid json', PACKAGE_JSON_TEXT)).toThrow()
  })

  it('computeShadowHash throws when the lockfile has no "packages" map', () => {
    expect(() =>
      computeShadowHash(JSON.stringify({ lockfileVersion: 3 }), PACKAGE_JSON_TEXT)
    ).toThrow()
  })

  it('computeShadowHash treats a non-array/missing "workspaces" as zero internal names, not a throw', () => {
    const lock = JSON.stringify({
      packages: { '': { name: 'skillsmith' }, 'packages/core': { name: '@skillsmith/core' } },
    })
    expect(() => computeShadowHash(lock, JSON.stringify({ name: 'skillsmith' }))).not.toThrow()
  })

  describe('CLI entrypoint', () => {
    it('exits 1 with no stdout and a one-line stderr reason on a missing lockfile', () => {
      const dir = mkdtempSync(join(tmpdir(), 'shadow-hash-cli-'))
      const pkgPath = join(dir, 'package.json')
      writeFileSync(pkgPath, PACKAGE_JSON_TEXT, 'utf8')

      const result = spawnSync('node', [CLI_SCRIPT, join(dir, 'does-not-exist.json'), pkgPath], {
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/\[normalize-lockfile-for-freshness\]/)

      rmSync(dir, { recursive: true, force: true })
    })

    it('exits 0 and prints exactly the hex sha256 shadow hash to stdout on success', () => {
      const dir = mkdtempSync(join(tmpdir(), 'shadow-hash-cli-'))
      const lockPath = join(dir, 'package-lock.json')
      const pkgPath = join(dir, 'package.json')
      writeFileSync(lockPath, JSON.stringify(baseLockfile()), 'utf8')
      writeFileSync(pkgPath, PACKAGE_JSON_TEXT, 'utf8')

      const result = spawnSync('node', [CLI_SCRIPT, lockPath, pkgPath], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
      expect(result.stderr).toBe('')

      rmSync(dir, { recursive: true, force: true })
    })
  })
})
