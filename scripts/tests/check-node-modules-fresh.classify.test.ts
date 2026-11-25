/**
 * SMI-6606 / SMI-6614 (ADR-157/ADR-158) — behavioural corpus for
 * `scripts/lib/check-node-modules-fresh.sh --classify` and its check-mode
 * re-expression (T-A in the plan doc:
 * docs/internal/implementation/smi-6614-6606-lockfile-drift-classifier.md).
 *
 * ADR-157 obligations this file satisfies:
 *   B-1 — every lockfile/package.json pair is built from a harness-owned
 *         base object below (`baseLock()`/`BASE_PACKAGE_JSON`). The
 *         normalizer (`normalize-lockfile-for-freshness.mjs`) is NEVER
 *         imported or invoked to construct a case or its expected verdict —
 *         only the real `--classify`/check-mode invocations of the real
 *         `check-node-modules-fresh.sh` (which itself shells out to the real
 *         normalizer as part of the artifact under test) decide the verdict.
 *   B-2 — the 'B-2 paired differ-check' test below pairs every poisoned case
 *         with its own clean counterpart and asserts, BEFORE either side
 *         ever runs, both that the input lockfile bytes differ AND that the
 *         two EXPECTED verdicts differ — not just "poisoned differs from the
 *         base", which alone wouldn't catch two expectations collapsing to
 *         the same token.
 *   B-3 — the final `afterAll` hook prints `cases=… clean=… poisoned=…
 *         unknown=…` and fails if the executed count is 0 or does not equal
 *         the pinned count in fixtures/deps-drift-corpus.expected-count (a
 *         separate file, so bumping it is a deliberate, reviewable edit).
 *
 * Each case builds a real (small) git repo fixture containing:
 *   - package.json (workspaces: ["packages/*"], static across all cases)
 *   - package-lock.json (mutated per case from the shared base)
 *   - scripts/lib/normalize-lockfile-for-freshness.mjs — a COPY of the real,
 *     committed file (the SUT's own dependency, not harness-generated
 *     content — copying it is not the B-1 violation; using it to COMPUTE an
 *     expected hash/verdict would be).
 *   - node_modules/ with sentinels written via the real `--write-sentinel`.
 *
 * Base lockfile shape (lockfileVersion 3):
 *   ""                          — root workspace-self entry
 *   packages/a                  — workspace-self entry, external dep edge
 *   packages/b                  — workspace-self entry, INTERNAL dep edge (a)
 *   node_modules/a, node_modules/b — link entries for the two workspaces
 *   node_modules/external-x     — a real external dependency
 *   packages/a/node_modules/y   — a nested (non-workspace-self) entry
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
  copyFileSync,
} from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-node-modules-fresh.sh')
const NORMALIZE_SRC = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')
const NEEDS_INSTALL_SRC = resolve(__dirname, '..', 'lib', 'lockfile-change-needs-install.mjs')
const EXPECTED_COUNT_FILE = resolve(__dirname, 'fixtures', 'deps-drift-corpus.expected-count')

// ── B-1: harness-owned base objects (never derived from the normalizer) ────

const BASE_PACKAGE_JSON = { name: 'root', version: '1.0.0', workspaces: ['packages/*'] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseLock(): any {
  return {
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', version: '1.0.0', workspaces: ['packages/*'] },
      'packages/a': { name: 'a', version: '1.0.0', dependencies: { 'external-x': '^0.3.11' } },
      'packages/b': { name: 'b', version: '1.0.0', dependencies: { a: '^1.0.0' } },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/b': { resolved: 'packages/b', link: true },
      'node_modules/external-x': {
        version: '0.3.11',
        resolved: 'https://registry.npmjs.org/external-x/-/external-x-0.3.11.tgz',
        integrity: 'sha512-AAAA',
      },
      'packages/a/node_modules/y': { version: '2.0.0' },
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(o: any): any {
  return JSON.parse(JSON.stringify(o))
}

// Named mutation builders — each takes a clone of baseLock() and returns a
// mutated clone. Composable (A1/S1 apply more than one).
const mutate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C2: (l: any) => {
    l.packages[''].version = '1.0.1'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  C3: (l: any) => {
    l.packages['packages/b'].dependencies.a = '^1.0.1'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P1: (l: any) => {
    l.packages['node_modules/external-x'].version = '0.3.12'
    l.packages['node_modules/external-x'].integrity = 'sha512-BBBB'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P2: (l: any) => {
    l.packages['packages/b'].dependencies.a = 'github:someone/fork#main'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P3: (l: any) => {
    l.packages['packages/a'].dependencies['new-dep'] = '^1.0.0'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P4: (l: any) => {
    l.packages['packages/a/node_modules/y'].version = '2.0.1'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P5: (l: any) => {
    l.packages['node_modules/a'].resolved = 'packages/a-fork'
    return l
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P6: (l: any) => {
    l.lockfileVersion = 2
    return l
  },
}

// ── fixture plumbing ─────────────────────────────────────────────────────

interface Fixture {
  root: string
}

function makeFixture(): Fixture {
  const root = makeFixtureTempDir('deps-classify-test')
  const env = makeFixtureEnv()
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  copyFileSync(NORMALIZE_SRC, join(root, 'scripts', 'lib', 'normalize-lockfile-for-freshness.mjs'))
  copyFileSync(NEEDS_INSTALL_SRC, join(root, 'scripts', 'lib', 'lockfile-change-needs-install.mjs'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(BASE_PACKAGE_JSON, null, 2) + '\n',
    'utf8'
  )
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(baseLock(), null, 2) + '\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', '-A'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'], { env })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  return { root }
}

function cleanup(fx: Fixture): void {
  if (existsSync(fx.root)) rmSync(fx.root, { recursive: true, force: true })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeLockfile(cwd: string, lock: any): void {
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

function run(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): { status: number; output: string; stdout: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...makeFixtureEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  const stdout = r.stdout ?? ''
  return { status: r.status ?? 1, output: stdout + (r.stderr ?? ''), stdout }
}

function classify(cwd: string, extraEnv: Record<string, string> = {}): string {
  return run(cwd, ['--classify'], extraEnv).stdout.trim()
}

function checkMode(cwd: string, extraEnv: Record<string, string> = {}) {
  return run(cwd, [], extraEnv)
}

function writeSentinel(cwd: string): void {
  const r = run(cwd, ['--write-sentinel'])
  expect(r.status).toBe(0)
}

/** Build an isolated PATH dir containing only shims for `tools`, each an exec
 * wrapper around the REAL system binary — so a tool NOT listed is genuinely
 * unresolvable via `command -v`, without disturbing anything else. */
function makeIsolatedBin(root: string, tools: string[]): string {
  const binDir = join(root, '_isobin')
  mkdirSync(binDir, { recursive: true })
  for (const tool of tools) {
    const abs = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    const shim = join(binDir, tool)
    writeFileSync(shim, `#!/bin/sh\nexec "${abs}" "$@"\n`, 'utf8')
    chmodSync(shim, 0o755)
  }
  return binDir
}

const HASH_TOOL = (() => {
  const sha = spawnSync('bash', ['-c', 'command -v sha256sum'], { encoding: 'utf8' })
  return sha.status === 0 ? 'sha256sum' : 'shasum'
})()

// ── B-3 denominator tracking ─────────────────────────────────────────────

const executed = { total: 0, clean: 0, poisoned: 0, unknown: 0, residual: 0 }
function record(direction: 'clean' | 'poisoned' | 'unknown' | 'residual'): void {
  executed.total++
  executed[direction]++
}

afterAll(() => {
  console.log(
    `cases=${executed.total} clean=${executed.clean} poisoned=${executed.poisoned} unknown=${executed.unknown} residual=${executed.residual}`
  )
  expect(executed.total).toBeGreaterThan(0)
  const pinned = Number(readFileSync(EXPECTED_COUNT_FILE, 'utf8').trim())
  expect(executed.total).toBe(pinned)
})

// ── B-2: paired differ-check — run BEFORE any case, per ADR-157 ─────────────
// Every poisoned case is paired with its own clean counterpart. Before
// EITHER side ever runs (this describe block executes before the per-case
// its() blocks below, and asserts only on statically-built lockfile
// objects + hardcoded expected tokens — it never invokes the classifier),
// the harness asserts BOTH that the input bytes differ AND that the two
// expected verdicts differ. A collision on either axis (identical bytes, or
// two expectations that quietly collapsed to the same token during a future
// edit) fails loudly here rather than passing vacuously later.

interface B2Pair {
  label: string
  clean: () => unknown
  cleanExpected: 'fresh' | 'cosmetic' | 'real' | 'unknown'
  poisoned: () => unknown
  poisonedExpected: 'fresh' | 'cosmetic' | 'real' | 'unknown'
}

const B2_PAIRS: B2Pair[] = [
  {
    label: 'C2 (cosmetic) vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.C2(clone(baseLock())),
    poisonedExpected: 'cosmetic',
  },
  {
    label: 'C3 (cosmetic) vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.C3(clone(baseLock())),
    poisonedExpected: 'cosmetic',
  },
  {
    label: 'P1 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P1(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'P2 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P2(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'P3 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P3(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'P4 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P4(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'P5 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P5(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'P6 vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P6(clone(baseLock())),
    poisonedExpected: 'real',
  },
  {
    label: 'A1 (C2+P1 accumulated) vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.P1(mutate.C2(clone(baseLock()))),
    poisonedExpected: 'real',
  },
  {
    label: 'S1 (P1 then C2 layered) vs base',
    clean: () => baseLock(),
    cleanExpected: 'fresh',
    poisoned: () => mutate.C2(mutate.P1(clone(baseLock()))),
    poisonedExpected: 'real',
  },
  {
    label: 'W2 (worktree real) vs W1 (worktree cosmetic)',
    clean: () => mutate.C2(clone(baseLock())),
    cleanExpected: 'cosmetic',
    poisoned: () => mutate.P1(clone(baseLock())),
    poisonedExpected: 'real',
  },
]

describe('B-2 paired differ-check (ADR-157)', () => {
  it.each(B2_PAIRS.map((p): [string, B2Pair] => [p.label, p]))(
    '%s: clean/poisoned bytes differ AND expected verdicts differ',
    (_label, pair) => {
      const cleanBytes = JSON.stringify(pair.clean())
      const poisonedBytes = JSON.stringify(pair.poisoned())
      expect(poisonedBytes).not.toBe(cleanBytes)
      expect(pair.poisonedExpected).not.toBe(pair.cleanExpected)
    }
  )
})

// ── C1-C3: clean, classify → fresh/cosmetic, check → 0 ──────────────────

describe('clean cases (C1-C3)', () => {
  it('C1: no mutation → fresh, check exit 0', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      expect(classify(fx.root)).toBe('fresh')
      expect(checkMode(fx.root).status).toBe(0)
      record('clean')
    } finally {
      cleanup(fx)
    }
  })

  it('C2: workspace-self version bump → cosmetic, check exit 0 with info line', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, mutate.C2(clone(baseLock())))
      expect(classify(fx.root)).toBe('cosmetic')
      const check = checkMode(fx.root)
      expect(check.status).toBe(0)
      expect(check.output).toContain('No install needed')
      record('clean')
    } finally {
      cleanup(fx)
    }
  })

  it('C3: internal dependency range bump on a workspace edge → cosmetic, check exit 0', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, mutate.C3(clone(baseLock())))
      expect(classify(fx.root)).toBe('cosmetic')
      expect(checkMode(fx.root).status).toBe(0)
      record('clean')
    } finally {
      cleanup(fx)
    }
  })
})

// ── P1-P6: poisoned, classify → real, check → 1 ──────────────────────────

describe('poisoned cases (P1-P6)', () => {
  const cases: Array<[string, (l: unknown) => unknown]> = [
    ['P1: external node_modules/x version+integrity changed', mutate.P1],
    ['P2: internal edge redirected to a github fork (not a plain version range)', mutate.P2],
    ['P3: new dependency key added on a workspace entry', mutate.P3],
    ['P4: nested packages/a/node_modules/y entry changed', mutate.P4],
    ['P5: link entry resolved retargeted', mutate.P5],
    ['P6: lockfileVersion changed', mutate.P6],
  ]

  it.each(cases)('%s → real, check exit 1', (_label, fn) => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, fn(clone(baseLock())))
      expect(classify(fx.root)).toBe('real')
      expect(checkMode(fx.root).status).toBe(1)
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })
})

// ── A1: accumulated cosmetic + real → real ───────────────────────────────

describe('A1: accumulated cosmetic + real', () => {
  it('C2 then P1 applied together → real, check exit 1', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      const mutated = mutate.P1(mutate.C2(clone(baseLock())))
      writeLockfile(fx.root, mutated)
      expect(classify(fx.root)).toBe('real')
      expect(checkMode(fx.root).status).toBe(1)
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })
})

// ── S1: stale shadow — cosmetic layered on an earlier, never-installed real
//        change → real ────────────────────────────────────────────────────

describe('S1: cosmetic layered on an earlier never-installed real change', () => {
  it('sentinel from clean base; lockfile now carries P1 then C2 on top → real', () => {
    const fx = makeFixture()
    try {
      // Sentinel reflects the ORIGINAL clean install — P1 was applied to the
      // lockfile afterward and never installed (no re-write-sentinel), then
      // C2 accumulated on top of that.
      writeSentinel(fx.root)
      const mutated = mutate.C2(mutate.P1(clone(baseLock())))
      writeLockfile(fx.root, mutated)
      expect(classify(fx.root)).toBe('real')
      expect(checkMode(fx.root).status).toBe(1)
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })
})

// ── U1-U7: unknown ────────────────────────────────────────────────────────

describe('unknown cases (U1-U7)', () => {
  it('U1: shadow sentinel deleted (raw differs) → unknown, check exit 1', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      rmSync(join(fx.root, 'node_modules', '.skillsmith-deps-hash-shadow'), { force: true })
      writeLockfile(fx.root, mutate.C2(clone(baseLock())))
      expect(classify(fx.root)).toBe('unknown')
      expect(checkMode(fx.root).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U2: SKILLSMITH_DEPS_FRESHNESS_SHADOW_HASH_DISABLE=1 (raw differs) → unknown, check exit 1', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, mutate.C2(clone(baseLock())))
      const env = { SKILLSMITH_DEPS_FRESHNESS_SHADOW_HASH_DISABLE: '1' }
      expect(classify(fx.root, env)).toBe('unknown')
      expect(checkMode(fx.root, env).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U3: raw sentinel missing → unknown, check exit 1', () => {
    const fx = makeFixture()
    try {
      // No --write-sentinel call at all.
      expect(classify(fx.root)).toBe('unknown')
      expect(checkMode(fx.root).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U4: node absent from PATH (raw differs) → unknown, check exit 1', () => {
    const fx = makeFixture()
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, mutate.C2(clone(baseLock())))
      const binDir = makeIsolatedBin(fx.root, ['git', 'bash', 'cat', 'cut', HASH_TOOL])
      const env = { PATH: binDir }
      expect(classify(fx.root, env)).toBe('unknown')
      expect(checkMode(fx.root, env).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U5: normalizer script unreadable (raw differs) → unknown, check exit 1', () => {
    const fx = makeFixture()
    const normalizerPath = join(fx.root, 'scripts', 'lib', 'normalize-lockfile-for-freshness.mjs')
    try {
      writeSentinel(fx.root)
      writeLockfile(fx.root, mutate.C2(clone(baseLock())))
      // chmod 0o000 alone is NOT sufficient here: the dev container runs as
      // root, which bypasses permission bits entirely (measured — a
      // chmod-000'd file stayed readable under `docker exec`). Renaming the
      // file away hits the exact same `[ -r "$NORMALIZE_SCRIPT" ]` check the
      // script guards with, regardless of who's running it.
      chmodSync(normalizerPath, 0o000)
      execFileSync('mv', [normalizerPath, `${normalizerPath}.hidden`])
      expect(classify(fx.root)).toBe('unknown')
      expect(checkMode(fx.root).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U6: no sha256sum/shasum → unknown, check exit 0 (existing P-6 FAIL-SOFT preserved)', () => {
    const fx = makeFixture()
    try {
      const binDir = makeIsolatedBin(fx.root, ['git', 'bash', 'cat', 'cut'])
      const env = { PATH: binDir }
      expect(classify(fx.root, env)).toBe('unknown')
      const check = checkMode(fx.root, env)
      expect(check.status).toBe(0)
      expect(check.output).toBe('')
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })

  it('U7: no package-lock.json → unknown, check exit 0 (existing fail-soft preserved)', () => {
    const fx = makeFixture()
    try {
      rmSync(join(fx.root, 'package-lock.json'), { force: true })
      expect(classify(fx.root)).toBe('unknown')
      const check = checkMode(fx.root)
      expect(check.status).toBe(0)
      expect(check.output).toBe('')
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })
})

// ── W1/W2: linked worktree — node_modules symlinked into main ───────────

describe('worktree cases (W1/W2)', () => {
  function makeWorktreeFixture(): { main: Fixture; worktreeDir: string } {
    const main = makeFixture()
    const env = makeFixtureEnv()
    writeSentinel(main.root)
    const worktreeDir = `${main.root}-wt`
    execFileSync(
      'git',
      ['-C', main.root, 'worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir, 'main'],
      { env }
    )
    // node_modules isn't tracked — symlink it into main's real tree, same
    // relationship create-worktree.sh establishes (SMI-4377).
    const target = relative(worktreeDir, join(main.root, 'node_modules'))
    symlinkSync(target, join(worktreeDir, 'node_modules'))
    return { main, worktreeDir }
  }

  function cleanupWorktree(main: Fixture, worktreeDir: string): void {
    try {
      execFileSync('git', ['-C', main.root, 'worktree', 'remove', '--force', worktreeDir], {
        env: makeFixtureEnv(),
      })
    } catch {
      /* best-effort */
    }
    if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true })
    cleanup(main)
  }

  it('W1: worktree lockfile carries C2 vs main install → cosmetic, check exit 0', () => {
    const { main, worktreeDir } = makeWorktreeFixture()
    try {
      writeLockfile(worktreeDir, mutate.C2(clone(baseLock())))
      expect(classify(worktreeDir)).toBe('cosmetic')
      expect(checkMode(worktreeDir).status).toBe(0)
      record('clean')
    } finally {
      cleanupWorktree(main, worktreeDir)
    }
  })

  it('W2: worktree lockfile carries P1 vs main install → real, check exit 1', () => {
    const { main, worktreeDir } = makeWorktreeFixture()
    try {
      writeLockfile(worktreeDir, mutate.P1(clone(baseLock())))
      expect(classify(worktreeDir)).toBe('real')
      expect(checkMode(worktreeDir).status).toBe(1)
      record('poisoned')
    } finally {
      cleanupWorktree(main, worktreeDir)
    }
  })
})

// ── R1: residual — a sentinel stamped without a real install can lie ────

describe('R1: residual (documented, not a bug)', () => {
  it('sentinel written AFTER a P1 mutation, no real install → fresh', () => {
    const fx = makeFixture()
    try {
      writeLockfile(fx.root, mutate.P1(clone(baseLock())))
      // --write-sentinel just hashes whatever is currently on disk — no
      // install happened, but the sentinel now matches the poisoned bytes.
      writeSentinel(fx.root)
      expect(classify(fx.root)).toBe('fresh')
      expect(checkMode(fx.root).status).toBe(0)
      // Its own `residual` bucket in the B-3 summary — its resulting
      // verdict (`fresh`) is indistinguishable from a genuinely clean
      // case's, which is exactly the residual this case documents, but it
      // is not itself a clean case: give it its own count.
      record('residual')
    } finally {
      cleanup(fx)
    }
  })
})

// ── F1-F*: SMI-7238 flag-only exemption (design E) ──────────────────────────
// Through the real .sh: --write-sentinel saves the installed lockfile bytes,
// and `_classify()` asks lockfile-change-needs-install.mjs before printing
// `real`. The classifier-verdict cases F1-F10 call record() (ADR-157 corpus,
// pinned in fixtures/deps-drift-corpus.expected-count); the stub-helper and
// publication cases test plumbing, not verdicts, and do not. The omit probe is pinned empty so the host's npm config cannot
// change a verdict.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flagLock(): any {
  const l = baseLock()
  l.packages['']['dependencies'] = { tsx: '^4.0.0' }
  l.packages['packages/a'].dependencies['@tw/vite'] = '^4.1.0'
  l.packages['node_modules/tsx'] = {
    version: '4.0.1',
    resolved: 'https://registry.npmjs.org/tsx/-/tsx-4.0.1.tgz',
    integrity: 'sha512-TSX',
  }
  l.packages['node_modules/lightningcss-x'] = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/lightningcss-x/-/l-1.0.0.tgz',
    integrity: 'sha512-LX',
    optional: true,
  }
  l.packages['node_modules/shared'] = {
    version: '2.0.0',
    resolved: 'https://registry.npmjs.org/shared/-/shared-2.0.0.tgz',
    integrity: 'sha512-SH',
    devOptional: true,
  }
  return l
}

/** The instance-2 shape: flags change and two same-spec section moves. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function instance2(l: any): any {
  l.packages['node_modules/tsx'].dev = true
  l.packages['node_modules/lightningcss-x'].peer = true
  delete l.packages['node_modules/shared'].devOptional
  const root = l.packages['']
  root.devDependencies = { tsx: root.dependencies.tsx }
  delete root.dependencies.tsx
  const a = l.packages['packages/a']
  a.devDependencies = { '@tw/vite': a.dependencies['@tw/vite'] }
  delete a.dependencies['@tw/vite']
  return l
}

// The omit override is honoured only with the test marker (SMI-7238 review).
const OMIT_EMPTY = { SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT: '', SKILLSMITH_DEPS_PROBE_TEST: '1' }
const OMIT_DEV = { SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT: 'dev', SKILLSMITH_DEPS_PROBE_TEST: '1' }
const COPY_NAME = '.skillsmith-deps-lock.json'

/** Install from flagLock(), then put `mutated` on disk as the current lockfile. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installedThen(mutate: (l: any) => any): Fixture {
  const fx = makeFixture()
  writeLockfile(fx.root, flagLock())
  writeSentinel(fx.root)
  writeLockfile(fx.root, mutate(flagLock()))
  return fx
}

describe('F: SMI-7238 paired differ-check', () => {
  const pairs: Array<[string, () => unknown, string, () => unknown, string]> = [
    [
      'instance-2 vs version bump',
      () => instance2(flagLock()),
      'cosmetic',
      () => mutate.P1(instance2(flagLock())),
      'real',
    ],
  ]
  it.each(pairs)('%s: bytes differ and expected verdicts differ', (_l, a, ea, b, eb) => {
    expect(JSON.stringify(a())).not.toBe(JSON.stringify(b()))
    expect(ea).not.toBe(eb)
  })
})

describe('F: SMI-7238 flag-only changes', () => {
  it('F1: instance-2 shape -> cosmetic, check exit 0 with the reworded info line', () => {
    const fx = installedThen(instance2)
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('cosmetic')
      const check = checkMode(fx.root, OMIT_EMPTY)
      expect(check.status).toBe(0)
      expect(check.output).toContain('No install needed')
      expect(check.output).toContain('dependency flags and same-spec section moves')
      record('clean')
    } finally {
      cleanup(fx)
    }
  })

  it('F2: a same-spec section move alone -> cosmetic', () => {
    const fx = installedThen((l) => {
      l.packages['packages/a'].devDependencies = { 'external-x': '^0.3.11' }
      delete l.packages['packages/a'].dependencies['external-x']
      return l
    })
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('cosmetic')
      record('clean')
    } finally {
      cleanup(fx)
    }
  })

  it('F3: instance-2 shape PLUS a version change -> real, check exit 1', () => {
    const fx = installedThen((l) => mutate.P1(instance2(l)))
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      expect(checkMode(fx.root, OMIT_EMPTY).status).toBe(1)
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F4: section move that changes the spec -> real', () => {
    const fx = installedThen((l) => {
      l.packages[''].devDependencies = { tsx: '^5.0.0' }
      delete l.packages[''].dependencies.tsx
      return l
    })
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F5: workspace dependency added alongside flag changes -> real', () => {
    const fx = installedThen((l) => mutate.P3(instance2(l)))
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F6: lockfileVersion changed alongside flag changes -> real', () => {
    const fx = installedThen((l) => mutate.P6(instance2(l)))
    try {
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })
})

describe('F: SMI-7238 saved-copy and omit guards', () => {
  it('F7: no saved copy -> real (tree installed before this change)', () => {
    const fx = installedThen(instance2)
    try {
      rmSync(join(fx.root, 'node_modules', COPY_NAME), { force: true })
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      expect(checkMode(fx.root, OMIT_EMPTY).status).toBe(1)
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F8: saved copy whose hash differs from the raw sentinel -> real', () => {
    const fx = installedThen(instance2)
    try {
      writeFileSync(join(fx.root, 'node_modules', COPY_NAME), '{"packages":{}}\n', 'utf8')
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F9: non-empty omit set (paired with F1) -> real', () => {
    const fx = installedThen(instance2)
    try {
      expect(classify(fx.root, OMIT_DEV)).toBe('real')
      expect(classify(fx.root, OMIT_EMPTY)).toBe('cosmetic')
      record('poisoned')
    } finally {
      cleanup(fx)
    }
  })

  it('F10: shadow sentinel deleted with a flag-only change stays unknown, never cosmetic', () => {
    const fx = installedThen(instance2)
    try {
      rmSync(join(fx.root, 'node_modules', '.skillsmith-deps-hash-shadow'), { force: true })
      expect(classify(fx.root, OMIT_EMPTY)).toBe('unknown')
      expect(checkMode(fx.root, OMIT_EMPTY).status).toBe(1)
      record('unknown')
    } finally {
      cleanup(fx)
    }
  })
})

describe('F: SMI-7238 helper output is trusted only when it is exactly the token', () => {
  const helperPath = (root: string) =>
    join(root, 'scripts', 'lib', 'lockfile-change-needs-install.mjs')
  const stub = (out: string) => `process.stdout.write(${JSON.stringify(out)})\n`

  it.each([
    ['exact token (control: the stub IS consulted)', 'no-install-needed\n', 'cosmetic'],
    ['token plus extra text', 'no-install-needed extra\n', 'real'],
    ['token on a second line after noise', 'noise\nno-install-needed\n', 'real'],
    ['unexpected token', 'cosmetic\n', 'real'],
    ['empty stdout', '', 'real'],
  ])('%s -> %s', (_label, out, expected) => {
    const fx = installedThen(instance2)
    try {
      writeFileSync(helperPath(fx.root), stub(out), 'utf8')
      expect(classify(fx.root, OMIT_EMPTY)).toBe(expected)
    } finally {
      cleanup(fx)
    }
  })

  it('a crashing helper -> real', () => {
    const fx = installedThen(instance2)
    try {
      writeFileSync(helperPath(fx.root), 'throw new Error("boom")\n', 'utf8')
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
    } finally {
      cleanup(fx)
    }
  })

  it('a missing helper -> real', () => {
    const fx = installedThen(instance2)
    try {
      rmSync(helperPath(fx.root), { force: true })
      expect(classify(fx.root, OMIT_EMPTY)).toBe('real')
    } finally {
      cleanup(fx)
    }
  })
})

describe('F: SMI-7238 unchanged behaviour and publication', () => {
  it('F11: SKILLSMITH_SKIP_DEPS_FRESHNESS=1 exits 0 in check mode; --classify ignores it', () => {
    const fx = installedThen((l) => mutate.P1(instance2(l)))
    try {
      const env = { ...OMIT_EMPTY, SKILLSMITH_SKIP_DEPS_FRESHNESS: '1' }
      expect(checkMode(fx.root, env).status).toBe(0)
      expect(classify(fx.root, env)).toBe('real')
    } finally {
      cleanup(fx)
    }
  })

  it('F12: --write-sentinel saves the exact lockfile bytes and the raw sentinel hashes them', () => {
    const fx = makeFixture()
    try {
      writeLockfile(fx.root, flagLock())
      writeSentinel(fx.root)
      const copy = readFileSync(join(fx.root, 'node_modules', COPY_NAME))
      const lock = readFileSync(join(fx.root, 'package-lock.json'))
      expect(copy.equals(lock)).toBe(true)
      const sentinel = readFileSync(join(fx.root, 'node_modules', '.skillsmith-deps-hash'), 'utf8')
      expect(sentinel.trim()).toBe(createHash('sha256').update(copy).digest('hex'))
    } finally {
      cleanup(fx)
    }
  })

  it('F13: re-running --write-sentinel after the lockfile changes refreshes the copy', () => {
    const fx = makeFixture()
    try {
      writeLockfile(fx.root, flagLock())
      writeSentinel(fx.root)
      writeLockfile(fx.root, instance2(flagLock()))
      writeSentinel(fx.root)
      const copy = readFileSync(join(fx.root, 'node_modules', COPY_NAME))
      expect(copy.equals(readFileSync(join(fx.root, 'package-lock.json')))).toBe(true)
      expect(classify(fx.root, OMIT_EMPTY)).toBe('fresh')
    } finally {
      cleanup(fx)
    }
  })

  it('F14: --write-sentinel leaves no temp files behind', () => {
    const fx = makeFixture()
    try {
      writeLockfile(fx.root, flagLock())
      writeSentinel(fx.root)
      const listing = execFileSync('ls', ['-A', join(fx.root, 'node_modules')], {
        encoding: 'utf8',
      }).split('\n')
      // Same-run positive: the publication actually happened.
      expect(listing).toEqual(
        expect.arrayContaining([COPY_NAME, '.skillsmith-deps-hash', '.skillsmith-deps-hash-shadow'])
      )
      expect(listing.filter((n) => n.includes('.tmp.'))).toEqual([])
    } finally {
      cleanup(fx)
    }
  })

  it('F15: --classify and check mode never write the saved copy or sentinels', () => {
    const fx = installedThen(instance2)
    try {
      const snap = () =>
        ['.skillsmith-deps-hash', '.skillsmith-deps-hash-shadow', COPY_NAME]
          .map((n) => readFileSync(join(fx.root, 'node_modules', n), 'utf8'))
          .join('\u0000')
      const before = snap()
      // Same-run positives: both modes reached the exemption, not an early exit.
      expect(classify(fx.root, OMIT_EMPTY)).toBe('cosmetic')
      expect(checkMode(fx.root, OMIT_EMPTY).status).toBe(0)
      expect(snap()).toBe(before)
    } finally {
      cleanup(fx)
    }
  })

  it('F16: --write-sentinel publishes copy, then shadow, then raw sentinel (mv order)', () => {
    const fx = makeFixture()
    const shim = makeFixtureTempDir('deps-fresh-mv-shim')
    try {
      const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
      const log = join(shim, 'mv.log')
      writeFileSync(
        join(shim, 'mv'),
        `#!/bin/sh\nprintf '%s\\n' "$(basename "$2")" >> '${log}'\nexec '${realMv}' "$@"\n`,
        { encoding: 'utf8', mode: 0o755 }
      )
      writeLockfile(fx.root, flagLock())
      const r = run(fx.root, ['--write-sentinel'], {
        PATH: `${shim}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      })
      expect(r.status).toBe(0)
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        COPY_NAME,
        '.skillsmith-deps-hash-shadow',
        '.skillsmith-deps-hash',
      ])
    } finally {
      cleanup(fx)
      rmSync(shim, { recursive: true, force: true })
    }
  })
})
