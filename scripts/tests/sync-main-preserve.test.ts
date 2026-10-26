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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  blobOf,
  cleanupFixtures,
  commitLocal,
  git,
  GIT_ENV,
  makeRepo,
  originMain,
  pushUpstream,
  read,
  runSync,
  SEED,
  shimEnv,
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
    const patch = execFileSync('git', ['format-patch', '-1', '--stdout'], {
      cwd: repo.up,
      encoding: 'utf8',
      env: GIT_ENV,
    })
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
