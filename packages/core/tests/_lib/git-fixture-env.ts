/**
 * SMI-4693 — git-fixture isolation helpers (per-package copy for
 * `@skillsmith/core`'s tests).
 *
 * Mirrors the canonical helper at `scripts/tests/_lib/git-fixture-env.ts`.
 * Duplicated here because `composite: true` + `rootDir: "."` in
 * `packages/core/tsconfig.json` blocks importing the canonical file from
 * `packages/core/tests/**` (TS6059), the same reason
 * `packages/doc-retrieval-mcp/src/_lib/git-fixture-env.ts` exists.
 * `scripts/tests/git-fixture-env-sync.test.ts` checks that every copy holds the
 * same variable lists and that their helpers behave the same; the canonical
 * version is authoritative.
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
 *
 * This list is a copy of the canonical one in
 * `scripts/tests/_lib/git-fixture-env.ts`. `scripts/tests/git-fixture-env-sync.test.ts`
 * asserts it equals the canonical list (runtime value and source text), as it
 * does for the doc-retrieval-mcp copy.
 */
export const GIT_DISCOVERY_VARS = [
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
  // SMI-4699: XDG_CONFIG_HOME / GIT_CONFIG can still route a stray
  // `git config` (without --local) into the developer's real config or
  // trigger an `[includeIf "gitdir:..."]` rule that lands in the parent
  // worktree's .git/config, so both are stripped. HOME is NOT stripped or
  // repinned: `makeFixtureEnv` leaves it as the caller set it and instead
  // pins GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to /dev/null, so neither
  // ~/.gitconfig nor the system config is read or written.
  'GIT_CONFIG',
  'XDG_CONFIG_HOME',
] as const

/**
 * Config INJECTION variables (SMI-6919, the governance review of cde048ff7),
 * stripped from a FIXTURE env only. git exports GIT_CONFIG_PARAMETERS into
 * every hook of a `git -c k=v <cmd>` run, and it outranks
 * GIT_CONFIG_GLOBAL=/dev/null (command-line precedence): measured,
 * `core.hooksPath` through it ran a hook from outside the fixture and
 * `include.path` through it was honoured. GIT_CONFIG_COUNT is the indexed
 * spelling (GIT_CONFIG_KEY_n/VALUE_n are inert without it). Parity with
 * scripts/ci/git-env-sanitize.sh's contract v4; closes half of SMI-6600.
 *
 * Kept OUT of GIT_DISCOVERY_VARS on purpose: the production read-path scrub
 * (`stripGitDiscoveryEnv` in the per-package copy) iterates that list and
 * must keep a user's own `git -c` overrides visible. The round-30
 * cross-family gate found `git -c remote.origin.url=… push` losing its
 * override through every adapter when the two lists were one.
 */
export const GIT_CONFIG_INJECTION_VARS = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'] as const

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
  for (const v of GIT_CONFIG_INJECTION_VARS) delete env[v]
  // SMI-4699: GIT_CONFIG_GLOBAL=/dev/null already overrides $HOME/.gitconfig,
  // so HOME itself is left as the caller set it (some fixtures legitimately
  // chdir HOME to a scratch dir for non-git tooling). GIT_TERMINAL_PROMPT=0
  // prevents an interactive credential prompt from blocking a hung test.
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
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
