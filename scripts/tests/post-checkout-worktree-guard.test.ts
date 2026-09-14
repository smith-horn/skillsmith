/**
 * SMI-5628 (linked-worktree guard) + SMI-6606/SMI-6614 (ADR-158, lockfile-
 * drift classifier) — tests for `.husky/post-checkout`.
 *
 * Mirrors post-merge-worktree-guard.test.ts's fixture shape and classifier
 * integration (see that file's header for the full rationale) — the two
 * hooks answer the same "does this lockfile delta need an install?"
 * question via the SAME shared classifier and MUST NOT disagree. Case (d)
 * below pins that the two hooks' printed advice for a linked worktree is
 * byte-for-byte identical.
 *
 * Unlike `post-merge` (which reads `ORIG_HEAD`/`HEAD` set by a real merge),
 * `post-checkout` takes its two SHAs as positional args ($1 prev_HEAD, $2
 * new_HEAD, $3 branch_flag) AND relies on the working tree already
 * reflecting `new_HEAD`'s content (git updates it before firing the hook) —
 * every case below does a REAL `git checkout` to the SHA under test before
 * invoking the hook, so the classifier reads genuine on-disk content, not an
 * incidental leftover from fixture construction.
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const POST_CHECKOUT_SCRIPT = resolve(__dirname, '..', '..', '.husky', 'post-checkout')
const POST_MERGE_SCRIPT = resolve(__dirname, '..', '..', '.husky', 'post-merge')
const NORMALIZE_SRC = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')
const CLASSIFY_SCRIPT = resolve(__dirname, '..', 'lib', 'check-node-modules-fresh.sh')

const ALL_ZEROS = '0000000000000000000000000000000000000000'

const BASE_PACKAGE_JSON = { name: 'root', version: '1.0.0', workspaces: ['packages/*'] }
function baseLock() {
  return {
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', version: '1.0.0', workspaces: ['packages/*'] },
      'node_modules/external-x': {
        version: '0.3.11',
        resolved: 'https://registry.npmjs.org/external-x/-/external-x-0.3.11.tgz',
        integrity: 'sha512-AAAA',
      },
    },
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(o: any): any {
  return JSON.parse(JSON.stringify(o))
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cosmeticMutate(l: any) {
  l.packages[''].version = '1.0.1'
  return l
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function realMutate(l: any) {
  l.packages['node_modules/external-x'].version = '0.3.12'
  l.packages['node_modules/external-x'].integrity = 'sha512-BBBB'
  return l
}

interface Fixture {
  root: string
  worktreeDir: string
  beforeSha: string
  /** Real mutation, committed directly on top of beforeSha. */
  afterRealSha: string
  /** Cosmetic-only mutation, a SIBLING commit off beforeSha (not stacked on
   * the real mutation) — a clean cosmetic-vs-installed-base comparison. */
  afterCosmeticSha: string
  /** A further commit off afterRealSha that does NOT touch package-lock.json. */
  noLockfileDiffSha: string
}

function checkoutSha(dir: string, sha: string, env: NodeJS.ProcessEnv): void {
  execFileSync('git', ['-C', dir, 'checkout', '-q', sha], { env })
}

function commitLockfile(
  dir: string,
  env: NodeJS.ProcessEnv,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lock: any,
  message: string
): string {
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', 'utf8')
  execFileSync('git', ['-C', dir, 'add', 'package-lock.json'], { env })
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', message], { env })
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env }).toString().trim()
}

/**
 * Build the fixture:
 *   root/       — main checkout, branch `main`, real node_modules/ with a
 *                 sentinel written against the base lockfile.
 *                 Commit graph (all reachable from `main`'s history or as
 *                 detached siblings — the test checks out each SHA it needs
 *                 explicitly, so branch topology doesn't matter):
 *                   beforeSha (init)
 *                     -> afterRealSha (real mutation)
 *                          -> noLockfileDiffSha (unrelated file)
 *                   beforeSha -> afterCosmeticSha (cosmetic-only sibling)
 *   <root>-wt/  — linked worktree (git worktree add) on its own branch,
 *                 checked out at afterRealSha
 */
function makeFixture(): Fixture {
  const root = makeFixtureTempDir('post-checkout-guard-test')
  const env = makeFixtureEnv()

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  execFileSync('cp', [
    NORMALIZE_SRC,
    join(root, 'scripts', 'lib', 'normalize-lockfile-for-freshness.mjs'),
  ])
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(BASE_PACKAGE_JSON, null, 2) + '\n',
    'utf8'
  )
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(baseLock(), null, 2) + '\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', '-A'], { env })
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init'], { env })
  const beforeSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env })
    .toString()
    .trim()

  mkdirSync(join(root, 'node_modules'), { recursive: true })
  const write = spawnSync('bash', [CLASSIFY_SCRIPT, '--write-sentinel'], {
    cwd: root,
    env: makeFixtureEnv(),
    encoding: 'utf8',
  })
  expect(write.status).toBe(0)

  const afterRealSha = commitLockfile(root, env, realMutate(clone(baseLock())), 'real bump')
  const noLockfileDiffSha = (() => {
    writeFileSync(join(root, 'other.txt'), 'x', 'utf8')
    execFileSync('git', ['-C', root, 'add', 'other.txt'], { env })
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'unrelated change'], { env })
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env }).toString().trim()
  })()

  checkoutSha(root, beforeSha, env)
  const afterCosmeticSha = commitLockfile(
    root,
    env,
    cosmeticMutate(clone(baseLock())),
    'cosmetic bump'
  )

  checkoutSha(root, afterRealSha, env)

  const worktreeDir = `${root}-wt`
  execFileSync(
    'git',
    ['-C', root, 'worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir, afterRealSha],
    { env }
  )

  return { root, worktreeDir, beforeSha, afterRealSha, afterCosmeticSha, noLockfileDiffSha }
}

function runHook(
  script: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...makeFixtureEnv(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Checks out `newHead` for real on `cwd` (matching what git itself already
 * did before firing post-checkout in production), then runs the hook. */
function runPostCheckout(
  cwd: string,
  prevHead: string,
  newHead: string,
  branchFlag: string,
  extraEnv: NodeJS.ProcessEnv = {}
) {
  if (branchFlag === '1' && newHead !== ALL_ZEROS) {
    checkoutSha(cwd, newHead, makeFixtureEnv())
  }
  return runHook(POST_CHECKOUT_SCRIPT, [prevHead, newHead, branchFlag], cwd, extraEnv)
}

describe('.husky/post-checkout — linked-worktree guard + lockfile-drift classifier (SMI-5628, SMI-6606/6614)', () => {
  let fixture: Fixture | null = null

  beforeEach(() => {
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture) {
      const { root, worktreeDir } = fixture
      try {
        execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktreeDir], {
          env: makeFixtureEnv(),
        })
      } catch {
        /* best-effort */
      }
      if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true })
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
    fixture = null
  })

  it('(a) linked worktree: no install, advises the main-checkout path', () => {
    const { root, worktreeDir, beforeSha, afterRealSha } = fixture!

    // The worktree was created checked out AT afterRealSha already.
    const result = runHook(POST_CHECKOUT_SCRIPT, [beforeSha, afterRealSha, '1'], worktreeDir)
    expect(result.status).toBe(0)

    expect(result.stdout).toMatch(/Linked worktree — no install runs from here/)
    expect(result.stdout).toContain(root)
    expect(result.stdout).not.toMatch(/^\s*npm install\s*$/m)
    expect(result.stdout).not.toContain('npm install')
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
  })

  it('(b) main checkout real change: no install, advice printed', () => {
    const { root, beforeSha, afterRealSha } = fixture!

    const result = runPostCheckout(root, beforeSha, afterRealSha, '1')
    expect(result.status).toBe(0)

    expect(result.stdout).not.toMatch(/linked worktree/i)
    expect(result.stdout).not.toContain('npm install')
    expect(result.stdout).toMatch(/real dependency change/i)
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
  })

  it('(c) main checkout cosmetic-only change: no advice, informational line only', () => {
    const { root, beforeSha, afterCosmeticSha } = fixture!

    const result = runPostCheckout(root, beforeSha, afterCosmeticSha, '1')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/No install needed/)
    expect(result.stdout).not.toMatch(/regen-lockfile\.sh/)
  })

  it.each([
    ['non-zero exit, empty output', 'exit 1'],
    ['zero exit, empty output', 'exit 0'],
    ['zero exit, unrecognized token', "printf 'garbage\\n'"],
    // Code-review finding 1: a VALID token printed but a non-zero exit must
    // NOT be trusted — status and token are checked together.
    ['valid token (fresh) but non-zero exit', 'echo fresh; exit 9'],
  ])('(f) malformed classifier output (%s) → treated as unknown', (_label, body) => {
    const { root, beforeSha, afterCosmeticSha } = fixture!

    const stubPath = join(root, 'fake-classify.sh')
    writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, 'utf8')
    chmodSync(stubPath, 0o755)

    // afterCosmeticSha's on-disk lockfile is a genuinely cosmetic mutation —
    // a trustworthy classifier would say `cosmetic` here. The stub instead
    // exercises the malformed-output path, which must still be treated as
    // `unknown` regardless of what the real installed state would say.
    const result = runPostCheckout(root, beforeSha, afterCosmeticSha, '1', {
      SKILLSMITH_DEPS_CLASSIFY_SCRIPT_TEST: stubPath,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/real dependency change/i)
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
    expect(result.stdout).not.toMatch(/No install needed/)
  })

  it.each([
    ['(i) file checkout (branch_flag=0)', 'beforeSha', 'afterRealSha', '0'],
    ['(ii) orphan/initial checkout (prev_HEAD all-zeros)', 'ALL_ZEROS', 'afterRealSha', '1'],
    ['(iii) no-op checkout (prev_HEAD === new_HEAD)', 'afterRealSha', 'afterRealSha', '1'],
    [
      '(iv) no package-lock.json diff between the two SHAs',
      'afterRealSha',
      'noLockfileDiffSha',
      '1',
    ],
  ])(
    '(d-guards) %s: hook exits 0 with no output, from both main and worktree cwd',
    (_label, prevKey, newKey, branchFlag) => {
      const f = fixture!
      const shaFor = (key: string): string =>
        key === 'ALL_ZEROS' ? ALL_ZEROS : (f as unknown as Record<string, string>)[key]
      const prevHead = shaFor(prevKey)
      const newHead = shaFor(newKey)

      for (const cwd of [f.root, f.worktreeDir]) {
        const result = runPostCheckout(cwd, prevHead, newHead, branchFlag)
        expect(result.status).toBe(0)
        expect(result.stdout).toBe('')
      }
    }
  )

  it('(d) advisory output exactly matches post-merge for a linked worktree — no drift between the two hooks', () => {
    const { worktreeDir, beforeSha, afterRealSha } = fixture!

    const checkoutResult = runHook(
      POST_CHECKOUT_SCRIPT,
      [beforeSha, afterRealSha, '1'],
      worktreeDir
    )

    // post-merge needs a REAL merge (it reads ORIG_HEAD/HEAD, not argv), so
    // reproduce the same lockfile delta via a merge in the SAME worktree —
    // the ADVICE TEXT itself is verdict- and hook-independent
    // (print-deps-refresh-advice.sh takes only the resolved main-checkout
    // path), so what matters here is that both hooks resolve and print the
    // IDENTICAL advice body for the same linked-worktree cwd.
    const env = makeFixtureEnv()
    execFileSync('git', ['-C', worktreeDir, 'checkout', '-q', '-b', 'merge-parity-topic'], { env })
    // worktreeDir is already checked out at afterRealSha — layer a FURTHER
    // mutation so this commit has actual content to diff (a re-write of the
    // identical bytes would be a git no-op commit).
    writeFileSync(
      join(worktreeDir, 'package-lock.json'),
      JSON.stringify(cosmeticMutate(realMutate(clone(baseLock()))), null, 2) + '\n',
      'utf8'
    )
    execFileSync('git', ['-C', worktreeDir, 'add', 'package-lock.json'], { env })
    execFileSync('git', ['-C', worktreeDir, 'commit', '--quiet', '-m', 'parity bump'], { env })
    execFileSync('git', ['-C', worktreeDir, 'checkout', '-q', 'wt-branch'], { env })
    execFileSync(
      'git',
      ['-C', worktreeDir, 'merge', '--no-ff', '--no-edit', '-q', 'merge-parity-topic'],
      { env }
    )
    const mergeResult = runHook(POST_MERGE_SCRIPT, [], worktreeDir)

    // Extract just the advice BODY (from "0. Confirm" to the "Scripted,
    // locked" closing line) out of each hook's full output, since the
    // surrounding banner/heading text legitimately differs between the two
    // hooks (post-checkout vs post-merge headers).
    const extractAdvice = (s: string): string => {
      const start = s.indexOf('0. Confirm')
      const end = s.indexOf('SMI-6627.')
      return s.slice(start, end)
    }
    const checkoutAdvice = extractAdvice(checkoutResult.stdout)
    const mergeAdvice = extractAdvice(mergeResult.stdout)
    expect(checkoutAdvice.length).toBeGreaterThan(0)
    expect(checkoutAdvice).toBe(mergeAdvice)
  })
})
