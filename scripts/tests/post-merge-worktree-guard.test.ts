/**
 * SMI-5623/SMI-5624 (linked-worktree guard) + SMI-6606/SMI-6614 (ADR-158,
 * lockfile-drift classifier) — tests for `.husky/post-merge`.
 *
 * `.husky/post-merge` used to run `npm install` twice (container + host)
 * whenever `package-lock.json` changed between `ORIG_HEAD` and `HEAD` —
 * unconditionally, even for a release-cadence version-only bump. SMI-6614
 * (ADR-158) replaced that with a single shared classifier
 * (`check-node-modules-fresh.sh --classify`): the hook now NEVER installs.
 * It prints one informational line on `fresh`/`cosmetic`, or the shared
 * ordered refresh advice on `real`/`unknown`, and a linked worktree always
 * gets the advice (regardless of verdict) with the main-checkout path.
 *
 * This suite builds a REAL git fixture with an ACTUAL linked worktree (`git
 * worktree add`, not a simulated one) — the guard condition depends on
 * genuine git-dir/git-common-dir divergence. The real `.husky/post-merge`
 * script is invoked in place via `sh <path>` with `cwd` set to each fixture
 * location — never against the live repo tree. `scripts/retrieval-autoheal.sh`
 * is stubbed at a fixture-local path (resolved by the hook CWD-relative, so
 * the stub — not this worktree's real auto-heal script — is what runs).
 *
 * Cases covered:
 *   (a) LINKED WORKTREE: advice printed, names the main-checkout path,
 *       regardless of verdict.
 *   (b) MAIN CHECKOUT real merge (regression, updated for SMI-6614): no
 *       install (there is none left to skip); advice printed.
 *   (c) MAIN CHECKOUT cosmetic merge: no advice, one informational line,
 *       auto-heal kicked.
 *   (d) MAIN CHECKOUT real merge: advice printed in order, auto-heal
 *       deferred (not kicked), deferral line printed.
 *   (e) Malformed classifier output (non-zero exit, empty stdout, or an
 *       unrecognized token) → treated as `unknown` (advice, auto-heal
 *       deferred).
 *
 * SMI-4693: uses makeFixtureEnv (strips GIT_DISCOVERY_VARS) and
 * makeFixtureTempDir (realpath-canonical tmpdir) for git fixture isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const POST_MERGE_SCRIPT = resolve(__dirname, '..', '..', '.husky', 'post-merge')
const NORMALIZE_SRC = resolve(__dirname, '..', 'lib', 'normalize-lockfile-for-freshness.mjs')
const CLASSIFY_SCRIPT = resolve(__dirname, '..', 'lib', 'check-node-modules-fresh.sh')

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
  autohealLog: string
}

/** Read a log file, returning '' if it was never created (nothing logged). */
function readLogSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Fixture-local stub for scripts/retrieval-autoheal.sh, resolved CWD-relative
 * by the hook (unlike the classifier, which is $0-relative to the real repo)
 * — so this stub, not the real auto-heal script, is what the hook invokes. */
function writeAutohealStub(root: string, logPath: string): void {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const shim = `#!/bin/sh
if [ "$1" = "--print-banner" ]; then
  echo "banner" >> "${logPath}"
else
  echo "kick" >> "${logPath}"
fi
exit 0
`
  const p = join(root, 'scripts', 'retrieval-autoheal.sh')
  writeFileSync(p, shim, 'utf8')
  chmodSync(p, 0o755)
}

/**
 * Commit a package-lock.json mutation on a throwaway topic branch, then
 * merge it (--no-ff) back into `targetBranch` in `dir` — a REAL merge, so
 * git itself sets ORIG_HEAD (to the pre-merge tip) and HEAD (to the merge
 * commit) exactly as a `git pull`/`git merge` would in practice.
 */
function bumpLockfileViaMerge(
  dir: string,
  env: NodeJS.ProcessEnv,
  targetBranch: string,
  suffix: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate: (l: any) => any
): void {
  const topicBranch = `lockfile-bump-${suffix}`
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', topicBranch], { env })
  const current = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify(mutate(current), null, 2) + '\n',
    'utf8'
  )
  execFileSync('git', ['-C', dir, 'add', 'package-lock.json'], { env })
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', `bump lockfile (${suffix})`], { env })
  execFileSync('git', ['-C', dir, 'checkout', '-q', targetBranch], { env })
  execFileSync('git', ['-C', dir, 'merge', '--no-ff', '--no-edit', '-q', topicBranch], { env })
}

/**
 * Build the fixture:
 *   root/               — main checkout, branch `main`, real node_modules/
 *                          with a sentinel written against the base lockfile
 *     package.json / package-lock.json / scripts/lib/normalize-lockfile-for-freshness.mjs
 *   <root>-wt/           — linked worktree (git worktree add), branch `wt-branch`
 *
 * The worktree gets its own lockfile bump (arbitrary — irrelevant to its
 * messaging, which is verdict-independent) so it has a genuine ORIG_HEAD.
 * Root's own lockfile is left UNBUMPED here — individual tests call
 * bumpLockfileViaMerge(fixture.root, …) with the mutation they need.
 */
function makeFixture(): Fixture {
  const root = makeFixtureTempDir('post-merge-guard-test')
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

  mkdirSync(join(root, 'node_modules'), { recursive: true })
  const autohealLog = join(root, 'autoheal.log')
  writeAutohealStub(root, autohealLog)

  // Write the sentinel against the base state (a real install would have).
  const write = spawnSync('bash', [CLASSIFY_SCRIPT, '--write-sentinel'], {
    cwd: root,
    env: makeFixtureEnv(),
    encoding: 'utf8',
  })
  expect(write.status).toBe(0)

  // Real linked worktree off the initial commit, on its own branch, with its
  // own (irrelevant-to-messaging) lockfile bump for a genuine ORIG_HEAD.
  const worktreeDir = `${root}-wt`
  execFileSync(
    'git',
    ['-C', root, 'worktree', 'add', '-q', '-b', 'wt-branch', worktreeDir, 'main'],
    { env }
  )
  bumpLockfileViaMerge(worktreeDir, env, 'wt-branch', 'wt', realMutate)

  return { root, worktreeDir, autohealLog }
}

/** Run the real post-merge hook with the fixture's own scripts/ dir first on
 * PATH-independent resolution — the hook resolves the classifier $0-relative
 * (the real, checked-out script) and the auto-heal CWD-relative (this
 * fixture's stub); no PATH manipulation is needed for either. */
function runHook(
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('sh', [POST_MERGE_SCRIPT], {
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

/** Poll for the auto-heal log to contain `needle`, bounded — the "kick" is a
 * detached background process (`nohup … &`); the hook returns before it's
 * guaranteed to have written its log line. */
async function waitForLog(path: string, needle: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = readLogSafe(path)
  while (!content.includes(needle) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    content = readLogSafe(path)
  }
  return content
}

describe('.husky/post-merge — linked-worktree guard + lockfile-drift classifier (SMI-5623/5624, SMI-6606/6614)', () => {
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
        /* best-effort — fall through to directory removal below regardless */
      }
      if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true })
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
    fixture = null
  })

  it('(a) linked worktree: no install, advises the main-checkout path (verdict-independent)', () => {
    const { root, worktreeDir } = fixture!

    const result = runHook(worktreeDir)
    expect(result.status).toBe(0)

    expect(result.stdout).toMatch(/Linked worktree — no install runs from here/)
    expect(result.stdout).toContain(root)
    // Never a bare npm install / bare docker compose up line (the mountpoint
    // CHECK in step 0 legitimately runs `docker exec … mountpoint`, which is
    // not an install — only a bare, unqualified install line is banned).
    expect(result.stdout).not.toMatch(/^\s*npm install\s*$/m)
    expect(result.stdout).not.toContain('npm install')
    // The shared advice's numbered steps appear.
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
  })

  it('(b) main checkout real merge (regression): no install, advice printed', () => {
    const { root } = fixture!
    bumpLockfileViaMerge(root, makeFixtureEnv(), 'main', 'main-real', realMutate)

    const result = runHook(root)
    expect(result.status).toBe(0)

    expect(result.stdout).not.toMatch(/linked worktree/i)
    expect(result.stdout).not.toMatch(/^\s*npm install\s*$/m)
    expect(result.stdout).not.toContain('npm install')
    expect(result.stdout).toMatch(/real dependency change/i)
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
  })

  it('(c) main checkout cosmetic merge: no advice, one informational line, auto-heal kicked', async () => {
    const { root, autohealLog } = fixture!
    bumpLockfileViaMerge(root, makeFixtureEnv(), 'main', 'main-cosmetic', cosmeticMutate)

    const result = runHook(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/No install needed/)
    expect(result.stdout).not.toMatch(/regen-lockfile\.sh/)

    const log = await waitForLog(autohealLog, 'kick')
    expect(log).toContain('banner')
    expect(log).toContain('kick')
  })

  it('(d) main checkout real merge: advice printed in order, auto-heal deferred', () => {
    const { root, autohealLog } = fixture!
    bumpLockfileViaMerge(root, makeFixtureEnv(), 'main', 'main-real-2', realMutate)

    const result = runHook(root)
    expect(result.status).toBe(0)

    const advice = result.stdout
    const idx0 = advice.indexOf('0. Confirm')
    const idx3 = advice.indexOf('3. Regenerate')
    const idx6 = advice.indexOf('6. Re-run')
    expect(idx0).toBeGreaterThanOrEqual(0)
    expect(idx3).toBeGreaterThan(idx0)
    expect(idx6).toBeGreaterThan(idx3)

    expect(result.stdout).toContain('Retrieval auto-heal deferred')
    const log = readLogSafe(autohealLog)
    expect(log).toContain('banner')
    expect(log).not.toContain('kick')
  })

  it.each([
    ['non-zero exit, empty output', 'exit 1'],
    ['zero exit, empty output', 'exit 0'],
    ['zero exit, unrecognized token', "printf 'garbage\\n'"],
    // Code-review finding 1: a VALID token printed but a non-zero exit
    // (e.g. a crash right after the classifier's own stdout write) must
    // NOT be trusted — status and token are checked together, not token
    // alone.
    ['valid token (fresh) but non-zero exit', 'echo fresh; exit 9'],
  ])('(e) malformed classifier output (%s) → treated as unknown', (_label, body) => {
    const { root, autohealLog } = fixture!
    bumpLockfileViaMerge(root, makeFixtureEnv(), 'main', 'main-malformed', cosmeticMutate)

    const stubPath = join(root, 'fake-classify.sh')
    writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, 'utf8')
    chmodSync(stubPath, 0o755)

    const result = runHook(root, { SKILLSMITH_DEPS_CLASSIFY_SCRIPT_TEST: stubPath })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/real dependency change/i)
    expect(result.stdout).toMatch(/regen-lockfile\.sh/)
    expect(result.stdout).toContain('Retrieval auto-heal deferred')
    const log = readLogSafe(autohealLog)
    expect(log).not.toContain('kick')
  })
})
