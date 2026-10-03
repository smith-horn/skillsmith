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

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-node-modules-fresh.sh')
const NORMALIZE_SRC = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')
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
