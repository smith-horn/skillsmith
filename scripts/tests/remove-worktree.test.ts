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
 * SMI-6401: `dev`/`test` are Compose-profile-gated, so `down`/`config`
 * silently no-op without an explicit `--profile`. `cleanup_worktree_docker_resources()`
 * now discovers the repo's declared profiles (`docker compose config --profiles`)
 * and applies them to both the `down` call AND a `docker compose config --format
 * json`-derived enumeration of every declared named volume (replacing a
 * fallback that only ever guessed `_node_modules`). This inserts TWO new
 * docker invocations ahead of the pre-existing `rmi`/`volume rm` calls in the
 * scripted-exit-code tests below — see the per-test comments for the updated
 * call-index accounting.
 *
 * Tests use a fake `docker` shim on PATH that records invocations.
 * No real Docker daemon is needed; no git-crypt encryption is used.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'fs'
import { join } from 'path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const SCRIPT_PATH = join(__dirname, '..', 'remove-worktree.sh')

/**
 * SMI-4693: GIT_DISCOVERY_VARS-stripped env for every git invocation AND
 * the remove-worktree.sh subprocess. Same pattern as rebase-worktree.test.ts.
 */
const GIT_ENV = makeFixtureEnv()

function makeTempDir(prefix: string): string {
  return makeFixtureTempDir(prefix)
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
 * SMI-6401: docker shim variant that also fakes `compose config --profiles`
 * and `compose ... config --format json` output, so the profile-discovery
 * and Compose-config-derived volume-list logic in
 * cleanup_worktree_docker_resources() can be exercised end-to-end without a
 * real Docker daemon. Every other command (stop, down, rmi, volume rm, ...)
 * always exits 0 -- this variant proves the derivation itself works; it is
 * not used for the failure-interplay tests above (those use the plain
 * `writeDockerShim` + exit-codes queue, where an empty discovery result is
 * exactly what exercises the pre-fix-equivalent fallback path).
 */
function writeSmartDockerShim(binDir: string, logPath: string): void {
  const shim = `#!/bin/sh
echo "$@" >> "${logPath}"
case "$*" in
  *"config --profiles")
    printf '%s\\n' dev test
    exit 0
    ;;
  *"config --format json")
    cat <<'JSON'
{"volumes":{"node_modules":{},"website-vercel-output":{},"an-external-vol":{"external":true}}}
JSON
    exit 0
    ;;
esac
exit 0
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
    // Path A: with the plain (dumb, empty-output) shim, `compose config
    // --profiles` (SMI-6401 discovery) returns nothing, so no --profile
    // flags get appended -- the down call is byte-identical to the
    // pre-SMI-6401 invocation. The pre-existing stop_worktree_containers
    // does emit `compose --profile dev down` separately — we assert on the
    // exact cleanup string.
    expect(result.dockerCalls).toContain('compose down --volumes --rmi local')
    // Path B: fallback rmi + volume rm (SMI-6401: `compose config --format
    // json` also returns nothing from the dumb shim, so declared_volume_keys
    // falls back to the single historical "node_modules" name).
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
    // SMI-6401: 6 real calls now precede the network-ls/system-df/orphan-prune
    // tail (profile discovery + config-json derivation inserted between the
    // stop call and Path B, both `|| true`-tolerant no-ops with the dumb shim):
    //   [0] stop_worktree_containers `compose --profile dev down`      → 0
    //   [1] Path A profile discovery `compose config --profiles`       → 0
    //   [2] Path A `compose down --volumes --rmi local`                → 1 (the simulated failure)
    //   [3] Path B `compose config --format json` (volume derivation)  → 0
    //   [4] Path B `rmi`                                               → 0
    //   [5] Path B `volume rm`                                         → 0
    writeFileSync(exitCodesPath, '0\n0\n1\n0\n0\n0\n')
    writeDockerShim(binDir, logPath, exitCodesPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Pin exactly which call received the simulated failure, so a future
    // insertion ahead of Path A's `down` can't silently mistarget it onto a
    // `|| true`-tolerant discovery call instead (plan-review SMI-6401 finding).
    expect(result.dockerCalls[2]).toBe('compose down --volumes --rmi local')
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
    // SMI-6401: [0] stop=0, [1] profile discovery=0, [2] compose down=0,
    // [3] config-json derivation=0, [4] rmi=1 (the simulated failure), [5] volume rm=0
    writeFileSync(exitCodesPath, '0\n0\n0\n0\n1\n0\n')
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
    // SMI-6401: cleanup now spans 6 real calls (stop, profile discovery,
    // compose down, config-json derivation, rmi, volume rm), all → 1
    // (resources already gone / discovery unavailable -- every one of these
    // is `|| true`-tolerant). network ls (7th call, check_docker_networks) →
    // 0 so the pipefail-protected pipeline doesn't blow up. The SMI-5145
    // `docker system df` (check_docker_reclaimable) and the SMI-5750
    // orphan-prune's own docker calls all fall after the queue is exhausted
    // and default to 0 — `docker system df`'s bare invocation is
    // `|| warn`-guarded so a non-zero would not abort regardless. Script
    // should still succeed end-to-end.
    writeFileSync(exitCodesPath, '1\n1\n1\n1\n1\n1\n0\n')
    writeDockerShim(binDir, logPath, exitCodesPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
  })
})

describe('SMI-6401: profile-aware Path A + Compose-config-derived Path B volume list', () => {
  it('discovers profiles, passes them to `down`, and removes every non-external declared volume', () => {
    const tempRoot = makeTempDir('rmwt-6401-derive')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-derive')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeSmartDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Path A: the discovered profiles ("dev", "test") are applied to `down`.
    expect(result.dockerCalls).toContain(
      'compose --profile dev --profile test down --volumes --rmi local'
    )
    // Path A also applies the same profiles to the `config --format json`
    // derivation call.
    expect(result.dockerCalls).toContain(
      'compose --profile dev --profile test config --format json'
    )
    // Path B: BOTH non-external declared volumes are attempted, not just
    // the single historical "node_modules" name.
    expect(result.dockerCalls).toContain('volume rm wt-derive_node_modules')
    expect(result.dockerCalls).toContain('volume rm wt-derive_website-vercel-output')
    // The volume marked `external: true` in the canned config is never
    // touched -- an externally-managed volume must not be deleted by this
    // script.
    expect(result.dockerCalls.some((c) => c.includes('an-external-vol'))).toBe(false)
  })

  it('does not crash when no docker-compose.override.yml exists (plan-review Critical regression check)', () => {
    // SMI-6401 plan-review Critical finding: compose_profile_args/
    // declared_volume_keys must be declared OUTSIDE the
    // `if [[ -f docker-compose.override.yml ]]` block, or this exact
    // no-override-file path (Path A skipped entirely) crashes with
    // "unbound variable" under `set -euo pipefail` before `git worktree
    // remove` ever runs. This worktree has no override file, so Path A
    // never executes -- only the node_modules-only Path B fallback should
    // run, and the script must still exit 0.
    const tempRoot = makeTempDir('rmwt-6401-no-override')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-noover', false)
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Path A's `compose down`/`config` calls never fire without an override
    // file present.
    expect(result.dockerCalls.some((c) => c.startsWith('compose down'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('compose config'))).toBe(false)
    // Path B still runs its single-name fallback.
    expect(result.dockerCalls).toContain('rmi wt-noover-dev')
    expect(result.dockerCalls).toContain('volume rm wt-noover_node_modules')
  })
})

describe('SMI-5145: reclaimable Docker report + safe --prune', () => {
  it('reports reclaimable resources (docker system df) on a default run, without pruning', () => {
    const tempRoot = makeTempDir('rmwt-reclaim-check')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-reclaim')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Step 3 reclaimable report runs `docker system df` unconditionally.
    expect(result.dockerCalls).toContain('system df')
    // Without --prune, no safe prune of images / build cache / networks runs.
    expect(result.dockerCalls.some((c) => c.startsWith('image prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('builder prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('network prune'))).toBe(false)
  })

  it('--prune runs network + dangling-image + build-cache prune (safe categories only)', () => {
    const tempRoot = makeTempDir('rmwt-prune-safe')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-prunesafe')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(
      `"${worktreeDir}" --force --prune`,
      binDir,
      logPath,
      repoDir
    )

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('network prune -f')
    expect(result.dockerCalls).toContain('image prune -f')
    expect(result.dockerCalls).toContain('builder prune -f')
    // Still reports reclaimable.
    expect(result.dockerCalls).toContain('system df')
    // SAFETY GUARD (non-optional): aggressive reclaim is NEVER auto-run — it can
    // force native-module rebuilds in other active worktrees, so it stays manual.
    expect(result.dockerCalls.some((c) => c.includes('volume prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.includes('image prune -a'))).toBe(false)
  })

  it('never auto-runs aggressive reclaim on a default (no --prune) run either', () => {
    const tempRoot = makeTempDir('rmwt-no-aggressive')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-noaggr')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('volume prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.includes('image prune -a'))).toBe(false)
  })
})

describe('SMI-5750: remove-worktree.sh targeted orphan-prune wiring (Step 3.5)', () => {
  it('a default --force run invokes the targeted orphan prune (docker volume ls)', () => {
    const tempRoot = makeTempDir('rmwt-orphan-prune')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-orphanprune')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(`"${worktreeDir}" --force`, binDir, logPath, repoDir)

    expect(result.status).toBe(0)
    // Step 3.5 shells out to prune-orphaned-docker-volumes.sh, which sources
    // the same docker shim on PATH -- its `docker volume ls --format
    // '{{.Name}}'` call (scripts/prune-orphaned-docker-volumes.sh:174) shows
    // up positionally-appended in the same recorded dockerCalls array.
    expect(result.dockerCalls).toContain('volume ls --format {{.Name}}')
  })

  it('--no-orphan-prune suppresses the targeted orphan prune (no volume ls call)', () => {
    const tempRoot = makeTempDir('rmwt-no-orphan-prune')
    tempDirs.push(tempRoot)
    const { repoDir, worktreeDir } = setupRepoWithWorktree(tempRoot, 'wt-noorphanprune')
    const binDir = join(tempRoot, 'bin')
    sh(`mkdir -p "${binDir}"`)
    const logPath = join(tempRoot, 'docker.log')
    writeDockerShim(binDir, logPath)

    const result = runScriptWithDockerShim(
      `"${worktreeDir}" --force --no-orphan-prune`,
      binDir,
      logPath,
      repoDir
    )

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('volume ls'))).toBe(false)
  })
})
