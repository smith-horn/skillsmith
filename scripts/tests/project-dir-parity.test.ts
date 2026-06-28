/**
 * SMI-5419 W0.1 — cross-runtime parity test.
 *
 * Guards that the canonical TS resolver
 * (packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts) and its
 * plain-Node mirror (scripts/lib/project-dir.mjs) produce IDENTICAL output
 * for every input scenario.
 *
 * Isolation: each test points $HOME at a fresh temp dir (os.homedir() honours
 * $HOME on POSIX, which covers both host macOS and Docker Linux) so both
 * resolvers read a controlled ~/.claude/projects/ and never the real one.
 * Both module-scope caches are reset in beforeEach/afterEach to prevent
 * cross-test memo leakage.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as ts from '../../packages/doc-retrieval-mcp/src/retrieval-log/project-dir.js'
import * as mjs from '../lib/project-dir.mjs'

// Cast the mjs namespace to the canonical TS type so every assertion is
// fully typed and the two call sites are structurally symmetric.
const m = mjs as typeof ts

// Third mirror: the shell resolver (scripts/lib/project-dir.sh), run as a CLI
// with HOME pointed at the per-test fake home. It prints "<state>\t<encoded>".
const SHELL_MIRROR = fileURLToPath(new URL('../lib/project-dir.sh', import.meta.url))

let homeDir: string
let projectsDir: string
const origHome = process.env.HOME

/** Create a directory entry under the fake ~/.claude/projects/. */
function mkEntry(name: string): void {
  mkdirSync(join(projectsDir, name), { recursive: true })
}

/** Invoke the shell mirror CLI under the fake HOME and parse its tab output. */
function shell(args: string[]): { state: string; encoded: string } {
  const out = execFileSync('bash', [SHELL_MIRROR, ...args], {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8',
  })
  const tab = out.indexOf('\t')
  return { state: out.slice(0, tab), encoded: out.slice(tab + 1) }
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'parity-'))
  projectsDir = join(homeDir, '.claude', 'projects')
  mkdirSync(projectsDir, { recursive: true })
  process.env.HOME = homeDir
  // Reset both module-scope memos before every test.
  ts.resetProjectDirCache()
  m.resetProjectDirCache()
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
  ts.resetProjectDirCache()
  m.resetProjectDirCache()
})

// ---------------------------------------------------------------------------
// encodeProjectSegment
// ---------------------------------------------------------------------------

describe('encodeProjectSegment parity', () => {
  it('produces identical encoded string for a typical absolute path', () => {
    const input = '/Users/foo/Bar'
    expect(m.encodeProjectSegment(input)).toEqual(ts.encodeProjectSegment(input))
  })
})

// ---------------------------------------------------------------------------
// asciiFold
// ---------------------------------------------------------------------------

describe('asciiFold parity', () => {
  it('identical for mixed ASCII uppercase input', () => {
    const input = '-Users-FOO-Bar'
    expect(m.asciiFold(input)).toEqual(ts.asciiFold(input))
  })

  it('identical for a string containing non-ASCII characters (left untouched)', () => {
    // Turkish dotless-i (İ) and Nordic Æ must survive unchanged; only A-Z fold.
    const input = '-İstanbul-Æ-HELLO-World'
    expect(m.asciiFold(input)).toEqual(ts.asciiFold(input))
  })
})

// ---------------------------------------------------------------------------
// reconcileEncodedDir — all five ReconcileState values
// ---------------------------------------------------------------------------

describe('reconcileEncodedDir parity', () => {
  it('exact: computed name exists verbatim on disk', () => {
    mkEntry('-Users-foo-Bar')
    const input = '-Users-foo-Bar'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })

  it('reconciled: a single case-variant exists → adopted casing matches', () => {
    // On-disk entry uses title-case; computed uses all-lower.
    mkEntry('-Users-Foo-Bar')
    const input = '-users-foo-bar'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })

  it('anchored: correct casing borrowed from a worktree-descendant prefix', () => {
    // Claude Code stores worktree sessions as <main-encoded>--worktrees-<name>.
    // The reconciler must borrow the prefix casing (length-bounded) from that entry.
    mkEntry('-Users-Foo-Bar--worktrees-x')
    const input = '-users-foo-bar'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })

  it('ambiguous: two conflicting case-variants coexist → both returned as candidates', () => {
    mkEntry('-Users-Foo-Bar')
    mkEntry('-Users-FOO-Bar')
    const input = '-users-foo-bar'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })

  it('miss: fresh projects dir with no matching entry', () => {
    const input = '-Users-new-Project'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })

  it('miss: a LONGER sibling (substring-collision) does NOT trigger a match', () => {
    // '-Users-Foo-Barbaz' starts with '-users-foo-bar' but is longer — the
    // prefix anchor requires the candidate to START with '<computed>-', not just
    // contain the computed value as a substring. So this must resolve to miss.
    mkEntry('-Users-Foo-Barbaz')
    const input = '-users-foo-bar'
    expect(m.reconcileEncodedDir(input)).toEqual(ts.reconcileEncodedDir(input))
  })
})

// ---------------------------------------------------------------------------
// resolveClaudeProjectDir
// ---------------------------------------------------------------------------

describe('resolveClaudeProjectDir parity', () => {
  it('identical state, encoded name, and absolute dir for a reconciled cwd', () => {
    mkEntry('-Users-Foo-Bar')
    const cwd = '/Users/foo/bar'
    expect(m.resolveClaudeProjectDir(cwd)).toEqual(ts.resolveClaudeProjectDir(cwd))
  })

  it('identical for a cwd with no matching on-disk entry (miss)', () => {
    const cwd = '/Users/nobody/brand-new-project'
    expect(m.resolveClaudeProjectDir(cwd)).toEqual(ts.resolveClaudeProjectDir(cwd))
  })
})

// ---------------------------------------------------------------------------
// resolveSharedProjectDir
// ---------------------------------------------------------------------------

describe('resolveSharedProjectDir parity', () => {
  it('exact: identical result when the main repo root has a verbatim on-disk entry', () => {
    // Create a temp dir with .git as a DIRECTORY so findMainRepoRoot returns it.
    const repo = mkdtempSync(join(tmpdir(), 'repo-parity-exact-'))
    mkdirSync(join(repo, '.git'))
    const encoded = ts.encodeProjectSegment(repo)
    mkEntry(encoded) // place the entry in our fake ~/.claude/projects/
    try {
      // Call TS resolver first (after fresh reset from beforeEach), capture result.
      const tsResult = ts.resolveSharedProjectDir(repo)

      // Reset both caches so the mjs resolver also starts cold.
      ts.resetProjectDirCache()
      m.resetProjectDirCache()

      const mjsResult = m.resolveSharedProjectDir(repo)
      expect(mjsResult).toEqual(tsResult)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('miss: identical fallback to cwd encoding when no .git ancestor exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nogit-parity-'))
    try {
      const tsResult = ts.resolveSharedProjectDir(dir)

      ts.resetProjectDirCache()
      m.resetProjectDirCache()

      const mjsResult = m.resolveSharedProjectDir(dir)
      expect(mjsResult).toEqual(tsResult)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reconciled: identical result when on-disk entry has a differing case from computed', () => {
    // Use a dir whose encoded form can be matched to an on-disk case-variant.
    const repo = mkdtempSync(join(tmpdir(), 'repo-parity-reconcile-'))
    mkdirSync(join(repo, '.git'))
    // Place an upper-cased variant of the encoded name on disk.
    const computed = ts.encodeProjectSegment(repo)
    const variant = computed.toUpperCase()
    mkEntry(variant)
    try {
      const tsResult = ts.resolveSharedProjectDir(repo)

      ts.resetProjectDirCache()
      m.resetProjectDirCache()

      const mjsResult = m.resolveSharedProjectDir(repo)
      expect(mjsResult).toEqual(tsResult)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Shell mirror parity (scripts/lib/project-dir.sh) — the third runtime.
// candidates are not part of the shell contract, so we compare (state, encoded).
// ---------------------------------------------------------------------------

describe('shell mirror parity (project-dir.sh)', () => {
  it('reconcile exact', () => {
    mkEntry('-Users-foo-Bar')
    const r = ts.reconcileEncodedDir('-Users-foo-Bar')
    expect(shell(['reconcile', '-Users-foo-Bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('reconcile reconciled (case variant)', () => {
    mkEntry('-Users-Foo-Bar')
    const r = ts.reconcileEncodedDir('-users-foo-bar')
    expect(shell(['reconcile', '-users-foo-bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('reconcile anchored (worktree descendant prefix)', () => {
    mkEntry('-Users-Foo-Bar--worktrees-x')
    const r = ts.reconcileEncodedDir('-users-foo-bar')
    expect(shell(['reconcile', '-users-foo-bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('reconcile ambiguous (conflicting variants)', () => {
    mkEntry('-Users-Foo-Bar')
    mkEntry('-Users-FOO-Bar')
    const r = ts.reconcileEncodedDir('-users-foo-bar')
    expect(shell(['reconcile', '-users-foo-bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('reconcile miss (longer sibling does not match)', () => {
    mkEntry('-Users-Foo-Barbaz')
    const r = ts.reconcileEncodedDir('-users-foo-bar')
    expect(shell(['reconcile', '-users-foo-bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('reconcile miss (fresh projects dir)', () => {
    const r = ts.reconcileEncodedDir('-Users-new-Project')
    expect(shell(['reconcile', '-Users-new-Project'])).toEqual({
      state: r.state,
      encoded: r.encoded,
    })
  })

  it('reconcile reconciled when the on-disk entry is a BROKEN symlink (SMI-5419 retro L1)', () => {
    // readdirSync lists a broken symlink by name, so TS reports "reconciled".
    // The bash loop must include it too — it guards with `[ -e ] || [ -L ]`, not
    // `[ -e ]` alone (which follows the link and skips broken ones). Without that
    // guard the shell would diverge to "miss". This case fails if the guard regresses.
    symlinkSync('/nonexistent-parity-target', join(projectsDir, '-Users-Foo-Bar'))
    const r = ts.reconcileEncodedDir('-users-foo-bar')
    expect(r.state).toBe('reconciled')
    expect(shell(['reconcile', '-users-foo-bar'])).toEqual({ state: r.state, encoded: r.encoded })
  })

  it('resolve-shared exact via main repo root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-shell-exact-'))
    mkdirSync(join(repo, '.git'))
    mkEntry(ts.encodeProjectSegment(repo))
    try {
      ts.resetProjectDirCache()
      const r = ts.resolveSharedProjectDir(repo)
      expect(shell(['resolve-shared', repo])).toEqual({ state: r.state, encoded: r.encoded })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolve-shared miss when no .git ancestor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nogit-shell-'))
    try {
      ts.resetProjectDirCache()
      const r = ts.resolveSharedProjectDir(dir)
      expect(shell(['resolve-shared', dir])).toEqual({ state: r.state, encoded: r.encoded })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
