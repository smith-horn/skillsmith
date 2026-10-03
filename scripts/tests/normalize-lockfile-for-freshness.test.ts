/**
 * SMI-6496 Fix 2: Tests for scripts/lib/normalize-lockfile-for-freshness.mjs.
 *
 * Cases 1-2 use COMMITTED FIXTURE FILES (scripts/tests/fixtures/
 * normalize-lockfile-for-freshness/) — trimmed slices of this repo's own
 * package-lock.json at three real commits, extracted once on the host and
 * checked in with provenance comments — rather than reading live git
 * history via `git show`. That is a deliberate correction, not a style
 * choice: a `git show`-based version of this test passed standalone on the
 * host but failed under pre-push, which runs tests inside the worktree
 * container. `git worktree add` always writes an ABSOLUTE gitdir path, and
 * that host path does not exist inside any worktree container — so
 * `git -C /app show <rev>:<path>` fails with "fatal: not a git repository"
 * unconditionally in-container, regardless of which rev or path is asked
 * for. Fixture files make this test's environment-sensitivity zero: same
 * content, same result, on the host and in the container. See the fixture
 * directory's own README.md for the full mechanism and regeneration
 * instructions. Synthetic fixtures (cases 3-4 below) already worked this
 * way; this makes cases 1-2 match.
 *
 * Cases:
 *   1. Fixture pair for 0d4f294bc vs its parent (workspace-version-only,
 *      release-cadence bump) -> shadow hash EQUAL.
 *   2. Fixture pairs for 08d8cacb0 (chalk bump) and c51db0a83 (stripe bump),
 *      each vs its own parent (genuine external-dependency changes, zero
 *      workspace-self version movement) -> shadow hash DIFFERS.
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
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { computeShadowHash } from '../lib/normalize-lockfile-for-freshness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_SCRIPT = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')
const FIXTURE_DIR = resolve(__dirname, 'fixtures', 'normalize-lockfile-for-freshness')

const SHARED_PACKAGE_JSON = readFileSync(join(FIXTURE_DIR, 'package.json'), 'utf8')

function readFixtureLock(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.package-lock.json`), 'utf8')
}

// ── Case 1-2: real-commit fixture pairs (committed, not live git history) ──

describe('normalize-lockfile-for-freshness.mjs — real-commit fixture pairs (SMI-6496 Fix 2)', () => {
  it('Case 1: 0d4f294bc (release-cadence bump, workspace-version-only) vs parent -> shadow hash EQUAL', () => {
    const childHash = computeShadowHash(
      readFixtureLock('case1-release-bump.child'),
      SHARED_PACKAGE_JSON
    )
    const parentHash = computeShadowHash(
      readFixtureLock('case1-release-bump.parent'),
      SHARED_PACKAGE_JSON
    )

    expect(childHash).toBe(parentHash)
  })

  it('Case 2a: 08d8cacb0 (chore(deps): bump chalk 5.6.2 -> 6.0.0) vs parent -> shadow hash DIFFERS', () => {
    const childHash = computeShadowHash(
      readFixtureLock('case2a-chalk-bump.child'),
      SHARED_PACKAGE_JSON
    )
    const parentHash = computeShadowHash(
      readFixtureLock('case2a-chalk-bump.parent'),
      SHARED_PACKAGE_JSON
    )

    expect(childHash).not.toBe(parentHash)
  })

  it('Case 2b: c51db0a83 (chore(deps): bump stripe 20.2.0 -> 22.6.1) vs parent -> shadow hash DIFFERS', () => {
    const childHash = computeShadowHash(
      readFixtureLock('case2b-stripe-bump.child'),
      SHARED_PACKAGE_JSON
    )
    const parentHash = computeShadowHash(
      readFixtureLock('case2b-stripe-bump.parent'),
      SHARED_PACKAGE_JSON
    )

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
