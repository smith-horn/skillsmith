/**
 * Integration tests for remove-worktree.sh (SMI-4653)
 *
 * Verifies the per-worktree Docker resource cleanup added in SMI-4653:
 *   - Default flow runs `docker compose down --volumes --rmi local`
 *   - Name-based fallback always runs (`docker rmi`, `docker volume rm`)
 *   - Compose-fail / rmi-fail paths still continue
 *   - --keep-docker skips all cleanup
 *   - Main-repo guard refuses to operate on the main repo
 *   - Project-name sanitization matches Docker Compose v2 rules
 *
 * Tests use a fake `docker` shim on PATH that records invocations.
 * No real Docker daemon is needed; no git-crypt encryption is used.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const SCRIPT_PATH = join(__dirname, '..', 'remove-worktree.sh')

/** Shared env for git commands — main as default branch, no global config bleed */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function makeTempDir(prefix: string): string {
  const base = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  return mkdtempSync(base)
}

function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

function sh(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', env: GIT_ENV, ...opts }).trim()
}

/**
 * Write a docker shim to `binDir/docker`. Records invocations to `logPath`.
 * Optional `exitCodesPath` — newline-delimited exit codes consumed in order;
 * defaults to 0 when exhausted/unset.
 */
function writeDockerShim(binDir: string, logPath: string, exitCodesPath?: string): void {
  const shim = `#!/bin/sh
echo "$@" >> "${logPath}"
${
  exitCodesPath
    ? `if [ -f "${exitCodesPath}" ] && [ -s "${exitCodesPath}" ]; then
  code="$(head -n 1 "${exitCodesPath}")"
  tail -n +2 "${exitCodesPath}" > "${exitCodesPath}.tmp" && mv "${exitCodesPath}.tmp" "${exitCodesPath}"
  exit "$\{code:-0}"
fi
`
    : ''
}exit 0
`
  const shimPath = join(binDir, 'docker')
  writeFileSync(shimPath, shim)
  chmodSync(shimPath, 0o755)
}

/**
 * Run remove-worktree.sh with a fake docker on PATH; return logged invocations + script result.
 * cwd defaults to the binDir's parent (the test's tempRoot) so git/auto-discovery doesn't
 * pick up the host's vitest cwd repo.
 */
function runScriptWithDockerShim(
  args: string,
  binDir: string,
  logPath: string,
  cwd?: string
): { status: number; stdout: string; stderr: string; dockerCalls: string[] } {
  const env = {
    ...GIT_ENV,
    PATH: `${binDir}:${GIT_ENV.PATH ?? ''}`,
  }
  let result: { status: number; stdout: string; stderr: string }
  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" ${args}`, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
      cwd,
    })
    result = { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    result = { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }

  const dockerCalls = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : []

  return { ...result, dockerCalls }
}

/**
 * Set up a throwaway repo + worktree at the given dir name. Returns paths.
 * Optionally drops a docker-compose.override.yml in the worktree to trigger Path A.
 */
function setupRepoWithWorktree(
  tempRoot: string,
  worktreeDirName: string,
  withComposeOverride = true
): { repoDir: string; worktreeDir: string } {
  const repoDir = join(tempRoot, 'repo')
  const worktreeDir = join(tempRoot, worktreeDirName)

  git(tempRoot, `init "${repoDir}"`)
  sh(`touch "${join(repoDir, 'README.md')}"`)
  git(repoDir, 'add README.md')
  git(repoDir, 'commit -m "initial"')

  git(repoDir, `worktree add -b feat "${worktreeDir}"`)

  if (withComposeOverride) {
    writeFileSync(join(worktreeDir, 'docker-compose.override.yml'), 'services: {}\n')
  }

  return { repoDir, worktreeDir }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-4653: remove-worktree.sh per-worktree Docker cleanup', () => {
  it('runs `docker compose down --volumes --rmi local` then name-based fallback', () => {
    const tempRoot = makeTempDir('rmwt-default')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-feature')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Path A: cleanup-side compose down has --volumes --rmi local AND no --profile filter
    // (so dev/test/orchestrator services all tear down). The pre-existing stop_worktree_containers
    // does emit `compose --profile dev down` separately — we assert on the exact cleanup string.
    expect(result.dockerCalls).toContain('compose down --volumes --rmi local')
    // Path B: fallback rmi + volume rm
    expect(result.dockerCalls).toContain('rmi wt-feature-dev')
    expect(result.dockerCalls).toContain('volume rm wt-feature_node_modules')
  })

  it('--keep-docker skips compose down AND fallback rmi/volume rm', () => {
    const tempRoot = makeTempDir('rmwt-keep')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-keep')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(
      `"${worktreeDir}" --force --keep-docker`,
      binDir,
      logPath,
      repoDir
    )

    expect(result.status).toBe(0)
    // No cleanup-related docker calls. The pre-existing stop_worktree_containers
    // path may emit `compose --profile dev down` (without --rmi/--volumes), which
    // is the existing behavior we are preserving — that one is allowed.
    expect(result.dockerCalls.some((c) => c.includes('--rmi'))).toBe(false)
    expect(result.dockerCalls.some((c) => c === 'volume rm wt-keep_node_modules')).toBe(false)
    expect(result.dockerCalls.some((c) => c === 'rmi wt-keep-dev')).toBe(false)
  })

  it('compose down failing does not block the name-based fallback', () => {
    const tempRoot = makeTempDir('rmwt-compose-fail')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-fail')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    const exitCodesPath = join(tempRoot, 'exit-codes')
    // First docker call (stop_worktree_containers `compose --profile dev down`) → 0
    // Second docker call (Path A `compose down --volumes --rmi local`) → 1 (fail)
    // Subsequent calls → 0 (rmi, volume rm fall through)
    writeFileSync(exitCodesPath, '0\n1\n0\n0\n')
    writeDockerShim(binDir, logPath, exitCodesPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('rmi wt-fail-dev')
    expect(result.dockerCalls).toContain('volume rm wt-fail_node_modules')
  })

  it('rmi failing does not block the volume rm step', () => {
    const tempRoot = makeTempDir('rmwt-rmi-fail')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-rmifail')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    const exitCodesPath = join(tempRoot, 'exit-codes')
    // 0 (stop), 0 (compose down), 1 (rmi fails), 0 (volume rm)
    writeFileSync(exitCodesPath, '0\n0\n1\n0\n')
    writeDockerShim(binDir, logPath, exitCodesPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('rmi wt-rmifail-dev')
    expect(result.dockerCalls).toContain('volume rm wt-rmifail_node_modules')
  })

  it('refuses to clean Docker resources for the main repo', () => {
    const tempRoot = makeTempDir('rmwt-main-guard')
    tempDirs.push(tempRoot)
    const { repoDir } = setupRepoWithWorktree(tempRoot, 'wt-main')
    // create-worktree-style override at the main repo too — script needs to
    // refuse before touching it.
    writeFileSync(join(repoDir, 'docker-compose.override.yml'), 'services: {}\n')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${repoDir}"`, binDir, logPath, repoDir)

    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/Refusing to remove the main repo as a worktree/)
    // No docker side-effects of any kind should have run — guard fires before
    // stop_worktree_containers, the symlink rm, or the cleanup function.
    expect(result.dockerCalls.length).toBe(0)
  })

  it('sanitizes uppercase/special-char dir names to match Docker Compose project name', () => {
    const tempRoot = makeTempDir('rmwt-sanitize')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'SMI-4700_Test')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Sanitization: SMI-4700_Test → smi-4700_test
    expect(result.dockerCalls).toContain('rmi smi-4700_test-dev')
    expect(result.dockerCalls).toContain('volume rm smi-4700_test_node_modules')
  })

  it('idempotent re-run does not error after resources are gone', () => {
    const tempRoot = makeTempDir('rmwt-idempotent')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-idem')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    const exitCodesPath = join(tempRoot, 'exit-codes')
    // Cleanup ops (compose stop, compose down, rmi, volume rm) → 1 (resources already gone).
    // network ls (final check_docker_networks call) → 0 so the pipefail-protected pipeline
    // doesn't blow up. Script should still succeed end-to-end.
    writeFileSync(exitCodesPath, '1\n1\n1\n1\n0\n')
    writeDockerShim(binDir, logPath, exitCodesPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
  })
})
