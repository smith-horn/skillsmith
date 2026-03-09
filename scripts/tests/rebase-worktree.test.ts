/**
 * Integration tests for rebase-worktree.sh (SMI-3102, Wave 2)
 *
 * All tests create throwaway git repos in temp directories.
 * No actual Skillsmith repo or git-crypt encryption is used.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Absolute path to the script under test
const SCRIPT_PATH = join(__dirname, '..', 'rebase-worktree.sh')

/** Shared env for all git commands — ensures main as default branch */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/** Create a unique temp directory with Date.now() + random suffix */
function makeTempDir(prefix: string): string {
  const base = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  return mkdtempSync(base)
}

/** Run a git command in a directory, returning stdout */
function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

/** Run a shell command with the standard git env */
function sh(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', env: GIT_ENV, ...opts }).trim()
}

/** Run the rebase-worktree.sh script, returning { status, stdout, stderr } */
function runScript(args: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" ${args}`, {
      encoding: 'utf8',
      timeout: 30_000,
      env: GIT_ENV,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/**
 * Create a bare "remote" repo, clone it, make an initial commit,
 * push to origin, and create a worktree on a feature branch.
 *
 * Returns { bareDir, cloneDir, worktreeDir, cleanup }
 */
function setupRepoWithWorktree(tempRoot: string): {
  bareDir: string
  cloneDir: string
  worktreeDir: string
} {
  const bareDir = join(tempRoot, 'bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  // Create bare remote with main as default branch
  git(tempRoot, `init --bare "${bareDir}"`)

  // Clone it
  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)

  // Initial commit on main
  sh(`touch "${join(cloneDir, 'README.md')}"`)
  git(cloneDir, 'add README.md')
  git(cloneDir, 'commit -m "initial commit"')
  git(cloneDir, 'push origin main')

  // Create worktree on a feature branch
  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)

  return { bareDir, cloneDir, worktreeDir }
}

// Collect temp dirs for cleanup
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-3102: rebase-worktree.sh', () => {
  // Scenario 1: Happy path — worktree behind main, no submodule
  it('rebases a worktree that is behind main', () => {
    const tempRoot = makeTempDir('rw-test1')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Advance main by 1 commit (via clone, push to bare)
    git(cloneDir, 'checkout main')
    sh(`echo "new content" > "${join(cloneDir, 'file.txt')}"`)
    git(cloneDir, 'add file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -') // back to whatever branch

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')

    // Verify the worktree has the new commit from main
    const log = git(worktreeDir, 'log --oneline')
    expect(log).toContain('advance main')
  })

  // Scenario 2: Happy path — worktree behind main, submodule pointer diverged
  it('rebases with submodule pointer update', () => {
    const tempRoot = makeTempDir('rw-test2')
    tempDirs.push(tempRoot)

    const bareDir = join(tempRoot, 'bare.git')
    const subBareDir = join(tempRoot, 'sub-bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')

    // Create bare repos (main + submodule)
    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `init --bare "${subBareDir}"`)

    // Seed the submodule bare repo with a commit
    const subSeedDir = join(tempRoot, 'sub-seed')
    git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
    sh(`touch "${join(subSeedDir, 'doc.md')}"`)
    git(subSeedDir, 'add doc.md')
    git(subSeedDir, 'commit -m "sub initial"')
    git(subSeedDir, 'push origin main')

    // Clone main repo and add submodule
    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    sh(`touch "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "initial commit"')
    git(cloneDir, `submodule add "${subBareDir}" docs/internal`)
    git(cloneDir, 'commit -m "add submodule"')
    git(cloneDir, 'push origin main')

    // Create worktree
    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
    // Init submodule in worktree
    git(worktreeDir, 'submodule update --init')

    // Advance submodule in main: add a commit to submodule, update pointer in main
    const subInClone = join(cloneDir, 'docs', 'internal')
    git(cloneDir, 'checkout main')
    sh(`echo "updated" > "${join(subInClone, 'new.md')}"`)
    git(subInClone, 'add new.md')
    git(subInClone, 'commit -m "sub advance"')
    git(subInClone, 'push origin main')
    git(cloneDir, 'add docs/internal')
    git(cloneDir, 'commit -m "bump submodule"')
    git(cloneDir, 'push origin main')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')

    // Verify worktree submodule is at the new pointer
    const subHead = git(join(worktreeDir, 'docs', 'internal'), 'rev-parse HEAD')
    const targetSubSha = git(cloneDir, 'ls-tree HEAD -- docs/internal').split(/\s+/)[2]
    expect(subHead).toBe(targetSubSha)
  })

  // Scenario 3: Already up-to-date
  it('exits 0 with up-to-date message when no rebase needed', () => {
    const tempRoot = makeTempDir('rw-test3')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupRepoWithWorktree(tempRoot)

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('up-to-date')
  })

  // Scenario 4: Non-submodule conflict
  it('exits 2 with conflict instructions on non-submodule conflict', () => {
    const tempRoot = makeTempDir('rw-test4')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Create conflicting changes: same file, different content
    // Commit on worktree branch
    sh(`echo "worktree content" > "${join(worktreeDir, 'conflict.txt')}"`)
    git(worktreeDir, 'add conflict.txt')
    git(worktreeDir, 'commit -m "worktree change"')

    // Commit on main (via clone), push
    git(cloneDir, 'checkout main')
    sh(`echo "main content" > "${join(cloneDir, 'conflict.txt')}"`)
    git(cloneDir, 'add conflict.txt')
    git(cloneDir, 'commit -m "main change"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(2)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('REBASE CONFLICT')
    expect(combined).toContain('conflict.txt')

    // Clean up: abort the in-progress rebase so rmSync can remove the dir
    try {
      git(worktreeDir, 'rebase --abort')
    } catch {
      /* may already be clean */
    }
  })

  // Scenario 5: Invalid worktree path
  it('exits 1 for a non-existent path', () => {
    const result = runScript('/tmp/does-not-exist-ever-12345')
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/does not exist|not a git repository/i)
  })

  // Scenario 6: --dry-run
  it('prints planned steps without mutations on --dry-run', () => {
    const tempRoot = makeTempDir('rw-test6')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Advance main so there is something to rebase
    git(cloneDir, 'checkout main')
    sh(`echo "dry-run content" > "${join(cloneDir, 'dry.txt')}"`)
    git(cloneDir, 'add dry.txt')
    git(cloneDir, 'commit -m "advance for dry-run"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Record HEAD before dry-run
    const headBefore = git(worktreeDir, 'rev-parse HEAD')

    const result = runScript(`--dry-run "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry-run')
    expect(result.stdout).toContain('Dry run complete')

    // Verify no mutation: HEAD unchanged
    const headAfter = git(worktreeDir, 'rev-parse HEAD')
    expect(headAfter).toBe(headBefore)
  })

  // Scenario 7: --no-submodule
  it('skips submodule steps when --no-submodule is passed', () => {
    const tempRoot = makeTempDir('rw-test7')
    tempDirs.push(tempRoot)

    const bareDir = join(tempRoot, 'bare.git')
    const subBareDir = join(tempRoot, 'sub-bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')

    // Create bare repos
    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `init --bare "${subBareDir}"`)

    // Seed submodule
    const subSeedDir = join(tempRoot, 'sub-seed')
    git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
    sh(`touch "${join(subSeedDir, 'doc.md')}"`)
    git(subSeedDir, 'add doc.md')
    git(subSeedDir, 'commit -m "sub initial"')
    git(subSeedDir, 'push origin main')

    // Clone + add submodule
    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    sh(`touch "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "initial"')
    git(cloneDir, `submodule add "${subBareDir}" docs/internal`)
    git(cloneDir, 'commit -m "add submodule"')
    git(cloneDir, 'push origin main')

    // Create worktree + init submodule
    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
    git(worktreeDir, 'submodule update --init')

    // Advance main
    git(cloneDir, 'checkout main')
    sh(`echo "new" > "${join(cloneDir, 'extra.txt')}"`)
    git(cloneDir, 'add extra.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--no-submodule "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--no-submodule')
    // The success report should NOT show submodule info
    expect(result.stdout).not.toContain('Submodule: docs/internal')
  })

  // Scenario 8: Staged changes
  it('exits 1 when worktree has staged changes', () => {
    const tempRoot = makeTempDir('rw-test8')
    tempDirs.push(tempRoot)
    const { worktreeDir } = setupRepoWithWorktree(tempRoot)

    // Stage a file
    sh(`echo "staged" > "${join(worktreeDir, 'staged.txt')}"`)
    git(worktreeDir, 'add staged.txt')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('staged changes')
  })

  // Scenario 9: Submodule ahead of target (directional guard)
  it('exits 1 when worktree submodule is ahead of target', () => {
    const tempRoot = makeTempDir('rw-test9')
    tempDirs.push(tempRoot)

    const bareDir = join(tempRoot, 'bare.git')
    const subBareDir = join(tempRoot, 'sub-bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')

    // Create bare repos
    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `init --bare "${subBareDir}"`)

    // Seed submodule
    const subSeedDir = join(tempRoot, 'sub-seed')
    git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
    sh(`touch "${join(subSeedDir, 'doc.md')}"`)
    git(subSeedDir, 'add doc.md')
    git(subSeedDir, 'commit -m "sub initial"')
    git(subSeedDir, 'push origin main')

    // Clone + add submodule
    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    sh(`touch "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "initial"')
    git(cloneDir, `submodule add "${subBareDir}" docs/internal`)
    git(cloneDir, 'commit -m "add submodule"')
    git(cloneDir, 'push origin main')

    // Create worktree + init submodule
    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
    git(worktreeDir, 'submodule update --init')

    // Advance the worktree's submodule AHEAD of main's pointer
    const wtSub = join(worktreeDir, 'docs', 'internal')
    sh(`echo "ahead content" > "${join(wtSub, 'ahead.md')}"`)
    git(wtSub, 'add ahead.md')
    git(wtSub, 'commit -m "worktree sub ahead"')

    // Advance main (non-submodule change) so rebase is needed
    git(cloneDir, 'checkout main')
    sh(`echo "main advance" > "${join(cloneDir, 'main-file.txt')}"`)
    git(cloneDir, 'add main-file.txt')
    git(cloneDir, 'commit -m "advance main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('AHEAD')
  })
})
