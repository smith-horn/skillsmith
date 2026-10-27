/**
 * SMI-6465 / ADR-184: sync-main.sh never moves HEAD off main, never discards
 * uncommitted or unpushed work, and refuses with a three-line contract.
 *
 * Every case asserts a property (content, index blob, ref position, stash,
 * token, exit code), never prose. Every refusal also asserts, from the same
 * run, that the checkout is byte-for-byte as before. Case numbers follow the
 * plan: docs/internal/implementation/smi-6465-sync-main-preserve-uncommitted-work.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  blobOf,
  cleanupFixtures,
  commitLocal,
  git,
  GIT_ENV,
  gitRaw,
  grepFailEnv,
  makeRepo,
  odShimEnv,
  readlinkLoopEnv,
  originMain,
  pushUpstream,
  read,
  runSync,
  SCRIPT_PATH,
  SEED,
  shimEnv,
  trFailEnv,
  trNeedsCLocaleEnv,
  snapshot,
  STATE_POST,
  STATE_PRE,
  type Repo,
  type SyncResult,
  write,
} from './_lib/sync-main-fixture.js'

afterEach(cleanupFixtures)

/** T28: a refusal is exactly three stderr lines: token, state, next. */
function expectRefusal(
  result: SyncResult,
  token: string,
  state: string,
  exitCode = 1
): { cause: string } {
  const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  expect(result.status, detail).toBe(exitCode)
  const lines = result.stderr.replace(/\n$/, '').split('\n')
  expect(lines, detail).toHaveLength(3)
  const prefix = `sync-main: REFUSED [${token}]: `
  expect(lines[0].startsWith(prefix), detail).toBe(true)
  expect(lines[1], detail).toBe(state)
  expect(lines[2].startsWith('next: '), detail).toBe(true)
  expect(result.stdout, detail).not.toContain('Synced to main')
  return { cause: lines[0].slice(prefix.length) }
}

function expectSynced(repo: Repo, result: SyncResult): void {
  const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  expect(result.status, detail).toBe(0)
  expect(git(repo.local, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
  expect(git(repo.local, 'rev-parse', 'HEAD')).toBe(git(repo.up, 'rev-parse', 'HEAD'))
  expect(result.stdout, detail).toContain('Synced to main:')
}

/** Refused after the fetch: everything local is as it was. */
function refusedAfterFetch(repo: Repo, before: string, result: SyncResult, token: string) {
  const out = expectRefusal(result, token, STATE_POST)
  expect(snapshot(repo.local)).toBe(before)
  return out
}

describe('SMI-6465: behind origin, fast-forward keeps uncommitted work', () => {
  it('T1: keeps an unstaged edit on an unrelated path', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'c.txt', 'my edit\n')
    const result = runSync(repo.local)
    expectSynced(repo, result)
    expect(read(repo.local, 'c.txt')).toBe('my edit\n')
    expect(read(repo.local, 'a.txt')).toBe('a2\n')
    expect(result.stdout).toContain('Kept 1 uncommitted change(s):\n  c.txt\n')
  })

  it('T2: keeps the index: a staged edit and both halves of an MM path', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'b.txt', 'staged b\n')
    git(repo.local, 'add', 'b.txt')
    write(repo.local, 'c.txt', 'staged c\n')
    git(repo.local, 'add', 'c.txt')
    write(repo.local, 'c.txt', 'unstaged c\n')
    const result = runSync(repo.local)
    expectSynced(repo, result)
    expect(git(repo.local, 'rev-parse', ':b.txt')).toBe(blobOf(repo.local, 'staged b\n'))
    expect(git(repo.local, 'rev-parse', ':c.txt')).toBe(blobOf(repo.local, 'staged c\n'))
    expect(read(repo.local, 'c.txt')).toBe('unstaged c\n')
  })

  it('T3: refuses [overlap] for an edit on a path origin/main changes', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'a.txt', 'my a\n')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local), 'overlap')
    expect(cause).toContain('a.txt')
  })

  it('T9: keeps an untracked file on an unrelated path', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'scratch.txt', 'mine\n')
    expectSynced(repo, runSync(repo.local))
    expect(read(repo.local, 'scratch.txt')).toBe('mine\n')
  })

  it('T10: fires no hook on the fast-forward', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const hooks = join(repo.root, 'hk')
    const marker = join(repo.root, 'post-merge-fired')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-merge'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    git(repo.local, 'config', 'core.hooksPath', hooks)
    // Positive control: the hook does fire on a plain fast-forward in this fixture.
    const control = makeRepo()
    pushUpstream(control, { 'a.txt': 'a2\n' })
    git(control.local, 'config', 'core.hooksPath', hooks)
    git(control.local, 'pull', '-q', '--ff-only', 'origin', 'main')
    expect(existsSync(marker)).toBe(true)
    execFileSync('rm', [marker])

    expectSynced(repo, runSync(repo.local))
    expect(existsSync(marker)).toBe(false)
  })

  it('T12: refuses [overlap] with inherited merge.autoStash; stash untouched, no conflict', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'config', 'merge.autoStash', 'true')
    write(repo.local, 'a.txt', 'my a\n')
    const before = snapshot(repo.local)
    refusedAfterFetch(repo, before, runSync(repo.local), 'overlap')
    expect(git(repo.local, 'stash', 'list')).toBe('')
    expect(git(repo.local, 'status', '--porcelain')).not.toMatch(/^UU/m)
    expect(read(repo.local, 'a.txt')).toBe('my a\n')
  })

  it('T13: refuses [untracked-collision] for an ignored file at a path origin/main force-adds', () => {
    const repo = makeRepo({ ...SEED_WITH_IGNORE })
    pushUpstream(repo, { 'build.log': 'upstream log\n' }, { force: ['build.log'] })
    write(repo.local, 'build.log', 'my log\n')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local), 'untracked-collision')
    expect(cause).toContain('build.log')
    expect(read(repo.local, 'build.log')).toBe('my log\n')
  })

  it('T16: equal to origin with a dirty tree: exits 0 and reports the kept edit', () => {
    const repo = makeRepo()
    write(repo.local, 'c.txt', 'my edit\n')
    const result = runSync(repo.local)
    expectSynced(repo, result)
    expect(read(repo.local, 'c.txt')).toBe('my edit\n')
    expect(result.stdout).toContain('Kept 1 uncommitted change(s):')
  })

  it('T17: lists at most five kept paths and counts the rest', () => {
    const repo = makeRepo({
      ...SEED,
      'd.txt': 'd\n',
      'e.txt': 'e\n',
      'f.txt': 'f\n',
      'g.txt': 'g\n',
    })
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    for (const f of ['b', 'c', 'd', 'e', 'f', 'g', 'unrelated'])
      write(repo.local, `${f}.txt`, 'x\n')
    const result = runSync(repo.local)
    expectSynced(repo, result)
    const block = result.stdout.split('Kept 7 uncommitted change(s):\n')[1] ?? ''
    const listed = block.split('\n').filter((l) => /^ {2}\S/.test(l) && !l.includes('... and'))
    expect(listed).toHaveLength(5)
    expect(block).toContain('  ... and 2 more (git status --short)')
  })

  it('T27: refuses [untracked-collision] for a plain untracked file at a path origin/main adds', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'new.txt': 'upstream\n' })
    write(repo.local, 'new.txt', 'mine\n')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local), 'untracked-collision')
    expect(cause).toContain('new.txt')
  })

  it('T29: names a path with a space and one with a newline once each, unquoted, one line each', () => {
    const seed = { ...SEED, 'sp ace.txt': 's\n', 'new\nline.txt': 'n\n' }
    const kept = makeRepo(seed)
    pushUpstream(kept, { 'a.txt': 'a2\n' })
    write(kept.local, 'sp ace.txt', 'edit\n')
    write(kept.local, 'new\nline.txt', 'edit\n')
    const result = runSync(kept.local)
    expectSynced(kept, result)
    const lines = result.stdout.split('\n')
    expect(lines.filter((l) => l === '  sp ace.txt')).toHaveLength(1)
    expect(lines.filter((l) => l === '  new\\nline.txt')).toHaveLength(1)

    const clash = makeRepo(seed)
    pushUpstream(clash, { 'sp ace.txt': 'up\n', 'new\nline.txt': 'up\n' })
    write(clash.local, 'sp ace.txt', 'edit\n')
    write(clash.local, 'new\nline.txt', 'edit\n')
    const before = snapshot(clash.local)
    const { cause } = refusedAfterFetch(clash, before, runSync(clash.local), 'overlap')
    expect(cause.split('sp ace.txt')).toHaveLength(2)
    expect(cause.split('new\\nline.txt')).toHaveLength(2)
    expect(cause).not.toContain('"')
  })
})

const SEED_WITH_IGNORE = { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': '*.log\n' }

describe('SMI-6465: HEAD is never moved off the branch it found', () => {
  it('T4: refuses [not-on-main] on another branch, before fetching', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'checkout', '-q', '-b', 'feature/x')
    write(repo.local, 'c.txt', 'my edit\n')
    const fetchedBefore = originMain(repo.local)
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local), 'not-on-main', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
    expect(originMain(repo.local)).toBe(fetchedBefore)
  })

  it('T5: refuses [detached-head] when detached', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'checkout', '-q', '--detach')
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local), 'detached-head', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
  })

  it('T23: refuses [not-on-main] from a linked worktree; the main checkout is untouched', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const wt = join(repo.root, 'wt')
    git(repo.local, 'worktree', 'add', '-q', '-b', 'feature/wt', wt)
    write(repo.local, 'c.txt', 'main checkout edit\n')
    const mainBefore = snapshot(repo.local)
    const wtBefore = snapshot(wt)
    expectRefusal(runSync(wt), 'not-on-main', STATE_PRE)
    expect(snapshot(wt)).toBe(wtBefore)
    expect(snapshot(repo.local)).toBe(mainBefore)
  })

  it('T19: refuses [branch-changed-during-fetch] when another session switches the checkout', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-during-fetch'))
    expectRefusal(result, 'branch-changed-during-fetch', STATE_POST)
    expect(git(repo.local, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/y')
    expect(git(repo.local, 'rev-parse', 'feature/y')).toBe(local)
    expect(git(repo.local, 'rev-parse', 'main')).toBe(local)
  })

  it('T24: a switch just before the move exits 3 with a compare-and-swap restore', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(
      `ERROR [branch-changed-after-sync]: refs/heads/feature/x was moved ${local}→${remote}`
    )
    const cas = `git update-ref refs/heads/feature/x ${local} ${remote}`
    expect(result.stderr).toContain(cas)
    execFileSync('sh', ['-c', cas], { cwd: repo.local, env: GIT_ENV })
    expect(git(repo.local, 'rev-parse', 'feature/x')).toBe(local)
    expect(git(repo.local, 'rev-parse', 'main')).toBe(local)

    // Run 2: another session commits on feature/x after the move; no command is printed.
    const repo2 = makeRepo()
    pushUpstream(repo2, { 'a.txt': 'a2\n' })
    git(repo2.local, 'branch', 'feature/x')
    const result2 = runSync(repo2.local, [], shimEnv(repo2, 'switch-before-move-then-commit'))
    expect(result2.status, result2.stderr).toBe(3)
    expect(result2.stderr).toContain('refs/heads/feature/x moved again; reconcile by hand')
    expect(result2.stderr).not.toContain('git update-ref')
  })
})

describe('SMI-6465: local commits are never discarded by default', () => {
  it('T6: refuses [local-ahead] and leaves the commit at main', () => {
    const repo = makeRepo()
    const mine = commitLocal(repo, { 'mine.txt': 'key\n' })
    const before = snapshot(repo.local)
    const result = runSync(repo.local)
    refusedAfterFetch(repo, before, result, 'local-ahead')
    expect(git(repo.local, 'rev-parse', 'main')).toBe(mine)
    expect(result.stderr).toContain(`git branch save/main-${mine.slice(0, 7)}`)
  })

  it('T15: refuses [local-diverged] and keeps the local commit', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const mine = commitLocal(repo, { 'mine.txt': 'key\n' })
    const before = snapshot(repo.local)
    refusedAfterFetch(repo, before, runSync(repo.local), 'local-diverged')
    expect(git(repo.local, 'rev-parse', 'main')).toBe(mine)
  })

  it('T7: --discard-local-commits drops the commit and keeps an unrelated unstaged edit', () => {
    const repo = makeRepo()
    commitLocal(repo, { 'mine.txt': 'key\n' })
    write(repo.local, 'c.txt', 'my edit\n')
    expectSynced(repo, runSync(repo.local, ['--discard-local-commits']))
    expect(read(repo.local, 'c.txt')).toBe('my edit\n')
  })

  it('T8: --discard-local-commits refuses [staged-under-discard]', () => {
    const repo = makeRepo()
    const mine = commitLocal(repo, { 'mine.txt': 'key\n' })
    write(repo.local, 'c.txt', 'staged\n')
    git(repo.local, 'add', 'c.txt')
    const before = snapshot(repo.local)
    refusedAfterFetch(
      repo,
      before,
      runSync(repo.local, ['--discard-local-commits']),
      'staged-under-discard'
    )
    expect(git(repo.local, 'rev-parse', 'main')).toBe(mine)
    expect(git(repo.local, 'rev-parse', ':c.txt')).toBe(blobOf(repo.local, 'staged\n'))
  })

  it('T8b: --discard-local-commits refuses an intent-to-add path too', () => {
    const repo = makeRepo()
    commitLocal(repo, { 'mine.txt': 'key\n' })
    write(repo.local, 'ita.txt', 'planned\n')
    git(repo.local, 'add', '-N', 'ita.txt')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(
      repo,
      before,
      runSync(repo.local, ['--discard-local-commits']),
      'staged-under-discard'
    )
    expect(cause).toContain('ita.txt')
  })

  it('T14: --discard-local-commits refuses an ignored file at an incoming added path', () => {
    const repo = makeRepo({ ...SEED_WITH_IGNORE })
    pushUpstream(repo, { 'build.log': 'upstream log\n' }, { force: ['build.log'] })
    const mine = commitLocal(repo, { 'mine.txt': 'key\n' })
    write(repo.local, 'build.log', 'my log\n')
    const before = snapshot(repo.local)
    refusedAfterFetch(
      repo,
      before,
      runSync(repo.local, ['--discard-local-commits']),
      'untracked-collision'
    )
    expect(git(repo.local, 'rev-parse', 'main')).toBe(mine)
    expect(read(repo.local, 'build.log')).toBe('my log\n')
  })

  it('T30: --discard-local-commits keeps an unrelated untracked file', () => {
    const repo = makeRepo()
    commitLocal(repo, { 'mine.txt': 'key\n' })
    write(repo.local, 'scratch.txt', 'mine\n')
    expectSynced(repo, runSync(repo.local, ['--discard-local-commits']))
    expect(read(repo.local, 'scratch.txt')).toBe('mine\n')
  })
})

describe('SMI-6465: preconditions, arguments and fetch', () => {
  it('T11: refuses [usage] for an unknown argument, exit 2, without fetching', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const fetched = originMain(repo.local)
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local, ['--bogus']), 'usage', STATE_PRE, 2)
    expect(snapshot(repo.local)).toBe(before)
    expect(originMain(repo.local)).toBe(fetched)
  })

  it('T21: --help exits 0 without fetching or moving anything', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const fetched = originMain(repo.local)
    const before = snapshot(repo.local)
    const result = runSync(repo.local, ['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--discard-local-commits')
    expect(snapshot(repo.local)).toBe(before)
    expect(originMain(repo.local)).toBe(fetched)
  })

  it('T18: refuses [in-progress-op] during a stopped git am, even with the flag', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const patch = gitRaw(repo.up, 'format-patch', '-1', '--stdout')
    commitLocal(repo, { 'a.txt': 'conflicting\n' })
    execFileSync('sh', ['-c', 'git am -q || true'], {
      cwd: repo.local,
      input: patch,
      env: GIT_ENV,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    expect(existsSync(join(repo.local, '.git', 'rebase-apply'))).toBe(true)
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local, ['--discard-local-commits']), 'in-progress-op', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
  })

  it('T26: refuses [unsupported-state] in a sparse checkout, without fetching', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'config', 'core.sparseCheckout', 'true')
    const fetched = originMain(repo.local)
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local), 'unsupported-state', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
    expect(originMain(repo.local)).toBe(fetched)
  })

  it('T22: refuses [fetch-failed] for an unreachable remote', () => {
    const repo = makeRepo()
    git(repo.local, 'remote', 'set-url', 'origin', join(repo.root, 'missing.git'))
    write(repo.local, 'c.txt', 'my edit\n')
    const before = snapshot(repo.local)
    expectRefusal(runSync(repo.local), 'fetch-failed', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
  })
})

/** Local config: smudging *.enc always fails and the filter is required. */
function makeFailingFilterRepo(): Repo {
  const repo = makeRepo({ ...SEED, '.gitattributes': '*.enc filter=failer\n' })
  git(repo.local, 'config', 'filter.failer.smudge', 'false')
  git(repo.local, 'config', 'filter.failer.clean', 'cat')
  git(repo.local, 'config', 'filter.failer.required', 'true')
  pushUpstream(repo, { 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'c.enc': 'secret\n' })
  return repo
}

describe('SMI-6465: a move that fails partway is reported, not hidden', () => {
  it('T20: a failing required filter mid-move exits 3 [partial-move] naming the torn paths', () => {
    const repo = makeFailingFilterRepo()
    const local = git(repo.local, 'rev-parse', 'HEAD')
    const result = runSync(repo.local)
    expect(result.status, result.stderr).toBe(3)
    const first = result.stderr.split('\n')[0]
    expect(first).toMatch(/^ERROR \[partial-move\]: /)
    expect(first).toContain('a.txt')
    expect(first).toContain('b.txt')
    expect(git(repo.local, 'rev-parse', 'HEAD')).toBe(local)
  })

  it('T25: never blames an unrelated path another session edited during the move', () => {
    const repo = makeFailingFilterRepo()
    const result = runSync(repo.local, [], shimEnv(repo, 'edit-unrelated-before-move'))
    expect(result.status, result.stderr).toBe(3)
    const first = result.stderr.split('\n')[0]
    expect(first).toMatch(/^ERROR \[partial-move\]: /)
    expect(first).toContain('a.txt')
    expect(first).not.toContain('unrelated.txt')
    expect(read(repo.local, 'unrelated.txt')).toBe('u\nedited by another session\n')
  })
})

describe('SMI-6465 review round: governance and GPT-5.6-Sol findings', () => {
  it('T32: run from a subdirectory, an overlap is still named [overlap]', () => {
    const repo = makeRepo({ ...SEED, 'd/f.txt': 'f\n' })
    pushUpstream(repo, { 'd/f.txt': 'f2\n' })
    write(repo.local, 'd/f.txt', 'my f\n')
    const before = snapshot(repo.local)
    const result = runSync(join(repo.local, 'd'))
    const { cause } = refusedAfterFetch(repo, before, result, 'overlap')
    expect(cause).toContain('d/f.txt')
  })

  it('T33: a staged edit on a path origin/main changes is refused [overlap]', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'a.txt', 'staged a\n')
    git(repo.local, 'add', 'a.txt')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local), 'overlap')
    expect(cause).toContain('a.txt')
  })

  it('T34: a failed move with no incoming paths is [keep-refused], not [partial-move]', () => {
    const repo = makeRepo()
    git(repo.local, 'commit', '-q', '--allow-empty', '-m', 'empty local commit')
    const before = snapshot(repo.local)
    const result = runSync(repo.local, ['--discard-local-commits'], shimEnv(repo, 'fail-move'))
    refusedAfterFetch(repo, before, result, 'keep-refused')
  })

  it('T35: an index-only change during a failed move is [partial-move] naming the path', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const result = runSync(repo.local, [], shimEnv(repo, 'stage-incoming-then-fail'))
    expect(result.status, result.stderr).toBe(3)
    const first = result.stderr.split('\n')[0]
    expect(first).toMatch(/^ERROR \[partial-move\]: /)
    expect(first).toMatch(/: a\.txt$/)
  })

  it('T36: on the --discard-local-commits path, a switch before the move gets the same CAS restore', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = commitLocal(repo, { 'mine.txt': 'key\n' })
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(
      repo.local,
      ['--discard-local-commits'],
      shimEnv(repo, 'switch-before-move')
    )
    expect(result.status, result.stderr).toBe(3)
    const cas = `git update-ref refs/heads/feature/x ${local} ${remote}`
    expect(result.stderr).toContain(cas)
    execFileSync('sh', ['-c', cas], { cwd: repo.local, env: GIT_ENV })
    expect(git(repo.local, 'rev-parse', 'feature/x')).toBe(local)
    expect(git(repo.local, 'rev-parse', 'main')).toBe(local)
  })

  it('T37: the restore value comes from the moved ref, not ORIG_HEAD another session rewrote', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move-overwrite-orig-head'))
    expect(result.status, result.stderr).toBe(3)
    expect(git(repo.local, 'rev-parse', 'ORIG_HEAD')).toBe(remote)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it('T38: main diverging just before the move is refused; no merge commit, no merge state', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const result = runSync(repo.local, [], shimEnv(repo, 'diverge-main-before-move'))
    expectRefusal(result, 'ff-refused', STATE_POST)
    expect(git(repo.local, 'log', '-1', '--format=%s', 'main')).toBe('race commit on main')
    expect(git(repo.local, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(1)
    expect(existsSync(join(repo.local, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(read(repo.local, 'a.txt')).toBe('a\n')
  })
})

describe('SMI-6465 review round: a git error is never read as an answer', () => {
  it('T39: merge-base failing (exit 128) exits 3, not a local-diverged refusal', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const result = runSync(repo.local, [], shimEnv(repo, 'merge-base-fails'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain('git merge-base --is-ancestor failed (exit 128)')
    expect(result.stderr).not.toContain('REFUSED')
    expect(snapshot(repo.local)).toBe(before)
  })
})

describe('SMI-6465 confirmation round: restore ownership and relative locations', () => {
  it('T40: a relative TMPDIR from a subdirectory still syncs and leaves no temp dir', () => {
    const repo = makeRepo({ ...SEED, 'd/f.txt': 'f\n' })
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'c.txt', 'my edit\n')
    mkdirSync(join(repo.local, 'd', 't'))
    const result = runSync(join(repo.local, 'd'), [], { ...GIT_ENV, TMPDIR: 't' })
    expectSynced(repo, result)
    expect(read(repo.local, 'c.txt')).toBe('my edit\n')
    expect(readdirSync(join(repo.local, 'd', 't'))).toEqual([])
  })

  it('T41: relative GIT_DIR and GIT_WORK_TREE from outside the work tree still sync it', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'c.txt', 'my edit\n')
    const env = { ...GIT_ENV, GIT_DIR: 'local/.git', GIT_WORK_TREE: 'local' }
    expectSynced(repo, runSync(repo.root, [], env))
    expect(read(repo.local, 'c.txt')).toBe('my edit\n')
  })

  it('T42: another session moving the ref away and back prints no restore command', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move-then-away-and-back'))
    expect(result.status, result.stderr).toBe(3)
    expect(git(repo.local, 'rev-parse', 'feature/x')).toBe(git(repo.up, 'rev-parse', 'HEAD'))
    expect(result.stderr).toContain('reconcile by hand')
    expect(result.stderr).not.toContain('git update-ref')
  })

  it('T43: a matching reflog entry older than this sync is not taken as its own', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const log = join(repo.local, '.git', 'logs', 'refs', 'heads', 'feature', 'x')
    const stale = `${'1'.repeat(40)} ${remote} t <t@t> 1000000000 +0000\tmerge ${remote}: Fast-forward\n`
    writeFileSync(log, readFileSync(log, 'utf8') + stale)
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })
})

describe('SMI-6465 confirmation round: each path is named once', () => {
  it('T44: a path both staged and unstaged on an incoming path is named once in [overlap]', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    write(repo.local, 'a.txt', 'staged a\n')
    git(repo.local, 'add', 'a.txt')
    write(repo.local, 'a.txt', 'unstaged a\n')
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local), 'overlap')
    expect(cause.split('a.txt')).toHaveLength(2)
  })
})

describe("SMI-6465 confirmation rounds: the restore value is this run's own, whatever the clock", () => {
  function run(mode: string): { result: SyncResult; local: string; remote: string } {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    return { result: runSync(repo.local, [], shimEnv(repo, mode)), local, remote }
  }

  it('T45: a clock step back plus a future-dated matching entry: the command still names the true old value', () => {
    const { result, local, remote } = run('reflog-rollback-with-future')
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it("T46: an entry dated after the move does not change which entry is this run's", () => {
    const { result, local, remote } = run('reflog-future-other')
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it("T47: an in-window entry from someone else does not change which entry is this run's", () => {
    const { result, local, remote } = run('reflog-rollback-with-inwindow')
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it('T48: another sync moved the ref first and this run was a no-op: no restore command', () => {
    const { result, remote } = run('other-sync-moves-first')
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain(`no reflog entry shows this sync moving it`)
    expect(result.stderr).toContain(remote.slice(0, 12))
    expect(result.stderr).not.toContain('git update-ref')
  })
})

describe('SMI-6465 fourth confirmation round: the reflog nonce is unpredictable', () => {
  it('T49: two runs tag their moves with different 128-bit nonces', () => {
    const subjects = [0, 1].map(() => {
      const repo = makeRepo()
      pushUpstream(repo, { 'a.txt': 'a2\n' })
      git(repo.local, 'branch', 'feature/x')
      const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move'))
      expect(result.status, result.stderr).toBe(3)
      return git(repo.local, 'log', '-g', '-1', '--format=%gs', 'refs/heads/feature/x')
    })
    for (const s of subjects) expect(s).toMatch(/^sync-main [0-9a-f]{32}: Fast-forward$/)
    expect(subjects[0]).not.toBe(subjects[1])
  })
})

describe('SMI-6465 pre-merge gate: success is checked by outcome, not by where HEAD points', () => {
  it('T52: a switch away before the move and back after it is not reported as a sync', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-before-move-and-back'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(git(repo.local, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git(repo.local, 'rev-parse', 'main')).toBe(local)
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })
})

describe("SMI-6465 pre-merge gate: a foreign ref carrying this run's entry is never a sync", () => {
  it('T53: main reaching origin by another sync does not hide this run moving feature/x', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-and-back-then-other-sync'))
    expect(git(repo.local, 'rev-parse', 'main')).toBe(remote)
    expect(git(repo.local, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })
})

describe('SMI-6465 pre-merge gate: main not at origin after a move is never a sync', () => {
  it('T54: a detach before the move and a return to main after it exits 3, not success', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    const result = runSync(repo.local, [], shimEnv(repo, 'detach-before-move-and-back'))
    expect(git(repo.local, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git(repo.local, 'rev-parse', 'main')).toBe(local)
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(result.stderr).toContain('no reflog entry shows this sync moving it')
  })
})

describe('SMI-6465 pre-merge gate round 2: the moved-ref scan is authoritative', () => {
  function featureLog(repo: Repo): string {
    return join(repo.local, '.git', 'logs', 'refs', 'heads', 'feature', 'x')
  }

  it('T55: with reflogs disabled and no feature/x log, a raced move is still caught', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'config', 'core.logAllRefUpdates', 'false')
    git(repo.local, 'branch', 'feature/x')
    expect(existsSync(featureLog(repo))).toBe(false)
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-and-back-then-other-sync'))
    expect(git(repo.local, 'rev-parse', 'main')).toBe(remote)
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it('T56: a symlinked branch log is still scanned', () => {
    const repo = makeRepo()
    const remote = pushUpstream(repo, { 'a.txt': 'a2\n' })
    const local = git(repo.local, 'rev-parse', 'HEAD')
    git(repo.local, 'branch', 'feature/x')
    const elsewhere = join(repo.root, 'feature-x.log')
    renameSync(featureLog(repo), elsewhere)
    symlinkSync(elsewhere, featureLog(repo))
    const result = runSync(repo.local, [], shimEnv(repo, 'switch-and-back-then-other-sync'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(result.stderr).toContain(`git update-ref refs/heads/feature/x ${local} ${remote}`)
  })

  it('T57: a reflog scan that errors is "could not verify", never success', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const result = runSync(repo.local, [], grepFailEnv(repo))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(result.stderr).toContain('could not read the branch reflogs')
  })

  it('T58: an uncontended sync with reflogs disabled and no main log still succeeds', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    git(repo.local, 'config', 'core.logAllRefUpdates', 'false')
    rmSync(join(repo.local, '.git', 'logs', 'refs', 'heads', 'main'))
    expectSynced(repo, runSync(repo.local))
  })
})

describe('SMI-6465 pre-merge gate round 3: the discard path also forces its reflog entry', () => {
  it('T59: --discard-local-commits with reflogs disabled and no main log still succeeds', () => {
    const repo = makeRepo()
    commitLocal(repo, { 'mine.txt': 'key\n' })
    git(repo.local, 'config', 'core.logAllRefUpdates', 'false')
    rmSync(join(repo.local, '.git', 'logs', 'refs', 'heads', 'main'))
    expectSynced(repo, runSync(repo.local, ['--discard-local-commits']))
  })
})

describe("SMI-6465 retro: a refusal git explains carries git's own reason", () => {
  it('T60: [keep-refused] names the first line git printed', () => {
    const repo = makeRepo()
    commitLocal(repo, { 'mine.txt': 'key\n' })
    const before = snapshot(repo.local)
    const result = runSync(
      repo.local,
      ['--discard-local-commits'],
      shimEnv(repo, 'fail-move-with-message')
    )
    const { cause } = refusedAfterFetch(repo, before, result, 'keep-refused')
    expect(cause).toContain('fatal: simulated index.lock held')
    expect(cause).not.toContain('\r')
    expect(result.stderr).not.toContain('paths above')
  })

  it('T61: [ff-refused] names the first line git printed', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const result = runSync(repo.local, [], shimEnv(repo, 'fail-move-with-message'))
    const { cause } = refusedAfterFetch(repo, before, result, 'ff-refused')
    expect(cause).toContain('fatal: simulated index.lock held')
  })
})

describe('SMI-6465 retro gate: any git output yields a one-line refusal, exit 1', () => {
  // [shim mode, the reason the cause must end with (or a predicate on it)]
  const cases: Array<[string, (reason: string) => void]> = [
    ['fail-move-out-verbose', (r) => expect(r).toBe('fatal: first line')],
    ['fail-move-out-leading', (r) => expect(r).toBe('fatal: after blanks')],
    ['fail-move-out-ansi', (r) => expect(r).toBe('[31mfatal: red[0m tail')],
    ['fail-move-out-long', (r) => expect(r).toBe(`fatal: ${'x'.repeat(193)}`)],
    ['fail-move-out-empty', (r) => expect(r).toBe('no message from git')],
    ['fail-move-out-malformed', (r) => expect(r).toBe('fatal: bad ?? bytes ? C1 DEL end')],
    ['fail-move-out-huge', (r) => expect(r).toBe(`fatal: ${'x'.repeat(193)}`)],
  ]
  for (const [mode, check] of cases) {
    for (const flow of ['ff', 'keep'] as const) {
      it(`T62 ${flow} ${mode}`, () => {
        const repo = makeRepo()
        if (flow === 'ff') pushUpstream(repo, { 'a.txt': 'a2\n' })
        else commitLocal(repo, { 'mine.txt': 'key\n' })
        const before = snapshot(repo.local)
        const args = flow === 'keep' ? ['--discard-local-commits'] : []
        const token = flow === 'keep' ? 'keep-refused' : 'ff-refused'
        // A UTF-8 locale, where a malformed byte can make a non-C tr exit.
        const result = runSync(repo.local, args, { ...shimEnv(repo, mode), LC_ALL: 'C.UTF-8' })
        const { cause } = refusedAfterFetch(repo, before, result, token)
        // eslint-disable-next-line no-control-regex
        expect(cause).not.toMatch(/[\x00-\x1f\x7f]/)
        check(cause.slice(cause.indexOf(': ') + 2))
      })
    }
  }
})

describe('SMI-6465 retro gate round 2: a fetch failure renders as one line too', () => {
  it('T63: malformed bytes in fetch output give one [fetch-failed] line, exit 1', () => {
    const repo = makeRepo()
    const before = snapshot(repo.local)
    const result = runSync(repo.local, [], {
      ...shimEnv(repo, 'fetch-fails-malformed'),
      LC_ALL: 'C.UTF-8',
    })
    const { cause } = expectRefusal(result, 'fetch-failed', STATE_PRE)
    expect(snapshot(repo.local)).toBe(before)
    expect(cause).toBe('git fetch origin main failed: fatal: bad ?? fetch ?end')
  })
})

describe("SMI-6465 retro gate round 2: rendering git's reason can never fail", () => {
  it('T64: a stage of the reason pipeline failing still gives one [ff-refused] line, exit 1', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const env = trFailEnv(repo, shimEnv(repo, 'fail-move-with-message'))
    const result = runSync(repo.local, [], env)
    const { cause } = refusedAfterFetch(repo, before, result, 'ff-refused')
    expect(cause.endsWith(': no message from git')).toBe(true)
    expect(result.stderr).not.toContain('Illegal byte sequence')
  })
})

describe('SMI-6465 retro gate round 3: the helper is found however the script is run', () => {
  function runAs(cwd: string, script: string, env: NodeJS.ProcessEnv): SyncResult {
    const r = spawnSync('bash', [script], { cwd, encoding: 'utf8', env, timeout: 30_000 })
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('T65: run by a CDPATH-resolvable relative path with CDPATH set, it still syncs', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    symlinkSync(dirname(SCRIPT_PATH), join(repo.local, 'x'))
    // `cd x` consults CDPATH (x does not start with / or .) and prints the directory.
    const result = runAs(repo.local, 'x/sync-main.sh', { ...GIT_ENV, CDPATH: repo.local })
    expectSynced(repo, result)
  })

  it('T67: a ../ link through a symlinked directory resolves, and syncs (pin)', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    // d1 -> d2/sub; d1/a -> ../a, which resolves through d1 to d2/a, the script.
    const base = join(repo.root, 'links')
    mkdirSync(join(base, 'd2', 'sub'), { recursive: true })
    symlinkSync(join(base, 'd2', 'sub'), join(base, 'd1'))
    symlinkSync(SCRIPT_PATH, join(base, 'd2', 'a'))
    symlinkSync('../a', join(base, 'd2', 'sub', 'a'))
    symlinkSync('d1/a', join(base, 'a'))
    const started = Date.now()
    const result = runAs(repo.local, join(base, 'a'), GIT_ENV)
    expect(Date.now() - started).toBeLessThan(20_000)
    expectSynced(repo, result)
  })

  // Pins the kernel's refusal; it does not reach the script's own hop limit (T69 does).
  it('T68: a symlink cycle cannot run at all: the kernel refuses it (ELOOP)', () => {
    const repo = makeRepo()
    const bin = join(repo.root, 'bin')
    mkdirSync(bin)
    symlinkSync('b', join(bin, 'a'))
    symlinkSync('a', join(bin, 'b'))
    const result = runAs(repo.local, join(bin, 'a'), GIT_ENV)
    expect(result.status).toBe(126)
    expect(result.stderr).toMatch(/Too many levels of symbolic links/i)
  })

  it('T69: symlink resolution that never ends stops at the 40-hop limit, exit 3', () => {
    const repo = makeRepo()
    mkdirSync(join(repo.root, 'bin'))
    symlinkSync(SCRIPT_PATH, join(repo.root, 'bin', 'loop'))
    // The kernel follows bin/loop to the script; the shimmed readlink keeps
    // answering "loop", so the script's own walk never reaches a non-link.
    const result = runAs(repo.local, join(repo.root, 'bin', 'loop'), readlinkLoopEnv(repo, 'loop'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain('more than 40 symlinks')
  })

  it('T72: a missing helper file exits 3 and names it', () => {
    const repo = makeRepo()
    mkdirSync(join(repo.root, 'tool'))
    copyFileSync(SCRIPT_PATH, join(repo.root, 'tool', 'sync-main.sh'))
    const result = runAs(repo.local, join(repo.root, 'tool', 'sync-main.sh'), GIT_ENV)
    expect(result.status, result.stderr).toBe(3)
    expect(result.stderr).toContain('sync-main: ERROR: cannot read')
    expect(result.stderr).toContain('lib/sync-main-render.sh')
  })

  it('T66: run through a symlink outside scripts/, it still syncs', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    mkdirSync(join(repo.root, 'bin'))
    symlinkSync(SCRIPT_PATH, join(repo.root, 'bin', 'sync'))
    expectSynced(repo, runAs(repo.local, join(repo.root, 'bin', 'sync'), GIT_ENV))
  })
})

describe('SMI-6465 retro 2: rendering pins the C locale and skips control-only lines', () => {
  it('T70: one_line runs every stage under LC_ALL=C, whatever the caller set', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const env = trNeedsCLocaleEnv(repo, {
      ...shimEnv(repo, 'fail-move-with-message'),
      LC_ALL: 'C.UTF-8',
    })
    const { cause } = refusedAfterFetch(repo, before, runSync(repo.local, [], env), 'ff-refused')
    expect(cause.endsWith(': fatal: simulated index.lock held')).toBe(true)
  })

  it('T71: a first line of control bytes alone does not hide the real reason', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const { cause } = refusedAfterFetch(
      repo,
      before,
      runSync(repo.local, [], shimEnv(repo, 'fail-move-out-ctl-first')),
      'ff-refused'
    )
    expect(cause.endsWith(': fatal: real reason')).toBe(true)
  })
})

describe('SMI-6465 pre-merge gate: the nonce-failure path moves nothing', () => {
  it('T50: od printing too few bytes exits 3 before any move, stating the post-fetch state', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const result = runSync(repo.local, [], odShimEnv(repo, 'short'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(snapshot(repo.local)).toBe(before)
    expect(result.stderr).toContain(
      `could not read 16 random bytes for the reflog nonce. ${STATE_POST}`
    )
  })

  it('T51: od failing exits 3 through the ERR trap before any move', () => {
    const repo = makeRepo()
    pushUpstream(repo, { 'a.txt': 'a2\n' })
    const before = snapshot(repo.local)
    const result = runSync(repo.local, [], odShimEnv(repo, 'fail'))
    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).not.toContain('Synced to main')
    expect(snapshot(repo.local)).toBe(before)
    expect(result.stderr).toContain('sync-main: ERROR: unexpected failure at line')
  })
})
