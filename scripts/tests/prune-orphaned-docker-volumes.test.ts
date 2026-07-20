/**
 * Integration tests for prune-orphaned-docker-volumes.sh (SMI-5750)
 *
 * Plan: docs/internal/implementation/smi-5750-targeted-volume-prune.md
 * (Wave 1 > Step 3, test cases 1-15; tests 16-19 added post-implementation
 * adversarial review to cover the `*_native-seed-*` convention -- see the
 * Review Summary section of the plan doc).
 *
 * Verifies the targeted orphan-reclaim script's safety predicate
 * (worktree-existence via `git worktree list --porcelain`, unioned with a
 * `.worktrees/*` scan, NOT container-running-state) and the ownership gate
 * (generic Compose-label shape checks are never deletion authority by
 * themselves -- only `app.skillsmith.owned=true` authorizes an automatic
 * delete; everything else is report-only unless --include-unlabeled).
 *
 * Tests use a fake `docker` shim on PATH, following the
 * `remove-worktree.test.ts` convention (docker shim records invocations;
 * `dockerCalls` assertions are positional/exact-string). ONE extension is
 * needed here that the shared `writeDockerShim` helper (remove-worktree.
 * test.ts) does not support: canned STDOUT keyed by subcommand -- `docker
 * volume ls` needs to return specific volume names, `docker volume inspect
 * <name>` needs to return specific label values per label queried, `docker
 * ps -aq --filter ...` needs to return empty or a fake container id, etc.
 * That variant (`writeResponsiveDockerShim`) plus all fixture-building
 * helpers live in the sibling `prune-orphaned-docker-volumes.helpers.ts`
 * (split out per CLAUDE.md's 500-line file-length guidance) -- the shared
 * shim in remove-worktree.test.ts is untouched.
 *
 * Because prune-orphaned-docker-volumes.sh derives its own operating scope
 * from `${BASH_SOURCE[0]}` (there is no `<worktree-path>` argument the way
 * remove-worktree.sh takes one), each fixture copies the REAL script +
 * `_lib.sh` into a throwaway git repo's own `scripts/` directory and invokes
 * that copy -- so `SCRIPT_DIR`/`repo_root` resolve inside the fixture, and
 * `git worktree list --porcelain` reflects the fixture's own worktrees, not
 * this checkout's.
 *
 * No real Docker daemon is needed; no git-crypt encryption is used.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

import {
  setupFixture,
  addWorktree,
  volumeListResponse,
  imagesResponse,
  volumeLabels,
  imageLabels,
  volumePsResponse,
  setVolumeRmExit,
  resetLog,
  runPrune,
} from './prune-orphaned-docker-volumes.helpers.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-5750: prune-orphaned-docker-volumes.sh', () => {
  it('1. deletes a labeled orphan volume (no matching worktree, app.skillsmith.owned=true)', () => {
    const fixture = setupFixture('prune-orphan')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('volume rm gone-wt_node_modules')
  })

  it('2. preserves a live worktree volume even with a stopped container (the safety property)', () => {
    const fixture = setupFixture('prune-live')
    tempDirs.push(fixture.tempRoot)
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'live-wt'), 'feat-live')

    volumeListResponse(fixture, ['live-wt_node_modules'])
    // Deliberately NOT wiring any inspect/ps response for this volume: the
    // safety property under test is that worktree-existence alone protects
    // it BEFORE any container-state check ever runs -- so no `docker
    // volume inspect` or `docker ps --filter volume=...` call referencing it
    // should be made at all, regardless of whether its container is
    // stopped, running, or was never started.

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('live-wt_node_modules'))).toBe(false)
  })

  it('3. never touches the main-checkout volume', () => {
    const fixture = setupFixture('prune-main')
    tempDirs.push(fixture.tempRoot)
    // repoDir is named "repo" -> sanitize("repo") === "repo", and the main
    // checkout is always the first `git worktree list --porcelain` entry.

    volumeListResponse(fixture, ['repo_node_modules'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('repo_node_modules'))).toBe(false)
  })

  it('4. protects an out-of-tree worktree volume (blocker-1 regression)', () => {
    const fixture = setupFixture('prune-outside')
    tempDirs.push(fixture.tempRoot)
    // NOT under repo/.worktrees/ -- a sibling directory, exactly like the
    // create-worktree.sh usage examples (../worktrees/bugfix, absolute
    // paths) that a directory-only scan would miss.
    addWorktree(fixture.repoDir, join(fixture.tempRoot, 'outside-wt'), 'feat-outside')

    volumeListResponse(fixture, ['outside-wt_node_modules'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('outside-wt_node_modules'))).toBe(false)
  })

  it('5. leaves a non-convention volume (no _node_modules suffix) untouched', () => {
    const fixture = setupFixture('prune-nonconv')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['somedata'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('somedata'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('volume rm'))).toBe(false)
  })

  it('6. sanitizes a worktree dir name to protect the matching volume (SMI-4700_Test -> smi-4700_test)', () => {
    const fixture = setupFixture('prune-sanitize')
    tempDirs.push(fixture.tempRoot)
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'SMI-4700_Test'), 'feat-4700')

    volumeListResponse(fixture, ['smi-4700_test_node_modules'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('smi-4700_test_node_modules'))).toBe(false)
  })

  it('7. sanitization collision over-protects conservatively, never false-orphans', () => {
    const fixture = setupFixture('prune-collision')
    tempDirs.push(fixture.tempRoot)
    // "Foo.Bar" and "Foo,Bar" are distinct directory names (no macOS
    // case-insensitive-filesystem collision the literal plan example
    // "Foo-Bar"/"foo-bar" would hit) that BOTH sanitize -- lowercase, then
    // strip anything outside [a-z0-9_-] -- to the identical "foobar".
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'Foo.Bar'), 'feat-foobar-1')
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'Foo,Bar'), 'feat-foobar-2')

    volumeListResponse(fixture, ['foobar_node_modules'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    // Both distinct names land in the protected set -- collisions can only
    // OVER-protect, never false-orphan.
    expect(result.dockerCalls.some((c) => c.includes('foobar_node_modules'))).toBe(false)
  })

  it('8. skips a volume still referenced by any container (running or stopped)', () => {
    const fixture = setupFixture('prune-container-ref')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['other-wt_node_modules'])
    volumeLabels(fixture, 'other-wt_node_modules', {
      volume: 'node_modules',
      project: 'other-wt',
    })
    volumePsResponse(fixture, 'other-wt_node_modules', 'abc123def456')

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c === 'volume rm other-wt_node_modules')).toBe(false)
  })

  it('9. skips a volume with a mismatched com.docker.compose.volume label', () => {
    const fixture = setupFixture('prune-vol-label-mismatch')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['other-repo_node_modules'])
    volumeLabels(fixture, 'other-repo_node_modules', {
      volume: 'some_other_volume_key',
      project: 'other-repo',
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c === 'volume rm other-repo_node_modules')).toBe(false)
  })

  it('10. skips a volume with a mismatched com.docker.compose.project label (distinct guard from #9)', () => {
    const fixture = setupFixture('prune-project-label-mismatch')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['other-repo_node_modules'])
    volumeLabels(fixture, 'other-repo_node_modules', {
      volume: 'node_modules', // correct shape -- passes check #9's guard
      project: 'wrong-project', // inconsistent with derived project "other-repo"
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c === 'volume rm other-repo_node_modules')).toBe(false)
  })

  it('11. reports an unlabeled orphan as UNCONFIRMED; --include-unlabeled deletes it on re-run', () => {
    const fixture = setupFixture('prune-unlabeled')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      // no `owned` label -- passes all generic Compose-shape checks but has
      // no positive Skillsmith ownership signal.
    })

    const first = runPrune(fixture)

    expect(first.status).toBe(0)
    expect(first.stdout).toContain('UNCONFIRMED ownership: gone-wt_node_modules')
    expect(first.dockerCalls.some((c) => c === 'volume rm gone-wt_node_modules')).toBe(false)

    // Same fixture (same responses), re-run with the explicit escape hatch.
    resetLog(fixture)
    const second = runPrune(fixture, ['--include-unlabeled'])

    expect(second.status).toBe(0)
    expect(second.dockerCalls).toContain('volume rm gone-wt_node_modules')
  })

  it('12. removes an orphaned image and preserves a live one', () => {
    const fixture = setupFixture('prune-image')
    tempDirs.push(fixture.tempRoot)
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'live-wt'), 'feat-live-img')

    // repo-dev (main checkout) and live-wt-dev (registered worktree) are
    // both protected; gone-wt-dev has no matching worktree.
    imagesResponse(fixture, ['gone-wt-dev', 'live-wt-dev', 'repo-dev'])
    imageLabels(fixture, 'gone-wt-dev', { service: 'dev', owned: 'true' })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('rmi gone-wt-dev')
    expect(result.dockerCalls.some((c) => c.includes('live-wt-dev'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.includes('repo-dev'))).toBe(false)
  })

  it('13. --dry-run deletes nothing but reports would-delete names (auto and UNCONFIRMED)', () => {
    const fixture = setupFixture('prune-dry-run')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules', 'unlabeled-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })
    volumeLabels(fixture, 'unlabeled-wt_node_modules', {
      volume: 'node_modules',
      project: 'unlabeled-wt',
      // no owned label -> UNCONFIRMED
    })

    const result = runPrune(fixture, ['--dry-run'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.startsWith('volume rm'))).toBe(false)
    expect(result.stdout).toContain('[dry-run] would remove volume gone-wt_node_modules')
    expect(result.stdout).toContain('UNCONFIRMED ownership: unlabeled-wt_node_modules')
    // UNCONFIRMED candidates never reach the auto-deletable dry-run list
    // without --include-unlabeled.
    expect(result.stdout).not.toContain('[dry-run] would remove volume unlabeled-wt_node_modules')
  })

  it('14. SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 skips entirely with zero docker calls', () => {
    const fixture = setupFixture('prune-disabled')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })

    const result = runPrune(fixture, [], { SKILLSMITH_ORPHAN_PRUNE_DISABLE: '1' })

    expect(result.status).toBe(0)
    expect(result.dockerCalls.length).toBe(0)
  })

  it('15. tolerates a volume rm failure and still exits 0 with a warning', () => {
    const fixture = setupFixture('prune-rm-fail')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })
    setVolumeRmExit(fixture, 'gone-wt_node_modules', 1)

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('volume rm gone-wt_node_modules')
    expect(result.stderr).toContain('Could not remove volume gone-wt_node_modules')
  })

  // Tests 16-19: the `<project>_native-seed-<module>` convention (_lib.sh's
  // enumerate_native_module_volumes, SMI-5650) -- added after the initial
  // implementation's adversarial review found this convention was
  // numerically the DOMINANT orphan class on the real machine (5 volumes per
  // worktree vs. 1 node_modules volume) and completely invisible to the
  // original `*_node_modules`-only scope. Mirrors tests 1/2/9/11 for the
  // parallel convention.

  it('16. deletes a labeled orphan native-seed volume (no matching worktree)', () => {
    const fixture = setupFixture('prune-native-orphan')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_native-seed-better-sqlite3'])
    volumeLabels(fixture, 'gone-wt_native-seed-better-sqlite3', {
      volume: 'native-seed-better-sqlite3',
      project: 'gone-wt',
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('volume rm gone-wt_native-seed-better-sqlite3')
  })

  it('17. preserves a live worktree native-seed volume even with a stopped container', () => {
    const fixture = setupFixture('prune-native-live')
    tempDirs.push(fixture.tempRoot)
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'live-wt'), 'feat-live')

    volumeListResponse(fixture, ['live-wt_native-seed-onnxruntime-node'])
    // Deliberately no inspect/ps response wired -- same safety property as
    // test #2: worktree-existence alone protects it before any container- or
    // label-state check runs.

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('live-wt_native-seed-onnxruntime-node'))).toBe(
      false
    )
  })

  it('18. skips a native-seed volume with a mismatched compose.volume label (per-module, not just "node_modules")', () => {
    const fixture = setupFixture('prune-native-mismatch')
    tempDirs.push(fixture.tempRoot)

    // Labeled as the WRONG module's native-seed key -- the shape check must
    // compare against the volume's OWN expected key (native-seed-esbuild),
    // not merely "starts with native-seed-".
    volumeListResponse(fixture, ['gone-wt_native-seed-esbuild'])
    volumeLabels(fixture, 'gone-wt_native-seed-esbuild', {
      volume: 'native-seed-hnswlib-node',
      project: 'gone-wt',
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.startsWith('volume rm'))).toBe(false)
  })

  it('19. reports an unlabeled native-seed orphan as UNCONFIRMED; --include-unlabeled deletes it', () => {
    const fixture = setupFixture('prune-native-unlabeled')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_native-seed-esbuild-scope'])
    volumeLabels(fixture, 'gone-wt_native-seed-esbuild-scope', {
      volume: 'native-seed-esbuild-scope',
      project: 'gone-wt',
      // no `owned` label -- matches the real pre-label backlog on this
      // machine (enumerate_native_module_volumes only started emitting the
      // label as of this same change).
    })

    const first = runPrune(fixture)

    expect(first.status).toBe(0)
    expect(first.stdout).toContain('UNCONFIRMED ownership: gone-wt_native-seed-esbuild-scope')
    expect(first.dockerCalls.some((c) => c === 'volume rm gone-wt_native-seed-esbuild-scope')).toBe(
      false
    )

    resetLog(fixture)
    const second = runPrune(fixture, ['--include-unlabeled'])

    expect(second.status).toBe(0)
    expect(second.dockerCalls).toContain('volume rm gone-wt_native-seed-esbuild-scope')
  })
})
