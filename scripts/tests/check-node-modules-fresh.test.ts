/**
 * SMI-5343 / SMI-5344: Tests for scripts/lib/check-node-modules-fresh.sh.
 *
 * Drives the detector against an isolated temp-dir fixture — NEVER the live
 * repo tree — to prevent any mutation of the shared node_modules sentinel.
 *
 * The script resolves its repo root via `git rev-parse --show-toplevel`, so
 * each fixture is a real (minimal) git repo containing a stub
 * package-lock.json and a node_modules/ directory.
 *
 * Cases covered:
 *   P-1 FRESH:          --write-sentinel, then default check → exit 0.
 *   P-2 DRIFT:          write sentinel, mutate lockfile → check → exit 1;
 *                       output names `npm install`, does NOT contain `--no-verify`.
 *   P-3 MISSING:        no sentinel → check → exit 1; "dependencies not installed"
 *                       message present.
 *   P-4 ESCAPE HATCH:   SKILLSMITH_SKIP_DEPS_FRESHNESS=1 on drifted fixture → exit 0.
 *   P-5 NO-WRITE:       snapshot sentinel mtime/inode + node_modules listing before
 *                       a default CHECK; assert both unchanged after. Plus static
 *                       source assertion: no line executes npm install / npm ci
 *                       outside the --write-sentinel branch (tokens in comments /
 *                       printf / hint strings are tolerated).
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute path to the script under test — must be stable regardless of cwd.
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-node-modules-fresh.sh')

// Sentinel filename as declared in the script.
const SENTINEL_NAME = '.skillsmith-deps-hash'

// Unique-enough stub lockfile content for the fixture.
const STUB_LOCKFILE = JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2)
// A mutated lockfile content (different bytes → different sha256).
const STUB_LOCKFILE_MUTATED = JSON.stringify(
  { lockfileVersion: 3, packages: { 'node_modules/mutated': { version: '1.0.0' } } },
  null,
  2
)

// ── Fixture helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal git repo fixture:
 *   root/
 *     package-lock.json      (stub)
 *     node_modules/          (empty dir — represents the installed tree)
 *
 * The git init + commit ensures `git rev-parse --show-toplevel` resolves to
 * `root` when the script is invoked with `cwd: root`.
 */
function makeFixture(): { root: string; sentinel: string; lockfile: string } {
  const root = makeFixtureTempDir('freshness-test')
  const env = makeFixtureEnv()

  // Init a minimal repo so git rev-parse works.
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  const lockfile = join(root, 'package-lock.json')
  writeFileSync(lockfile, STUB_LOCKFILE, 'utf8')
  execFileSync('git', ['-C', root, 'add', 'package-lock.json'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'], { env })

  mkdirSync(join(root, 'node_modules'), { recursive: true })

  return { root, sentinel: join(root, 'node_modules', SENTINEL_NAME), lockfile }
}

/** Run the script and capture both exit status and combined stdout+stderr. */
function runScript(
  root: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {}
): { status: number; output: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      // Keep PATH so sha256sum / shasum is reachable.
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ...extraEnv,
    },
    // Capture both streams; the script writes to stdout only.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  return { status: result.status ?? 1, output }
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('check-node-modules-fresh.sh (SMI-5343/5344)', () => {
  let fixture: ReturnType<typeof makeFixture> | null = null

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture && existsSync(fixture.root)) {
      rmSync(fixture.root, { recursive: true, force: true })
    }
    fixture = null
  })

  // ── P-1 FRESH ───────────────────────────────────────────────────────────────

  it('P-1 FRESH: write-sentinel then default check exits 0', () => {
    const { root, sentinel } = fixture!

    // Write the sentinel.
    const write = runScript(root, ['--write-sentinel'])
    expect(write.status).toBe(0)
    expect(existsSync(sentinel)).toBe(true)

    // Default check should now read FRESH.
    const check = runScript(root)
    expect(check.status).toBe(0)
    expect(check.output).toBe('')
  })

  // ── P-2 DRIFT ───────────────────────────────────────────────────────────────

  it('P-2 DRIFT: stale lockfile exits 1 naming npm install but not --no-verify', () => {
    const { root, lockfile } = fixture!

    // Write sentinel against original lockfile.
    const write = runScript(root, ['--write-sentinel'])
    expect(write.status).toBe(0)

    // Mutate lockfile so sha256 changes.
    writeFileSync(lockfile, STUB_LOCKFILE_MUTATED, 'utf8')

    // Default check should detect drift.
    const check = runScript(root)
    expect(check.status).toBe(1)

    // Output must name the install remedy.
    expect(check.output).toMatch(/npm install/)

    // Must NOT suggest --no-verify (plan §2 requirement: the footgun must not
    // be advertised when drift is an environmental issue, not a code problem).
    expect(check.output).not.toMatch(/--no-verify/)
  })

  // ── P-3 MISSING SENTINEL ────────────────────────────────────────────────────

  it('P-3 MISSING SENTINEL: absent sentinel exits 1 with "not installed" message', () => {
    const { root, sentinel } = fixture!

    // Ensure no sentinel exists.
    expect(existsSync(sentinel)).toBe(false)

    const check = runScript(root)
    expect(check.status).toBe(1)

    // The script sets DRIFT_REASON="dependencies not installed — run npm install"
    // for a missing sentinel and includes it in the `(%s)` line.
    expect(check.output).toMatch(/dependencies not installed/)

    // The output should still guide toward npm install.
    expect(check.output).toMatch(/npm install/)
  })

  // ── P-4 ESCAPE HATCH ────────────────────────────────────────────────────────

  it('P-4 ESCAPE HATCH: SKILLSMITH_SKIP_DEPS_FRESHNESS=1 bypasses check even when drifted', () => {
    const { root, lockfile } = fixture!

    // Write sentinel, mutate lockfile to create drift.
    runScript(root, ['--write-sentinel'])
    writeFileSync(lockfile, STUB_LOCKFILE_MUTATED, 'utf8')

    // Without the escape hatch this should fail (sanity check).
    const checkWithoutEscape = runScript(root)
    expect(checkWithoutEscape.status).toBe(1)

    // With the escape hatch, must exit 0 silently.
    const checkWithEscape = runScript(root, [], {
      SKILLSMITH_SKIP_DEPS_FRESHNESS: '1',
    })
    expect(checkWithEscape.status).toBe(0)
    expect(checkWithEscape.output).toBe('')
  })

  // ── P-5 NO-WRITE ────────────────────────────────────────────────────────────

  it('P-5 NO-WRITE: default check does not mutate sentinel or node_modules', () => {
    const { root, lockfile, sentinel } = fixture!

    // Write sentinel so the check path runs through the comparison branch.
    runScript(root, ['--write-sentinel'])
    // Mutate lockfile to ensure the drift branch (not the early-exit fresh branch)
    // is exercised — giving the check mode the maximum opportunity to write.
    writeFileSync(lockfile, STUB_LOCKFILE_MUTATED, 'utf8')

    // Snapshot sentinel mtime + inode BEFORE the check run.
    const statBefore = statSync(sentinel)
    const inodeBefore = statBefore.ino
    const mtimeBefore = statBefore.mtimeMs

    // Snapshot node_modules listing BEFORE the check run.
    const listBefore = readdirSync(join(root, 'node_modules')).sort()

    // Run the default check (should exit 1 due to drift, but must not write).
    const check = runScript(root)
    expect(check.status).toBe(1) // confirms the drift path was taken

    // Sentinel mtime and inode must be unchanged.
    const statAfter = statSync(sentinel)
    expect(statAfter.ino).toBe(inodeBefore)
    expect(statAfter.mtimeMs).toBe(mtimeBefore)

    // node_modules listing must be unchanged.
    const listAfter = readdirSync(join(root, 'node_modules')).sort()
    expect(listAfter).toEqual(listBefore)
  })

  // ── P-6 FAIL-SOFT (no hash tool) ─────────────────────────────────────────────

  it('P-6 FAIL-SOFT: neither sha256sum nor shasum available → exit 0 without writing', () => {
    const { root, sentinel } = fixture!

    // Expose ONLY git + bash (via shims) on PATH so the script can still be
    // spawned and resolve its repo root, but finds no sha256 tool — exercising
    // the documented fail-soft branch (cannot hash → treat as fresh) in
    // isolation, without falling back to the live repo tree. (bash itself must
    // be reachable on the child PATH or spawnSync('bash', …) cannot launch it.)
    const binDir = join(root, '_isobin')
    mkdirSync(binDir, { recursive: true })
    for (const tool of ['git', 'bash']) {
      const abs = execFileSync('bash', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).trim()
      const shim = join(binDir, tool)
      writeFileSync(shim, `#!/bin/sh\nexec "${abs}" "$@"\n`, 'utf8')
      chmodSync(shim, 0o755)
    }

    const check = runScript(root, [], { PATH: binDir })
    // Fail-soft: with no sha256sum/shasum the script cannot compute a hash, so
    // it must exit 0 silently rather than emit a false drift.
    expect(check.status).toBe(0)
    expect(check.output).toBe('')
    // Check mode must never create the sentinel (P-5).
    expect(existsSync(sentinel)).toBe(false)
  })

  it('P-5 SOURCE: script source contains no npm install / npm ci execution outside --write-sentinel branch', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const lines = src.split('\n')

    // NOTE: this heuristic matches WHOLE-LINE prefixes only (comment / printf /
    // echo / `VAR=` assignment). A same-line `foo; npm install` after a
    // semicolon would be missed — the authoritative manual check is:
    //   grep -n 'npm install' scripts/lib/check-node-modules-fresh.sh

    // We are inside the --write-sentinel block from line 66 to line 81 (the
    // `exit 0` that closes it). Any `npm install` / `npm ci` token outside
    // that block is a P-5 invariant violation.
    //
    // Strategy: ignore lines that are (a) comments, (b) inside printf/echo
    // hint strings (they surface the install command TO THE USER), or (c)
    // inside the --write-sentinel branch delimited by `if [ "${1:-}"` ...
    // first standalone `exit 0`. We assert that no shell-executable npm call
    // exists by checking that every line containing `npm install` or `npm ci`
    // is either a comment, a printf/echo, or a test inside an if condition
    // (i.e. the message spec).

    const executableNpmLines = lines.filter((line) => {
      const trimmed = line.trim()
      // Whole-line comment — safe.
      if (trimmed.startsWith('#')) return false
      // printf / echo lines — these are hint strings surfaced to the user, not executed.
      if (/^\s*printf\b/.test(line) || /^\s*echo\b/.test(line)) return false
      // Variable assignment lines (e.g. `DRIFT_REASON="..."`, `_FIX_CMD="..."`,
      // `_FIX_NOTE="..."`) — these set string content later printed via printf;
      // they do NOT execute npm. A pure variable assignment has the form
      // IDENTIFIER= with optional leading whitespace and no preceding command.
      if (/^\s*[A-Z_][A-Z0-9_]*=/.test(line)) return false
      // Lines that don't mention npm install or npm ci at all — skip.
      if (!/npm\s+(install|ci)\b/.test(line)) return false
      // Anything that remains is an executable reference — flag it.
      return true
    })

    expect(executableNpmLines).toEqual([])
  })
})
