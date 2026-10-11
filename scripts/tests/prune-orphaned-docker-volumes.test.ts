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
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'

import {
  setupFixture,
  addWorktree,
  volumeListResponse,
  imagesResponse,
  volumeLabels,
  volumeLabelSequence,
  breakGitWorktreeList,
  failGitWorktreeListCalls,
  worktreeListCallCount,
  imageLabels,
  volumePsResponse,
  resetLog,
  runPrune,
  containerResponses,
} from './prune-orphaned-docker-volumes.helpers.js'
import {
  shimGitWorktreeList,
  imageLabelSequence,
  psResponseSequence,
  setPsExit,
  shimGitToplevel,
  shimDockerFailures,
} from './prune-orphaned-docker-volumes.shims.js'

const tempDirs: string[] = []

/** Args that name the one Compose project a run may delete from. */
const only = (project: string, ...rest: string[]): string[] => ['--only-project', project, ...rest]

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

  it('T19. report_containers is handed the main checkout and enumerates with it (SMI-6981)', () => {
    const fixture = setupFixture('container-report-main-repo')
    tempDirs.push(fixture.tempRoot)
    const livePath = join(fixture.repoDir, '.worktrees', 'live-wt')
    addWorktree(fixture.repoDir, livePath, 'feat-report-main-repo')
    containerResponses(fixture, [
      { id: 'live1', name: 'live-dev-1', created: '2000-01-01T00:00:00Z', path: livePath },
      { id: 'gone1', name: 'gone-dev-1', created: '2000-01-01T00:00:00Z', path: fixture.tempRoot },
    ])

    const result = runPrune(fixture, ['--report-containers'], {
      SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS: '1',
      SKILLSMITH_CONTAINER_SPRAWL_MAX_COUNT: '1',
    })

    expect(result.status).toBe(0)
    // Presence: the enumeration ran. A live worktree classifies live-old and a
    // non-worktree path classifies orphaned; neither is possible if it failed.
    expect(result.stdout).toContain('live-dev-1\tlive-old')
    expect(result.stdout).toContain('gone-dev-1\torphaned')
    // The excessive row carries the fixture's main checkout, i.e. the argument.
    expect(result.stdout).toContain(`all-live\texcessive\t2/1\t${fixture.repoDir}`)
    expect(result.stdout).not.toContain('not classifying')
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

    const result = runPrune(fixture, only('gone-wt'))

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

    const result = runPrune(fixture, only('gone-wt'))

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

  it.each([
    // Nonzero exit: refused by the status check, before any control is derived.
    ['fail', 'failed -- refusing to proceed'],
    // Exit 0, nothing printed: only the "no worktree entry" arm can catch it.
    ['empty-ok', 'produced no worktree entry for this checkout'],
  ] as const)(
    '1c. refuses outright when `git worktree list` misbehaves (%s) but .worktrees/ still yields entries',
    (mode, message) => {
      const fixture = setupFixture(`prune-enum-${mode}`)
      tempDirs.push(fixture.tempRoot)

      // derive_protected fails OPEN: with an unusable `git worktree list` the
      // directory scan still contributes, so the set comes back non-empty and
      // missing only the main checkout's own name -- an emptiness check says
      // "proceed". This is the production shape: the real main checkout has a
      // dozen .worktrees/ entries and its own name is absent from that scan.
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
      if (mode === 'fail') breakGitWorktreeList(fixture, ['wt-a'])
      else shimGitWorktreeList(fixture, 'empty-ok', ['wt-a'])

      const result = runPrune(fixture)

      // Fails closed. remove-worktree.sh wraps the call in `|| warn`, so a
      // refusal degrades to a warning there rather than aborting a removal.
      expect(result.status).toBe(1)
      // Each mode must reach ITS arm, or one of the two arms is untested.
      expect(result.stderr).toContain(message)
      expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
      expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
      expect(result.stdout).not.toContain('Removed volume')
      expect(result.stdout).not.toContain('Removed image')
    }
  )

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
    // empty-ok, not a nonzero exit: a failing git is refused by the status check
    // before the control name is ever derived, so only a SUCCESSFUL empty
    // listing still reaches (and tests) the canonical-arm control.
    shimGitWorktreeList(fixture, 'empty-ok', ['repo'])

    const result = runPrune(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('produced no worktree entry for this checkout')
    // Presence: the shim was reached.
    expect(worktreeListCallCount(fixture)).toBeGreaterThanOrEqual(1)
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

    // A genuine orphan rides along as the PRESENCE proof: it is deleted only if
    // volume enumeration ran and the worktree-existence decision was evaluated
    // for every listed volume in this same execution. An absence assertion on
    // wt-a alone also passes when enumeration is skipped entirely.
    volumeListResponse(fixture, ['wt-a_node_modules', 'gone_node_modules'])
    volumeLabels(fixture, 'wt-a_node_modules', {
      volume: 'node_modules',
      project: 'wt-a',
      owned: 'true',
    })
    volumeLabels(fixture, 'gone_node_modules', {
      volume: 'node_modules',
      project: 'gone',
      owned: 'true',
    })

    const result = runPrune(fixture, only('gone'))

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'gone_node_modules'))).toBe(true)
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

    // Test 1e pins the extraction for a LIVE WORKTREE's path; this pins it for
    // the MAIN CHECKOUT's path, which is also where the control name comes from.
    // A truncating extraction (awk's $2) here derives the control `my` from
    // `/x/My Projects/repo`, and the set the same way, so every arm agrees and
    // the main checkout's own volume becomes a candidate. There is now ONE
    // extraction site (enumerate_worktree_paths); both tests exercise it.
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
    expect(result.stderr).not.toContain('refusing to proceed')
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'repo_node_modules'))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume repo_node_modules')
    expect(result.stdout).not.toContain('would remove volume repo_node_modules')
  })

  // SMI-6981: the enumeration must be read ONCE per derivation. Tests 1c/1d fail
  // EVERY `git worktree list` call, so a script that reads it twice and compares
  // the answers sees two matching "nothing"s and refuses -- the disagreement the
  // double read makes possible never occurs. It needs a stray `.worktrees/<main
  // checkout's name>/` directory (so the scan alone can put the control name in
  // the set) plus a read that fails while the control's read succeeds: with a
  // double read per derivation, failing alternate calls builds the SET from the
  // failed read and the CONTROL from the good one, the guard passes, and a live
  // worktree's volume is removed. The lock design reads once per derivation (the
  // sample, then one in-lock read per delete-eligible candidate), so the fail
  // sets below are indexed against THAT sequence: [1,2], [1] and [2].
  const liveVolumeFixture = (name: string) => {
    const fixture = setupFixture(name)
    tempDirs.push(fixture.tempRoot)
    mkdirSync(join(fixture.repoDir, '.worktrees', 'repo'), { recursive: true })
    addWorktree(fixture.repoDir, join(fixture.tempRoot, 'ext', 'wt-a'), 'feat-a')
    volumeListResponse(fixture, ['wt-a_node_modules', 'gone_node_modules'])
    for (const [vol, project] of [
      ['wt-a_node_modules', 'wt-a'],
      ['gone_node_modules', 'gone'],
    ]) {
      volumeLabels(fixture, vol, { volume: 'node_modules', project, owned: 'true' })
    }
    return fixture
  }

  it('1g. a partially failing enumeration never deletes a live worktree volume (read once per derivation)', () => {
    // Known-positive control: healthy enumeration. The orphan IS deleted, so the
    // absence assertions below can observe a deletion, and the shim is reached
    // exactly once per derivation -- two: the :314-style sample plus one in-lock
    // read for the single delete-eligible candidate (SMI-6981 lock).
    const healthy = liveVolumeFixture('prune-snapshot-control')
    failGitWorktreeListCalls(healthy, [])
    const ok = runPrune(healthy, only('gone'))
    expect(ok.status).toBe(0)
    expect(ok.dockerCalls.some((c) => deletesVolume(c, 'gone_node_modules'))).toBe(true)
    expect(ok.dockerCalls.some((c) => deletesVolume(c, 'wt-a_node_modules'))).toBe(false)

    for (const failSet of [[1, 2], [1], [2]]) {
      const fixture = liveVolumeFixture('prune-snapshot-failset')
      failGitWorktreeListCalls(fixture, failSet)
      const result = runPrune(fixture, only('gone'))
      // Presence: the shim was reached, so "nothing deleted" cannot be explained
      // by the script never enumerating.
      expect(worktreeListCallCount(fixture)).toBeGreaterThanOrEqual(1)
      expect(result.dockerCalls.some((c) => deletesVolume(c, 'wt-a_node_modules'))).toBe(false)
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
      expect(result.stdout).not.toContain('Removed volume wt-a_node_modules')
    }

    // The property itself, on the case that defeated the double read: call 1
    // fails, so the first (and only) read is empty and the run refuses.
    const refused = liveVolumeFixture('prune-snapshot-refuse')
    failGitWorktreeListCalls(refused, [1, 2])
    const r = runPrune(refused, only('gone'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('failed -- refusing to proceed')
    expect(worktreeListCallCount(refused)).toBe(1)
    // Last, deliberately: the behavioural assertions above must be what fails
    // first if a second read is reintroduced; this one only pins the mechanism.
    expect(worktreeListCallCount(healthy)).toBe(2)
  })

  it('1i. a listing cut short by a nonzero exit is refused, never used as the protected set (SMI-6981 round 3)', () => {
    // The shim prints the MAIN checkout's record and then exits 128 before the
    // later worktrees. That output alone satisfies the positive control (the
    // control is the first record), so only a check on the command's own exit
    // status keeps wt-a -- registered, out of tree, present ONLY in that
    // listing -- protected.
    const fixture = liveVolumeFixture('prune-partial-listing')
    shimGitWorktreeList(fixture, 'partial')

    const result = runPrune(fixture)

    // Presence: the shim ran, so "nothing deleted" is not "never enumerated".
    expect(worktreeListCallCount(fixture)).toBeGreaterThanOrEqual(1)
    expect(result.dockerCalls.some((c) => deletesVolume(c, 'wt-a_node_modules'))).toBe(false)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('failed -- refusing to proceed')
  })

  it('1h. an owned eval-cron volume survives, and the pruner did enumerate it (SMI-7033)', () => {
    const fixture = setupFixture('prune-eval-cron')
    tempDirs.push(fixture.tempRoot)

    // Owned, unattached, in neither worktree enumeration: the exact shape that
    // was measured live. The suffix family must be covered too; a look-alike that
    // merely CONTAINS the name must not be (exact, not substring).
    const names = [
      'skillsmith-eval-cron_node_modules',
      'skillsmith-eval-cron_native-seed-better-sqlite3',
      'skillsmith-eval-cron-2_node_modules',
      'xskillsmith-eval-cron_node_modules',
    ]
    volumeListResponse(fixture, names)
    for (const vol of names) {
      const project = vol.slice(0, vol.indexOf('_'))
      const key = vol.slice(vol.indexOf('_') + 1)
      volumeLabels(fixture, vol, { volume: key, project, owned: 'true' })
    }
    imagesResponse(fixture, ['skillsmith-eval-cron-dev'])
    imageLabels(fixture, 'skillsmith-eval-cron-dev', { service: 'dev', owned: 'true' })

    const result = runPrune(fixture, only('xskillsmith-eval-cron'))

    expect(result.status).toBe(0)
    // Presence, from the same execution: each protected name was classified,
    // owned-checked and reached the gate, so survival is not "never looked".
    for (const vol of names.slice(0, 3)) {
      expect(result.stdout).toContain(`NON-WORKTREE project: ${vol}`)
      // Whole-token compare: deletesVolume's substring match would see the
      // look-alike's deletion (`xskillsmith-...`) as a deletion of this name.
      expect(result.dockerCalls.some((c) => deletesVolume(c) && c.split(' ').includes(vol))).toBe(
        false
      )
    }
    expect(result.stdout).toContain('NON-WORKTREE project: skillsmith-eval-cron-dev')
    expect(result.dockerCalls.some((c) => deletesImage(c, 'skillsmith-eval-cron-dev'))).toBe(false)
    // The look-alike is NOT in the family, so it is an ordinary orphan: deleted.
    expect(result.dockerCalls).toContain('volume rm xskillsmith-eval-cron_node_modules')
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)

    // Second layer: even when the caller NAMES the family itself, the
    // non-worktree gate still refuses to delete it (and its image).
    resetLog(fixture)
    const named = runPrune(fixture, only('skillsmith-eval-cron'))
    expect(named.status).toBe(0)
    expect(named.stdout).toContain('NON-WORKTREE project: skillsmith-eval-cron_node_modules')
    expect(named.stdout).toContain('NON-WORKTREE project: skillsmith-eval-cron-dev')
    expect(named.dockerCalls.some((c) => deletesVolume(c) || deletesImage(c))).toBe(false)
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

    const result = runPrune(fixture, only('other-wt'))

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

    const result = runPrune(fixture, only('other-repo'))

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

    const result = runPrune(fixture, only('other-repo'))

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

    const first = runPrune(fixture, only('gone-wt'))

    expect(first.status).toBe(0)
    expect(first.stdout).toContain('UNCONFIRMED ownership: gone-wt_node_modules')
    expect(first.dockerCalls.some((c) => c === 'volume rm gone-wt_node_modules')).toBe(false)

    // Same fixture (same responses), re-run with the explicit escape hatch.
    resetLog(fixture)
    const second = runPrune(fixture, only('gone-wt', '--include-unlabeled'))

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

    const result = runPrune(fixture, only('gone-wt'))

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

    const result = runPrune(fixture, only('gone-wt', '--dry-run'))

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

  it('15. a volume rm failure warns, continues, and makes the run exit 1 (SMI-6981 round 4)', () => {
    const fixture = setupFixture('prune-rm-fail')
    tempDirs.push(fixture.tempRoot)

    volumeListResponse(fixture, ['gone-wt_node_modules'])
    volumeLabels(fixture, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })
    // A daemon-shaped refusal (measured CLI output): a definitive rejection, so
    // the run records it and goes on. A silent exit 1 is outcome-unknown and stops.
    shimDockerFailures(fixture, [
      {
        glob: 'volume rm gone-wt_node_modules',
        stderr: 'Error response from daemon: remove gone-wt_node_modules: volume is in use - [abc]',
      },
    ])

    const result = runPrune(fixture, only('gone-wt'))

    expect(result.status).toBe(1)
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

    const result = runPrune(fixture, only('gone-wt'))

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

    const result = runPrune(fixture, only('gone-wt'))

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

    const first = runPrune(fixture, only('gone-wt'))

    expect(first.status).toBe(0)
    expect(first.stdout).toContain('UNCONFIRMED ownership: gone-wt_native-seed-esbuild-scope')
    expect(first.dockerCalls.some((c) => c === 'volume rm gone-wt_native-seed-esbuild-scope')).toBe(
      false
    )

    resetLog(fixture)
    const second = runPrune(fixture, only('gone-wt', '--include-unlabeled'))

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
      const result = runPrune(fixture, only('intd318', ...args))

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
      const result = runPrune(fixture, only('intd318', ...args))

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('UNCONFIRMED ownership: intd318-dev')
      expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
      expect(result.stdout).not.toContain('Removed image intd318-dev')
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    }
  })
})

// SMI-6981 round 3: a docker query whose answer gates a deletion and FAILS is
// "unknown", and unknown means skip. Each case pairs a failing arm with a
// known-positive control (the identical fixture, query healthy, resource IS
// deleted), so "not deleted" cannot be explained by the fixture never qualifying.
describe('SMI-6981: failed or flipped gating queries never license a delete', () => {
  const VOL = 'gone-wt_node_modules'
  const IMG = 'gone-wt-dev'
  const volPs = `ps -aq --filter volume=${VOL}`
  const imgPs = `ps -aq --filter ancestor=${IMG}`
  const imgOwned = `image inspect ${IMG} --format {{index .Config.Labels "app.skillsmith.owned"}}`

  const volumeFixture = (name: string) => {
    const fixture = setupFixture(name)
    tempDirs.push(fixture.tempRoot)
    volumeListResponse(fixture, [VOL])
    volumeLabels(fixture, VOL, { volume: 'node_modules', project: 'gone-wt', owned: 'true' })
    return fixture
  }
  const imageFixture = (name: string) => {
    const fixture = setupFixture(name)
    tempDirs.push(fixture.tempRoot)
    imagesResponse(fixture, [IMG, 'repo-dev'])
    imageLabels(fixture, IMG, { service: 'dev', owned: 'true' })
    return fixture
  }

  it('G3. report-containers does not call every container orphaned when enumeration fails', () => {
    const containers = (root: string) => [
      { id: 'c1', name: 'live-dev-1', created: '2000-01-01T00:00:00Z', path: root },
    ]
    // Known-positive: with a healthy enumeration this path is NOT a worktree, so
    // the same container reports "orphaned" -- the word the failing run must lack.
    const healthy = setupFixture('report-enum-ok')
    tempDirs.push(healthy.tempRoot)
    containerResponses(healthy, containers(join(healthy.tempRoot, 'elsewhere')))
    mkdirSync(join(healthy.tempRoot, 'elsewhere'), { recursive: true })
    const ok = runPrune(healthy, ['--report-containers'])
    expect(ok.stdout).toContain('live-dev-1\torphaned')

    const broken = setupFixture('report-enum-fail')
    tempDirs.push(broken.tempRoot)
    mkdirSync(join(broken.tempRoot, 'elsewhere'), { recursive: true })
    containerResponses(broken, containers(join(broken.tempRoot, 'elsewhere')))
    breakGitWorktreeList(broken)
    const result = runPrune(broken, ['--report-containers'])
    expect(result.stdout).toContain('worktree enumeration failed -- not classifying')
    expect(result.stdout).not.toContain('orphaned')
    expect(result.dockerCalls.some((c) => /\b(rm|rmi|stop|kill)\b/.test(c))).toBe(false)
  })

  it('G4a. a failing attachment query at candidate construction skips the volume', () => {
    const control = volumeFixture('prune-ps-control')
    expect(runPrune(control, only('gone-wt')).dockerCalls).toContain(`volume rm ${VOL}`)

    const fixture = volumeFixture('prune-ps-fails-scan')
    setPsExit(fixture, `ps_volume__${VOL}`, 1)
    const result = runPrune(fixture, only('gone-wt'))

    // Presence AND site: exactly ONE query, so the scan site itself skipped. Two
    // would mean the scan treated the failure as "unattached" and only the
    // re-check caught it, which leaves this site unpinned.
    expect(result.dockerCalls.filter((c) => c === volPs)).toHaveLength(1)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
    expect(result.stderr).toContain('Could not check container attachment')
    expect(result.status).toBe(0)
  })

  it('G4b. a failing attachment query at the pre-delete re-check skips the volume', () => {
    const fixture = volumeFixture('prune-ps-fails-recheck')
    setPsExit(fixture, `ps_volume__${VOL}`, [0, 1]) // scan ok, re-check fails
    const result = runPrune(fixture, only('gone-wt'))

    // Presence: BOTH reads happened, so the failure was the re-check's.
    expect(result.dockerCalls.filter((c) => c === volPs)).toHaveLength(2)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
    expect(result.stderr).toContain('Could not check container attachment')
  })

  it('G4c. a failing attachment query at image candidate construction skips the image', () => {
    const control = imageFixture('prune-img-ps-control')
    expect(runPrune(control, only('gone-wt')).dockerCalls).toContain(`rmi ${IMG}`)

    const fixture = imageFixture('prune-img-ps-fails')
    setPsExit(fixture, `ps_ancestor__${IMG}`, 1)
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c === imgPs)).toHaveLength(1) // scan site skipped; see G4a
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed image')
    expect(result.stderr).toContain('Could not check container attachment')
  })

  it('G4d. a failing attachment query at the image pre-rmi re-check skips the image', () => {
    const fixture = imageFixture('prune-img-ps-fails-recheck')
    setPsExit(fixture, `ps_ancestor__${IMG}`, [0, 1])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c === imgPs)).toHaveLength(2)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed image')
  })

  // SMI-6981 round 4 (F3/F4): a failed gating inspect or a failed delete must not
  // read as "nothing to do". Only "No such volume/image" is benign.
  const volOwnedGlob = `volume inspect ${VOL} *skillsmith.owned*`
  const imgOwnedGlob = `image inspect ${IMG} *skillsmith.owned*`

  it('F3a. a failing volume ownership inspect skips the volume and fails the run', () => {
    const fixture = volumeFixture('prune-insp-fail-vol')
    shimDockerFailures(fixture, [
      { glob: volOwnedGlob, stderr: 'Cannot connect to the Docker daemon' },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    // Presence: the failing inspect was actually issued.
    expect(
      result.dockerCalls.filter(
        (c) => c === `volume inspect ${VOL} --format {{index .Labels "app.skillsmith.owned"}}`
      )
    ).toHaveLength(1)
    expect(result.stderr).toContain(`Could not inspect volume ${VOL}`)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.status).toBe(1)
  })

  it('F3b. a volume that vanished before its inspect is a benign skip: exit 0, no warning', () => {
    const fixture = volumeFixture('prune-insp-gone-vol')
    shimDockerFailures(fixture, [
      { glob: volOwnedGlob, stderr: `Error response from daemon: get ${VOL}: no such volume` },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c.startsWith(`volume inspect ${VOL}`))).toHaveLength(3)
    expect(result.stderr).not.toContain('Could not inspect')
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.status).toBe(0)
  })

  it('F3c. a failing volume ownership RE-READ before the delete skips it and fails the run', () => {
    const fixture = volumeFixture('prune-insp-fail-recheck')
    shimDockerFailures(fixture, [{ glob: volOwnedGlob, stderr: 'i/o timeout', passFirst: 1 }])
    const result = runPrune(fixture, only('gone-wt'))

    expect(
      result.dockerCalls.filter(
        (c) => c.includes(`inspect ${VOL}`) && c.includes('skillsmith.owned')
      )
    ).toHaveLength(2)
    expect(result.stderr).toContain(`Could not inspect volume ${VOL}`)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.status).toBe(1)
  })

  it('F3d. a failing image ownership inspect skips the image and fails the run', () => {
    const fixture = imageFixture('prune-insp-fail-img')
    shimDockerFailures(fixture, [
      { glob: imgOwnedGlob, stderr: 'Cannot connect to the Docker daemon' },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c === imgOwned)).toHaveLength(1)
    expect(result.stderr).toContain(`Could not inspect image ${IMG}`)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.status).toBe(1)
  })

  it('F3e. an image that vanished before its inspect is a benign skip: exit 0, no warning', () => {
    const fixture = imageFixture('prune-insp-gone-img')
    shimDockerFailures(fixture, [{ glob: imgOwnedGlob, stderr: `Error: No such image: ${IMG}` }])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c === imgOwned)).toHaveLength(1)
    expect(result.stderr).not.toContain('Could not inspect')
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.status).toBe(0)
  })

  it('F4a. a volume rm that fails for a real reason exits 1 and says why', () => {
    const fixture = volumeFixture('prune-rm-real-fail')
    shimDockerFailures(fixture, [
      {
        glob: `volume rm ${VOL}`,
        stderr: `Error response from daemon: remove ${VOL}: volume is in use - [abc123]`,
      },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls).toContain(`volume rm ${VOL}`)
    expect(result.stderr).toContain(`Could not remove volume ${VOL}`)
    expect(result.stderr).toContain('volume is in use')
    expect(result.status).toBe(1)
  })

  it('F4b. a volume rm answering "no such volume" is benign: exit 0', () => {
    const fixture = volumeFixture('prune-rm-gone')
    shimDockerFailures(fixture, [
      {
        glob: `volume rm ${VOL}`,
        stderr: `Error response from daemon: get ${VOL}: no such volume`,
      },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls).toContain(`volume rm ${VOL}`)
    expect(result.stderr).not.toContain('Could not remove')
    expect(result.stdout).toContain(`Volume ${VOL} already gone`)
    expect(result.status).toBe(0)
  })

  it('F4c. an image rmi that fails for a real reason exits 1 and says why', () => {
    const fixture = imageFixture('prune-rmi-real-fail')
    shimDockerFailures(fixture, [
      {
        glob: `rmi ${IMG}`,
        stderr: `Error response from daemon: conflict: unable to delete ${IMG} - image is being used by running container abc`,
      },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls).toContain(`rmi ${IMG}`)
    expect(result.stderr).toContain(`Could not remove image ${IMG}`)
    expect(result.stderr).toContain('being used by running container')
    expect(result.status).toBe(1)
  })

  it('F4d. an image rmi answering "No such image" is benign: exit 0', () => {
    const fixture = imageFixture('prune-rmi-gone')
    shimDockerFailures(fixture, [
      { glob: `rmi ${IMG}`, stderr: `Error response from daemon: No such image: ${IMG}:latest` },
    ])
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls).toContain(`rmi ${IMG}`)
    expect(result.stderr).not.toContain('Could not remove')
    expect(result.stdout).toContain(`Image ${IMG} already gone`)
    expect(result.status).toBe(0)
  })

  it('R2-PR16a. an image whose ownership label vanishes between scan and rmi is not removed', () => {
    const fixture = imageFixture('prune-img-owner-flip')
    // Owned at the scan, gone by the final re-read (sequence then runs dry).
    imageLabelSequence(fixture, IMG, 'owned', ['true'])
    const result = runPrune(fixture, only('gone-wt'))

    // Presence: both reads happened, so the second one decided the outcome.
    expect(result.dockerCalls.filter((c) => c === imgOwned)).toHaveLength(2)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed image')
    expect(result.stdout).not.toContain('UNCONFIRMED ownership: gone-wt-dev')
  })

  it('R2-PR16b. an image that gains a container between scan and rmi is not removed', () => {
    const fixture = imageFixture('prune-img-attach-flip')
    psResponseSequence(fixture, `ps_ancestor__${IMG}`, ['', 'cid1']) // unattached, then attached
    const result = runPrune(fixture, only('gone-wt'))

    expect(result.dockerCalls.filter((c) => c === imgPs)).toHaveLength(2)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed image')
  })

  it('R2-PR16c. an image delete reads the ownership label immediately before `rmi`', () => {
    const result = runPrune(imageFixture('prune-img-order'), only('gone-wt'))
    const rmiIdx = result.dockerCalls.findIndex((c) => deletesImage(c, IMG))
    expect(rmiIdx).toBeGreaterThan(0)
    expect(result.dockerCalls[rmiIdx - 1]).toBe(imgOwned)
    expect(result.dockerCalls.filter((c) => c === imgOwned)).toHaveLength(2)
  })
})

// D-B: sanitize_project_name must equal Compose's own normalisation. Expected
// values were MEASURED with Compose v5.3.1 (the `name:` printed by
// `docker compose config` run in an otherwise empty directory of that name),
// not derived from the implementation.
describe('D-B: sanitize_project_name matches Compose project-name normalisation', () => {
  const libPath = join(__dirname, '..', '_lib.sh')
  const sanitize = (name: string): string => {
    const r = spawnSync(
      'bash',
      ['-c', 'source "$1"; sanitize_project_name "$2"', '_', libPath, name],
      {
        encoding: 'utf8',
      }
    )
    expect(r.status).toBe(0)
    return r.stdout.replace(/\n$/, '')
  }
  it.each([
    ['_Abc.Def', 'abcdef'],
    ['-foo', 'foo'],
    ['--x__y', 'x__y'],
    ['_-_a', 'a'],
    ['.hid', 'hid'],
    ['My Proj', 'myproj'],
    ['a.b-C_d', 'ab-c_d'],
    ['a@b#c', 'abc'],
    ['SMI-4700_Test', 'smi-4700_test'],
    ['plain', 'plain'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitize(input)).toBe(expected)
  })

  it('a live worktree whose directory starts with _ is refused as an --only-project target', () => {
    const fixture = setupFixture('prune-leading-underscore')
    tempDirs.push(fixture.tempRoot)
    addWorktree(fixture.repoDir, join(fixture.tempRoot, 'ext', '_Live.Wt'), 'feat-underscore')
    volumeListResponse(fixture, ['livewt_node_modules'])
    volumeLabels(fixture, 'livewt_node_modules', {
      volume: 'node_modules',
      project: 'livewt',
      owned: 'true',
    })
    // Naming the live worktree's Compose project must be refused. Without the
    // leading-underscore strip the protected set holds `_livewt`, `livewt`
    // reads as an orphan, and the run proceeds to delete it.
    const result = runPrune(fixture, only('livewt'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('main checkout or a live worktree')
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.stdout).not.toContain('Removed volume')
  })
})

describe('L1: the positive control is derived independently of the listing it checks', () => {
  it('a control that disagrees with a healthy listing is refused (reaches the mismatch arm)', () => {
    const fixture = setupFixture('prune-control-mismatch')
    tempDirs.push(fixture.tempRoot)
    volumeListResponse(fixture, ['gone_node_modules'])
    volumeLabels(fixture, 'gone_node_modules', {
      volume: 'node_modules',
      project: 'gone',
      owned: 'true',
    })
    // Known-positive: the same fixture without the shim proceeds and deletes.
    const ok = runPrune(fixture, only('gone'))
    expect(ok.status).toBe(0)
    expect(ok.dockerCalls.some((c) => deletesVolume(c, 'gone_node_modules'))).toBe(true)

    resetLog(fixture)
    shimGitToplevel(fixture, join(fixture.tempRoot, 'Ghost'))
    const result = runPrune(fixture, only('gone'))
    expect(result.status).toBe(1)
    // 'ghost' can only come from the shim: proves the independent query was reached.
    expect(result.stderr).toContain("own project name ('ghost'")
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
    expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
  })

  it('a control that sanitizes to the empty string is refused (reaches the empty arm)', () => {
    const fixture = setupFixture('prune-control-empty')
    tempDirs.push(fixture.tempRoot)
    shimGitToplevel(fixture, join(fixture.tempRoot, '@@@'))
    const result = runPrune(fixture)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sanitizes to the empty string')
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
  })

  it('a failing independent query is refused rather than skipped', () => {
    const fixture = setupFixture('prune-control-unavailable')
    tempDirs.push(fixture.tempRoot)
    shimGitToplevel(fixture, null)
    const result = runPrune(fixture)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('could not independently identify this checkout')
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
  })

  it('a healthy run through a symlinked path is NOT refused (basenames agree)', () => {
    const fixture = setupFixture('prune-control-symlink')
    tempDirs.push(fixture.tempRoot)
    const alias = join(fixture.tempRoot, 'ALIAS')
    symlinkSync(fixture.repoDir, alias)
    const result = runPrune({
      ...fixture,
      repoDir: alias,
      scriptPath: join(alias, 'scripts', 'prune-orphaned-docker-volumes.sh'),
    })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('refusing to proceed')
    // Presence: the run got as far as the docker queries.
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
  })
})

describe('L2: a failed docker listing is reported and fails the run, never "nothing to prune"', () => {
  it('volume ls failing: warns, deletes nothing, exits 1 -- and a healthy run deletes', () => {
    const mk = (name: string) => {
      const fixture = setupFixture(name)
      tempDirs.push(fixture.tempRoot)
      volumeListResponse(fixture, ['gone_node_modules'])
      volumeLabels(fixture, 'gone_node_modules', {
        volume: 'node_modules',
        project: 'gone',
        owned: 'true',
      })
      return fixture
    }
    const ok = runPrune(mk('prune-vls-ok'), only('gone'))
    expect(ok.status).toBe(0)
    expect(ok.dockerCalls.some((c) => deletesVolume(c, 'gone_node_modules'))).toBe(true)

    const broken = mk('prune-vls-fail')
    setPsExit(broken, 'volume_ls', 1)
    const result = runPrune(broken, only('gone'))
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
    expect(result.stderr).toContain('Could not list volumes')
    expect(result.status).toBe(1)
    expect(result.dockerCalls.some((c) => deletesVolume(c))).toBe(false)
  })

  it('images failing: warns, deletes nothing, exits 1 -- and a healthy run deletes', () => {
    const mk = (name: string) => {
      const fixture = setupFixture(name)
      tempDirs.push(fixture.tempRoot)
      imagesResponse(fixture, ['gone-dev'])
      imageLabels(fixture, 'gone-dev', { service: 'dev', owned: 'true' })
      return fixture
    }
    const ok = runPrune(mk('prune-img-ok'), only('gone'))
    expect(ok.status).toBe(0)
    expect(ok.dockerCalls.some((c) => deletesImage(c, 'gone-dev'))).toBe(true)

    const broken = mk('prune-img-fail')
    setPsExit(broken, 'images', 1)
    const result = runPrune(broken, only('gone'))
    expect(result.dockerCalls.some((c) => c.startsWith('images'))).toBe(true)
    expect(result.stderr).toContain('Could not list images')
    expect(result.status).toBe(1)
    expect(result.dockerCalls.some((c) => deletesImage(c))).toBe(false)
  })

  it('--report-containers: a failing docker ps is not "all clean"', () => {
    const fixture = setupFixture('report-ps-fail')
    tempDirs.push(fixture.tempRoot)
    const elsewhere = join(fixture.tempRoot, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    containerResponses(fixture, [
      { id: 'c1', name: 'gone-dev-1', created: '2000-01-01T00:00:00Z', path: elsewhere },
    ])
    expect(runPrune(fixture, ['--report-containers']).stdout).toContain('gone-dev-1\torphaned')

    setPsExit(fixture, 'container_ids', 1)
    const result = runPrune(fixture, ['--report-containers'])
    expect(result.dockerCalls.some((c) => c.startsWith('ps -q'))).toBe(true)
    expect(result.stdout).toContain('could not list containers')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('orphaned')
  })
})

describe('L4: container age is computed from Docker UTC timestamps regardless of local TZ', () => {
  it('a 10h-old container is live-old at a 5h threshold under a UTC-8 local zone', () => {
    const fixture = setupFixture('report-tz')
    tempDirs.push(fixture.tempRoot)
    const livePath = join(fixture.repoDir, '.worktrees', 'tz-wt')
    addWorktree(fixture.repoDir, livePath, 'feat-tz')
    // Fractional seconds + Z, exactly as Docker emits. Parsed as LOCAL time in
    // PDT the age reads ~8h too small (2h) and the container is missed.
    const created = new Date(Date.now() - 10 * 3600_000).toISOString()
    containerResponses(fixture, [{ id: 'tz1', name: 'tz-wt-dev-1', created, path: livePath }])
    const result = runPrune(fixture, ['--report-containers'], {
      TZ: 'America/Los_Angeles',
      SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS: '5',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('tz-wt-dev-1\tlive-old')
  })
})

describe('#3041: deletion needs --only-project; every other orphan is report-only', () => {
  const orphans = (name: string) => {
    const fixture = setupFixture(name)
    tempDirs.push(fixture.tempRoot)
    volumeListResponse(fixture, ['gone-wt_node_modules', 'release-mcp-0717_node_modules'])
    for (const [vol, project] of [
      ['gone-wt_node_modules', 'gone-wt'],
      ['release-mcp-0717_node_modules', 'release-mcp-0717'],
    ]) {
      volumeLabels(fixture, vol, { volume: 'node_modules', project, owned: 'true' })
    }
    imagesResponse(fixture, ['gone-wt-dev', 'release-mcp-0717-dev'])
    for (const img of ['gone-wt-dev', 'release-mcp-0717-dev']) {
      imageLabels(fixture, img, { service: 'dev', owned: 'true' })
    }
    return fixture
  }

  it('a standalone run sees the orphans but never calls volume rm / rmi, whatever other flags are set', () => {
    for (const args of [[], ['--include-unlabeled'], ['--dry-run']]) {
      const fixture = orphans('prune-report-only')
      const result = runPrune(fixture, args)
      expect(result.status).toBe(0)
      // Presence: both volumes and both images were classified and reached the
      // scope gate, so "nothing deleted" is not "never looked".
      expect(result.stdout).toContain('REPORT-ONLY orphan: gone-wt_node_modules')
      expect(result.stdout).toContain('REPORT-ONLY orphan: release-mcp-0717_node_modules')
      expect(result.stdout).toContain('REPORT-ONLY orphan: gone-wt-dev')
      expect(result.stdout).toContain('REPORT-ONLY orphan: release-mcp-0717-dev')
      expect(result.dockerCalls.some((c) => deletesVolume(c) || deletesImage(c))).toBe(false)
      expect(result.dockerCalls.some(destroysInBulk)).toBe(false)
      expect(result.stdout).not.toContain('would remove')
    }
  })

  it('--only-project deletes only that project and leaves another owned orphan untouched', () => {
    const fixture = orphans('prune-scoped')
    const result = runPrune(fixture, only('gone-wt'))
    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('volume rm gone-wt_node_modules')
    expect(result.dockerCalls).toContain('rmi gone-wt-dev')
    expect(
      result.dockerCalls.some(
        (c) => (deletesVolume(c) || deletesImage(c)) && c.includes('release-mcp-0717')
      )
    ).toBe(false)
    expect(result.stdout).toContain('REPORT-ONLY orphan: release-mcp-0717_node_modules')
    expect(result.stdout).toContain('REPORT-ONLY orphan: release-mcp-0717-dev')
    // The `=` spelling is the same scope.
    resetLog(fixture)
    const eq = runPrune(fixture, ['--only-project=release-mcp-0717'])
    expect(eq.dockerCalls).toContain('volume rm release-mcp-0717_node_modules')
    expect(
      eq.dockerCalls.some((c) => (deletesVolume(c) || deletesImage(c)) && c.includes('gone-wt'))
    ).toBe(false)
  })

  it('a project name is matched whole: a prefix of an orphan project deletes nothing', () => {
    const fixture = orphans('prune-scoped-prefix')
    const result = runPrune(fixture, only('release-mcp'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('REPORT-ONLY orphan: release-mcp-0717_node_modules')
    expect(result.dockerCalls.some((c) => deletesVolume(c) || deletesImage(c))).toBe(false)
  })

  it.each([
    ['the main checkout', (f: { repoDir: string }) => ['repo', f]],
    ['an in-tree live worktree', () => ['live-in', null]],
    ['an out-of-tree live worktree', () => ['live-out', null]],
    ['a live worktree whose name sanitizes', () => ['smi-4700_test', null]],
  ] as const)('refuses --only-project naming %s, deleting nothing', (_label, pick) => {
    const fixture = orphans('prune-refuse-live')
    addWorktree(fixture.repoDir, join(fixture.repoDir, '.worktrees', 'live-in'), 'feat-live-in')
    addWorktree(fixture.repoDir, join(fixture.tempRoot, 'ext', 'live-out'), 'feat-live-out')
    addWorktree(fixture.repoDir, join(fixture.tempRoot, 'ext', 'SMI-4700_Test'), 'feat-sani')
    const [project] = pick(fixture)
    const result = runPrune(fixture, only(project as string))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('main checkout or a live worktree')
    expect(result.dockerCalls.some((c) => deletesVolume(c) || deletesImage(c))).toBe(false)
  })

  it.each([[''], ['Gone'], ['_gone'], ['-gone'], ['a b'], ['gone;rm'], ['a/b']])(
    'refuses a malformed --only-project %j before any docker call',
    (name) => {
      const fixture = orphans('prune-refuse-invalid')
      const result = runPrune(fixture, ['--only-project', name])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('not a valid Compose project name')
      expect(result.dockerCalls).toHaveLength(0)
    }
  )

  it('refuses --only-project with no value', () => {
    const fixture = orphans('prune-refuse-missing')
    const result = runPrune(fixture, ['--only-project'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requires a project name')
    expect(result.dockerCalls).toHaveLength(0)
  })
})
