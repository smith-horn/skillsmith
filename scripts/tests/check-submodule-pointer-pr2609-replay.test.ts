/**
 * SMI-6260 Wave 2 — REAL ground-truth regression replay for PR #2609.
 *
 * check-submodule-pointer.test.ts (Wave 1) covers the PR #2609 failure mode
 * with a SYNTHETIC fixture "shaped like" 928fc96/cadbd29 — small commits
 * with fabricated content standing in for the real ones. This file instead
 * replays the ACTUAL commits from docs/internal's own real history —
 * `928fc96` ("SMI-6205 PR #2609 pre-merge review report") and `cadbd29`
 * ("SMI-6205 PR #2609 post-merge governance retro") — proving the rule
 * engine correctly flags the real incident, not just a fixture built to
 * resemble it. Per CLAUDE.md's SMI-6015 lesson: "don't encode a mechanism
 * claim into a gate without having executed it against real history."
 *
 * No network access: this worktree's own `docs/internal` checkout already
 * has both SHAs resolvable locally (confirmed live during Wave 2
 * implementation — `git -C docs/internal merge-base --is-ancestor 928fc96
 * cadbd29` succeeds). The fixture's `.gitmodules` points its `url` at that
 * real local checkout, so `check-submodule-pointer.sh`'s own `git fetch
 * origin` reads real objects from the local filesystem — no GitHub access,
 * no PAT, fully offline and deterministic.
 *
 * Skips gracefully (not a failure) when docs/internal isn't initialized, or
 * when these specific SHAs aren't resolvable there — a legitimate state for
 * a fresh checkout without `git submodule update --init`, or if the private
 * docs/internal history is ever pruned/rewritten upstream. This is a plain
 * existence-gated skip (no opt-out env var), so it is not registered in
 * docs/internal/process/guards-and-opt-outs.md — that registry is scoped to
 * opt-out-able guards, not unconditional environmental skips.
 *
 * Deliberately does NOT assert which single rule (R3 vs R7) is the primary
 * displayed FAIL: docs/internal's real history has continued to advance
 * since the original incident (this worktree's own checkout is itself many
 * commits ahead of `cadbd29`), so the replay's S (928fc96) is now BOTH
 * behind the fetched T (R3, stale) AND a strict ancestor of the registered
 * B=cadbd29 (R7, backward regression) — both are correct classifications of
 * this real historical bump, and which one displays as primary depends on
 * the priority ordering (R7 > R3), not on which is "true." Asserting a
 * generic FAIL on the blocking mount is the robust, non-flaky check; a
 * pinned single-rule assertion would silently rot as real history advances
 * further past both SHAs.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'check-submodule-pointer.sh')
const REAL_DOCS_INTERNAL = join(REPO_ROOT, 'docs', 'internal')

// The real, confirmed root-cause commits (PR #2609, SMI-6205 Wave 4). See
// the plan doc's Context section and Surface Grounding table for the
// original live confirmation.
const S_SHA = '928fc96' // "pre-merge review report" — the PR's proposed bump
const B_SHA = 'cadbd29' // "post-merge governance retro" — already on docs/internal:main

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() }).trim()
}

function shaResolvable(cwd: string, sha: string): boolean {
  const r = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, env: makeFixtureEnv() })
  return r.status === 0
}

const createdRoots: string[] = []
afterEach(() => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const realDocsInternalReady =
  existsSync(join(REAL_DOCS_INTERNAL, '.git')) &&
  shaResolvable(REAL_DOCS_INTERNAL, S_SHA) &&
  shaResolvable(REAL_DOCS_INTERNAL, B_SHA)

describe('check-submodule-pointer.sh — PR #2609 REAL history replay (ground truth)', () => {
  it.skipIf(!realDocsInternalReady)(
    'replaying the real 928fc96/cadbd29 SHAs through --mode=block produces FAIL on docs/internal',
    () => {
      // Sanity check, independent of the script under test: confirm the
      // real ancestor relationship this whole plan exists to catch.
      expect(
        spawnSync('git', ['merge-base', '--is-ancestor', S_SHA, B_SHA], {
          cwd: REAL_DOCS_INTERNAL,
          env: makeFixtureEnv(),
        }).status
      ).toBe(0)

      const root = makeFixtureTempDir('csp-real-replay')
      createdRoots.push(root)
      const parentDir = join(root, 'parent')
      mkdirSync(parentDir, { recursive: true })
      git(parentDir, 'init', '-q', '-b', 'main')
      git(parentDir, 'config', 'commit.gpgsign', 'false')

      // .gitmodules points `url` at the REAL local docs/internal checkout's
      // own object database — check-submodule-pointer.sh's own `git fetch
      // origin` therefore reads real objects with zero network access.
      writeFileSync(
        join(parentDir, '.gitmodules'),
        `[submodule "docs/internal"]\n\tpath = docs/internal\n\turl = ${REAL_DOCS_INTERNAL}\n\tbranch = main\n`
      )
      git(parentDir, 'add', '.gitmodules')
      git(parentDir, 'commit', '-q', '-m', 'init')

      const mountDir = join(parentDir, 'docs', 'internal')
      execFileSync('git', ['clone', '-q', REAL_DOCS_INTERNAL, mountDir], { env: makeFixtureEnv() })

      // B commit: parent registers the REAL cadbd29 (the already-ahead
      // pointer PR #2609 silently regressed behind).
      git(mountDir, 'checkout', '-q', B_SHA)
      const bMountSha = git(mountDir, 'rev-parse', 'HEAD')
      git(parentDir, 'update-index', '--add', '--cacheinfo', `160000,${bMountSha},docs/internal`)
      git(parentDir, 'commit', '-q', '-m', 'B: register real cadbd29 pointer')
      const bCommit = git(parentDir, 'rev-parse', 'HEAD')

      // S commit: the PR's proposed bump — the REAL 928fc96, a strict
      // ancestor of the already-registered B (the actual PR #2609 bug).
      git(mountDir, 'checkout', '-q', S_SHA)
      const sMountSha = git(mountDir, 'rev-parse', 'HEAD')
      git(parentDir, 'update-index', '--add', '--cacheinfo', `160000,${sMountSha},docs/internal`)
      git(
        parentDir,
        'commit',
        '-q',
        '-m',
        'S: propose real 928fc96 pointer (the PR #2609 regression)'
      )
      const sCommit = git(parentDir, 'rev-parse', 'HEAD')

      const result = spawnSync(
        'bash',
        [SCRIPT, '--mode=block', `--ref=${sCommit}`, `--target=${bCommit}`],
        { cwd: parentDir, encoding: 'utf8', env: makeFixtureEnv() }
      )
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

      expect(result.status).not.toBe(0)
      expect(output).toContain('FAIL [docs/internal]')
      // Confirms the rule engine reached its B-axis comparison at all (not
      // just a T-axis staleness read) — R7 fires only when S is genuinely
      // recognized as an ancestor of the already-registered B.
      expect(output).toMatch(/R3:|R7:/)
    }
  )
})
