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
 * delete; everything else is report-only unconditionally -- no flag waives it,
 * as of SMI-6981).
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
  volumeLabelSequence,
  breakGitWorktreeList,
  imageLabels,
  volumePsResponse,
  setVolumeRmExit,
  resetLog,
  runPrune,
  containerResponses,
} from './prune-orphaned-docker-volumes.helpers.js'

const tempDirs: string[] = []

/**
 * Does this docker-shim call line delete a volume (the named one, if given)?
 *
 * Matches the verb SET rather than one spelling. `docker volume rm` and
 * `docker volume remove` are both real -- measured against the live CLI -- and
 * a prefix match on 'volume rm' misses the alias: "volume remove X"
 * .startsWith("volume rm") is false. Trailing flags (`volume rm -f X`) also
 * survive this predicate, where an exact-element compare would not.
 *
 * Every absence assertion in this file routes through here, so a third alias
 * only has to be added once.
 */
const deletesVolume = (c: string, name?: string): boolean =>
  /(^|\s)volume (rm|remove)\b/.test(c) && (name === undefined || c.includes(name))

/**
 * Does this call destroy resources in BULK, without naming them?
 *
 * The alias axis above is not the only way a deletion hides from an absence
 * assertion keyed to a name. This script exists precisely BECAUSE a blanket
 * `docker volume prune` / `docker system prune` was too dangerous to use, so
 * a regression toward one is the attested direction -- and a prune names no
 * volume, emits no `Removed volume <name>` line, and matched neither predicate.
 * Measured false for all of: volume prune, system prune --volumes, image
 * prune, `rm -v`, `container rm -v`, `compose down -v`.
 *
 * Deliberately name-independent: a bulk delete that cannot be attributed to a
 * name is never acceptable here, whatever it would have swept.
 */
const destroysInBulk = (c: string): boolean =>
  /(^|\s)(volume|image|container|system|network|builder)?\s*prune(\s|$)/.test(c) ||
  /(^|\s)(rm|down)\b[^\n]*(\s-{1,2}v\b|\s--volumes\b)/.test(c)

/** Image counterpart: `docker rmi`, `docker image rm`, `docker image remove`. */
const deletesImage = (c: string, name?: string): boolean =>
  /(^|\s)(rmi|image (rm|remove))\b/.test(c) && (name === undefined || c.includes(name))

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

// The three predicates above decide every absence assertion in this file, so a
// hole in one silently weakens all of them. These tables are committed rather
// than run ad hoc: a count asserted in a commit message that nobody can re-run
// is not evidence, and the `prune(\s|$)` anchoring below exists because an
// earlier `prune\b` draft matched an image named `prune-test` -- caught by
// running the table, not by reading the regex.
describe('SMI-6981: the docker-call predicates these tests depend on', () => {
  it.each([
    ['volume rm X', true],
    ['volume remove X', true],
    ['volume rm -f X', true],
    ['volume inspect X --format abc', false],
    ['volume ls', false],
    ['ps -aq --filter volume=X', false],
    ['rmi X', false],
  ])('deletesVolume(%j) === %s', (call, want) => {
    expect(deletesVolume(call as string)).toBe(want)
  })

  it.each([
    ['rmi X', true],
    ['image rm X', true],
    ['image remove X', true],
    ['image inspect X --format abc', false],
    ['images', false],
    ['volume rm X', false],
  ])('deletesImage(%j) === %s', (call, want) => {
    expect(deletesImage(call as string)).toBe(want)
  })

  it.each([
    ['volume prune -f', true],
    ['volume prune --filter label=x', true],
    ['system prune -a -f --volumes', true],
    ['image prune -a -f', true],
    ['builder prune', true],
    ['prune', true],
    ['rm -v abc', true],
    ['container rm -v abc', true],
    ['compose down -v', true],
    ['compose down --volumes', true],
    // Negative cases, and the one that matters most: an image whose NAME
    // contains `prune`. `\b` after `prune` is satisfied by a hyphen, so a
    // `prune\b` predicate matched this read-only inspect.
    ['image inspect prune-test --format abc', false],
    ['volume rm X', false],
    ['rmi X', false],
    ['volume ls', false],
    ['volume inspect X --format abc', false],
    ['ps -aq --filter volume=X', false],
    ['info', false],
  ])('destroysInBulk(%j) === %s', (call, want) => {
    expect(destroysInBulk(call as string)).toBe(want)
  })
})

describe('SMI-5750: prune-orphaned-docker-volumes.sh', () => {
  it('reports live-old, orphaned, and excessive containers without mutation', () => {
    const fixture = setupFixture('container-report')
    tempDirs.push(fixture.tempRoot)
    const livePath = join(fixture.repoDir, '.worktrees', 'live-wt')
    addWorktree(fixture.repoDir, livePath, 'feat-report-live')
    containerResponses(fixture, [
      {
        id: 'live1',
        name: 'live-wt-dev-1',
        created: '2000-01-01T00:00:00Z',
        path: livePath,
      },
      {
        id: 'gone1',
        name: 'gone-wt-dev-1',
        created: '2000-01-01T00:00:00Z',
        path: join(fixture.tempRoot, 'gone-wt'),
      },
      { id: 'bad1', name: '', created: '', path: 'not-absolute' },
    ])

    const result = runPrune(fixture, ['--report-containers'], {
      SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS: '1',
      SKILLSMITH_CONTAINER_SPRAWL_MAX_COUNT: '1',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('live-wt-dev-1\tlive-old')
    expect(result.stdout).toContain('gone-wt-dev-1\torphaned')
    expect(result.stdout).toContain('all-live\texcessive\t2/1')
    expect(result.dockerCalls.some((call) => /\b(rm|rmi|stop|kill)\b/.test(call))).toBe(false)
  })

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
    // The ownership label is inspected exactly TWICE on a successful delete --
    // once building the candidate, once immediately before `volume rm`. Tests
    // 11 and 19 cannot observe the second read at all: they short-circuit at
    // candidate construction, so the re-check never runs there.
    const ownedProbe =
      'volume inspect gone-wt_node_modules --format {{index .Labels "app.skillsmith.owned"}}'
    expect(result.dockerCalls.filter((c) => c === ownedProbe)).toHaveLength(2)
    // The count alone pins MULTIPLICITY, not POSITION -- it survives moving
    // the second read into candidate construction, which deletes the TOCTOU
    // property while keeping the count at 2. So also require the re-read to be
    // the call immediately preceding the delete, which is where it has to be
    // to mean anything.
    const rmIdx = result.dockerCalls.findIndex((c) => deletesVolume(c, 'gone-wt_node_modules'))
    expect(rmIdx).toBeGreaterThan(0)
    expect(result.dockerCalls.lastIndexOf(ownedProbe)).toBe(rmIdx - 1)
  })

  it('1b. a label that vanishes BETWEEN the two reads blocks the delete (the TOCTOU property itself)', () => {
    const fixture = setupFixture('prune-orphan-toctou')
    tempDirs.push(fixture.tempRoot)

    // Position and count both survive a re-check whose `|| continue` is
    // changed to `|| true`: the call still happens, in the right place, and
    // with a static response both reads return the same value, so nothing can
    // tell a binding check from a decorative one. This is the only assertion
    // in the file that requires the re-read's RESULT to change the outcome.
    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
    })
    // Owned at construction, gone by the re-check -- a worktree reclaiming its
    // volume mid-run is the real-world shape.
    volumeLabelSequence(fixture, 'gone-wt_node_modules', 'owned', ['true'])

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    // Presence proof: the sequence must actually have been consumed twice, or
    // this test proves nothing about the re-check. Test 1 pins that a
    // successful delete reads it twice; here the second read returns empty.
    const ownedProbe =
      'volume inspect gone-wt_node_modules --format {{index .Labels "app.skillsmith.owned"}}'
    expect(result.dockerCalls.filter((c) => c === ownedProbe)).toHaveLength(2)
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'gone-wt_node_modules'))).toBe(false)
    expect(result.stdout).not.toContain('Removed volume gone-wt_node_modules')
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
  })

  it('1c. refuses outright when `git worktree list` fails but .worktrees/ still yields entries', () => {
    const fixture = setupFixture('prune-enum-failure')
    tempDirs.push(fixture.tempRoot)

    // derive_protected fails OPEN: `git worktree list`'s failure is swallowed,
    // so the only thing standing between this script and a deletion returns
    // whatever it managed to collect. The round-2 guard checked that result for
    // EMPTINESS -- which is the wrong sentinel, because the function has two
    // sources and the directory scan still contributes. The set comes back
    // non-empty and missing only the main checkout's own name, so an emptiness
    // check says "proceed".
    //
    // This is the production shape, not a corner: the real main checkout has a
    // dozen .worktrees/ entries, and its own name is absent from that scan
    // because the scan enumerates subdirectories.
    volumeListResponse(fixture, ['repo_node_modules'])
    volumeLabels(fixture, 'repo_node_modules', {
      volume: 'node_modules',
      project: 'repo',
      owned: 'true',
    })
    imagesResponse(fixture, ['repo-dev'])
    imageLabels(fixture, 'repo-dev', { service: 'dev', owned: 'true' })

    // `wt-a` keeps the set non-empty; the fixture repo is `repo`, so the main
    // checkout's own name is what goes missing.
    breakGitWorktreeList(fixture, ['wt-a'])

    const result = runPrune(fixture)

    // Fails closed. remove-worktree.sh wraps the call in `|| warn`, so a
    // refusal degrades to a warning there rather than aborting a removal.
    expect(result.status).toBe(1)
    // Which arm fires matters: the control name is now read from `git worktree
    // list`'s own first entry, so a failed enumeration is caught directly
    // rather than inferred from a missing name. The .worktrees/ scan cannot
    // supply the control name any more, which is the point.
    expect(result.stderr).toContain('produced no worktree entry for this checkout')
    // The assertions that matter: nothing was destroyed, by any spelling and in
    // any quantity. Under the emptiness-only guard this run deleted both.
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
    expect(result.stdout).not.toContain('Removed image')
  })

  it('1d. a .worktrees/ child named like the main checkout cannot satisfy the control (SMI-6981 round 4)', () => {
    const fixture = setupFixture('prune-self-name-collision')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['victim_node_modules'])
    volumeLabels(fixture, 'victim_node_modules', {
      volume: 'node_modules',
      project: 'victim',
      owned: 'true',
    })

    // The fixture repo is `repo`, so `.worktrees/repo/` is a child named like
    // its own grandparent. Measured against a control name derived from
    // $main_repo: the name appears in the set via the directory scan, the guard
    // passes with `git worktree list` broken, and victim_node_modules is
    // deleted -- the full fail-open restored. Deriving the control from the
    // canonical arm instead makes the scan unable to vouch for it.
    breakGitWorktreeList(fixture, ['repo'])

    const result = runPrune(fixture)

    expect(result.status).toBe(1)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
  })

  it('1e. a live worktree at a path containing whitespace stays protected (SMI-6981 round 4)', () => {
    const fixture = setupFixture('prune-whitespace-path')
    tempDirs.push(fixture.tempRoot)

    // `awk '/^worktree / { print $2 }'` reads the second WHITESPACE field, so
    // it truncated `/x/My Work/wt-a` to `/x/My` -- basename `my` -- and the
    // real worktree `wt-a` then looked unprotected. Measured end-to-end before
    // the fix: wt-a_node_modules was really deleted while `git worktree list`
    // succeeded and every guard passed, breaking the worktree-existence
    // invariant the script's own header calls what makes it safe at any
    // concurrency level.
    //
    // retrieval-autoheal.sh's comment already said to use sed for exactly this
    // reason, a test already pinned it there, and report_containers in this
    // same file already used the safe form. Three records, none applied here.
    const spacedPath = join(fixture.tempRoot, 'My Work', 'wt-a')
    addWorktree(fixture.repoDir, spacedPath, 'feat-spaced')

    volumeListResponse(fixture, ['wt-a_node_modules'])
    volumeLabels(fixture, 'wt-a_node_modules', {
      volume: 'node_modules',
      project: 'wt-a',
      owned: 'true',
    })

    const result = runPrune(fixture)

    expect(result.status).toBe(0)
    // The live worktree's volume must be untouched, and the run must not even
    // probe it -- worktree-existence screens before any label check.
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'wt-a_node_modules'))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume wt-a_node_modules')
    expect(result.stdout).not.toContain('would remove volume wt-a_node_modules')
  })

  it('1f. a MAIN CHECKOUT at a whitespace path still protects itself, and the run proceeds (SMI-6981 round 5)', () => {
    const fixture = setupFixture('prune-spaced-main', { spacedPath: true })
    tempDirs.push(fixture.tempRoot)

    // Test 1e pins only derive_protected's extraction. Measured matrix:
    //
    //   derive_protected | derive_self_project | 1e
    //   sed              | sed                 | green
    //   sed              | awk                 | GREEN -- revert invisible
    //   awk              | sed                 | red
    //   awk              | awk                 | red
    //
    // So reverting the control's own extraction was unpinned, and it is not
    // harmless: on a main checkout under a spaced path, (sed, awk) makes the
    // control `my` while the set holds `repo`, so EVERY healthy run refuses --
    // the pruner silently stops working for anyone whose checkout lives there.
    //
    // This fixture is the worse case in the other direction too. Pre-round-4
    // (awk, awk) derives the set `{my, …}` with control `my`, which IS in the
    // set, so all three arms agree and the MAIN CHECKOUT's own volume becomes
    // a candidate. One test pins both sites and that case.
    expect(fixture.repoDir).toContain(' ')

    volumeListResponse(fixture, ['repo_node_modules'])
    volumeLabels(fixture, 'repo_node_modules', {
      volume: 'node_modules',
      project: 'repo',
      owned: 'true',
    })

    const result = runPrune(fixture)

    // Proceeds: enumeration is healthy, so refusing would be the (sed, awk)
    // failure. The main checkout's own volume is protected by worktree
    // existence, so it is never even probed for labels.
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('refusing to prune')
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'repo_node_modules'))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume repo_node_modules')
    expect(result.stdout).not.toContain('would remove volume repo_node_modules')
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
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
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

  it('11. reports an unlabeled orphan as UNCONFIRMED, and --include-unlabeled still never deletes it (SMI-6981)', () => {
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
    // SMI-6981: this assertion used to require the volume be DELETED.
    // Owner decision 2026-10-07: close the data-loss hole, report-only.
    // The flag waived the `app.skillsmith.owned` check -- the only
    // non-circular ownership signal in the script -- and measurably
    // proposed `intd318_node_modules`, an unrelated project's data on
    // the same daemon. It is report-only now, so this inverts.
    // The first-run assertions above are unchanged: they never encoded
    // the defect, only this one did.
    //
    // Presence proof first, so the absence assertion cannot pass on a
    // run that crashed or never reached the volume (P-7).
    expect(second.stdout).toContain('UNCONFIRMED ownership: gone-wt_node_modules')
    // Matched by prefix, not exact element: `dockerCalls` entries are the
    // shim's `echo "$@"`, so an exact compare would pass vacuously if the
    // script ever grew a flag (`volume rm -f <vol>` !== `volume rm <vol>`).
    // Prefix-matched on `volume rm` ALONE would miss `docker volume remove`,
    // which is a real alias -- measured: "volume remove X".startsWith("volume rm")
    // is false. Match the verb set plus the name, and assert the behaviour too,
    // since the success line is independent of how the verb is spelled.
    expect(second.dockerCalls.some((c) => deletesVolume(c, 'gone-wt_node_modules'))).toBe(false)
    expect(second.stdout).not.toContain('Removed volume gone-wt_node_modules')
    expect(second.dockerCalls.some(destroysInBulk)).toBe(false)
    // The two assertions above go red only when BOTH guards are deleted --
    // reverting either alone still yields 0 deletions, because the other
    // closes the hole on its own. So they test the conjunction, not either
    // guard. This count pins the candidate-build guard specifically: it
    // short-circuits before the delete loop, so the ownership label is
    // inspected exactly ONCE. Revert it and the volume reaches the delete
    // loop, whose own re-check inspects the label a second time -- 2, not 1.
    const ownedProbe =
      'volume inspect gone-wt_node_modules --format {{index .Labels "app.skillsmith.owned"}}'
    expect(second.dockerCalls.filter((c) => c === ownedProbe)).toHaveLength(1)
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
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
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
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
  })

  it('19. reports an unlabeled native-seed orphan as UNCONFIRMED, and --include-unlabeled still never deletes it (SMI-6981)', () => {
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
    // SMI-6981: this assertion used to require the volume be DELETED.
    // Same reason as test 11; the backlog it describes is now SMI-7028.
    // The flag waived the `app.skillsmith.owned` check -- the only
    // non-circular ownership signal in the script -- and measurably
    // proposed `intd318_node_modules`, an unrelated project's data on
    // the same daemon. It is report-only now, so this inverts.
    // The first-run assertions above are unchanged: they never encoded
    // the defect, only this one did.
    //
    // Presence proof first, so the absence assertion cannot pass on a
    // run that crashed or never reached the volume (P-7).
    expect(second.stdout).toContain('UNCONFIRMED ownership: gone-wt_native-seed-esbuild-scope')
    // Prefix match, not exact element -- see the note in test 11.
    // Verb set, not a prefix -- see test 11's note on `docker volume remove`.
    expect(
      second.dockerCalls.some((c) => deletesVolume(c, 'gone-wt_native-seed-esbuild-scope'))
    ).toBe(false)
    expect(second.stdout).not.toContain('Removed volume gone-wt_native-seed-esbuild-scope')
    expect(second.dockerCalls.some(destroysInBulk)).toBe(false)
    // Pins the candidate-build guard on its own -- see test 11's note.
    const ownedProbe =
      'volume inspect gone-wt_native-seed-esbuild-scope --format {{index .Labels "app.skillsmith.owned"}}'
    expect(second.dockerCalls.filter((c) => c === ownedProbe)).toHaveLength(1)
  })

  it("20. never deletes a FOREIGN project's volume, in either mode -- the property that must survive SMI-7028", () => {
    const fixture = setupFixture('prune-foreign-project')
    tempDirs.push(fixture.tempRoot)

    // Tests 11 and 19 use a Skillsmith-SHAPED orphan name (`gone-wt`), so they
    // assert "an unlabelled volume is never deleted" -- and SMI-7028 exists to
    // make our OWN unlabelled volumes reclaimable. When it lands, both will go
    // red and read as a regression in this data-loss fix.
    //
    // The durable property is narrower and is what the defect actually was: a
    // FOREIGN project's volume is never deleted. This fixture plants one, with
    // the name and the project label AGREEING on a foreign project -- that
    // agreement is the whole mechanism, since the project-label check compares
    // the label against a string parsed from the volume's own name. A fixture
    // that mislabelled it would pass for the wrong reason.
    //
    // `intd318_node_modules` is the real volume the live reproduction proposed
    // deleting.
    volumeListResponse(fixture, ['intd318_node_modules'])
    volumeLabels(fixture, 'intd318_node_modules', {
      volume: 'node_modules',
      project: 'intd318',
      // no `owned` label -- a foreign Compose project has no reason to carry
      // ours, which is exactly why its absence cannot authorize a delete.
    })

    for (const args of [[], ['--include-unlabeled']]) {
      resetLog(fixture)
      const result = runPrune(fixture, args)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('UNCONFIRMED ownership: intd318_node_modules')
      expect(result.dockerCalls.some((c) => deletesVolume(c, 'intd318_node_modules'))).toBe(false)
      expect(result.stdout).not.toContain('Removed volume intd318_node_modules')
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)

      // The flag's ONE retained purpose is telling the operator it changed --
      // the script's own comment says it is kept rather than removed for
      // exactly that. Nothing asserted it, so deleting the five `warn` lines
      // and keeping `shift` left the flag silently inert with the whole suite
      // green: the outcome that comment exists to prevent.
      if (args.length > 0) {
        expect(result.stderr).toContain('--include-unlabeled is REPORT-ONLY since SMI-6981')
        expect(result.stderr).toContain('SMI-7028')
      }
    }
  })

  it('21. never deletes a FOREIGN unlabeled image, in either mode (SMI-6981 image arm)', () => {
    const fixture = setupFixture('prune-foreign-image')
    tempDirs.push(fixture.tempRoot)

    // The image half of the fix shipped with nothing observing it: image
    // fixtures appeared in exactly one test (12), which wires `owned: 'true'`.
    // So no test distinguished the pre-fix version -- which `rmi`s this image
    // under the flag -- from the fixed one. Measured, pre-fix: 1 rmi. Fixed: 0.
    imagesResponse(fixture, ['intd318-dev'])
    imageLabels(fixture, 'intd318-dev', {
      service: 'dev',
      // no `owned` label.
    })

    for (const args of [[], ['--include-unlabeled']]) {
      resetLog(fixture)
      const result = runPrune(fixture, args)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('UNCONFIRMED ownership: intd318-dev')
      expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
      expect(result.stdout).not.toContain('Removed image intd318-dev')
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    }
  })
})
