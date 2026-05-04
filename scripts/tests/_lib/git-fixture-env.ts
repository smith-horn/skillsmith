/**
 * SMI-4693 — git-fixture isolation helpers.
 *
 * Test fixtures under `scripts/tests/**` and `packages/&#42;/(src|tests)/**`
 * routinely build throwaway git repos via `mkdtempSync(join(tmpdir(), prefix))`
 * and spawn `git` against them with `cwd: tmpRepo`. None of the affected
 * fixtures sanitised inherited git-discovery env vars before this helper
 * landed, exposing the SMI-4693 leak: `git checkout -B <branch>` could land
 * in the parent worktree's `.git` instead of the temp repo's, depending on
 * whether the vitest pool worker's cwd inheritance and macOS realpath
 * canonicalisation aligned with what the spawned `git` binary thought it
 * should resolve.
 *
 * The full RCA (verified mechanism + hypothesis verdicts) is in
 * `docs/internal/research/smi-4693-fixture-leak-rca.md`. The defensive
 * remediation here closes every hypothesised vector regardless of which
 * one was the primary trigger.
 *
 * Two helpers:
 *
 *   `makeFixtureEnv(extra)` — returns a frozen process env that strips
 *   GIT_DISCOVERY_VARS and pins author/committer/config to test-safe
 *   values. Pass to every `execFileSync('git', …)` / `spawnSync('git', …)`
 *   call in a fixture.
 *
 *   `makeFixtureTempDir(prefix)` — `mkdtempSync` against a realpath-canonical
 *   `tmpdir()`, so callers see `/private/var/folders/…` on macOS rather than
 *   the `/var/folders/…` symlink. Same root-cause class as SMI-4692.
 *
 * The `audit-standards` Audit-39 check (SMI-4693) enforces that every test
 * file that spawns `git` against a temp repo imports this helper.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every git environment variable that can redirect git's repo-discovery walk
 * away from the spawned process's `cwd:`. Stripping these ensures the spawned
 * `git` resolves the repo via cwd-walk, not via inherited env hints.
 *
 * Source: https://git-scm.com/docs/git#_git_environment_variables (sections
 * "The Git Repository" and "Git Diffs"). Audited 2026-05-03; revisit if git
 * adds new GIT_* discovery vars in a future release.
 */
const GIT_DISCOVERY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const

/**
 * S-2: prefer `realpathSync.native` (libc-backed) where available; the JS
 * fallback handles the same cases more slowly. Both collapse macOS
 * `/var` ↔ `/private/var` symlinks identically.
 */
const realpath: (p: string) => string =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

/**
 * Build a process env safe to pass to `execFileSync('git', …)` /
 * `spawnSync('git', …)` from inside a test fixture. Strips
 * GIT_DISCOVERY_VARS, pins author/committer identity, and forces global +
 * system config to `/dev/null` so the host's `~/.gitconfig` (e.g. signing
 * key requirements, `init.defaultBranch=master`) cannot bleed in.
 *
 * Pass via the `env:` option:
 *
 *     execFileSync('git', ['init'], { cwd: tmpRepo, env: makeFixtureEnv() })
 *
 * Use `extra` to override a specific identity field, e.g. when a test needs
 * the author to be `dependabot[bot]`:
 *
 *     execFileSync('git', ['commit', …], {
 *       cwd: tmpRepo,
 *       env: makeFixtureEnv({ GIT_AUTHOR_NAME: 'dependabot[bot]' }),
 *     })
 */
export function makeFixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of GIT_DISCOVERY_VARS) delete env[v]
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  }
}

/**
 * Create a unique temp directory under a realpath-canonicalised `tmpdir()`.
 * On macOS this returns a path under `/private/var/folders/…` rather than
 * the `/var/folders/…` symlink, eliminating one class of git-discovery
 * canonicalisation collisions (same root-cause class as SMI-4692).
 *
 * `mkdtempSync` already appends a 6-char random suffix to the prefix, so
 * the caller does NOT need to add their own randomisation.
 */
export function makeFixtureTempDir(prefix: string): string {
  const base = realpath(tmpdir())
  return mkdtempSync(join(base, `${prefix}-`))
}
