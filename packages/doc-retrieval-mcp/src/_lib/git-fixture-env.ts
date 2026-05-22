/**
 * SMI-4693 — git-fixture isolation helpers (per-package copy).
 *
 * Mirrors the canonical helper at `scripts/tests/_lib/git-fixture-env.ts`.
 * Duplicated here because `composite: true` + `rootDir: "."` blocks
 * cross-package imports from `git-commits.test.ts`. Keep the two copies
 * in sync; the canonical version is authoritative. See the RCA at
 * `docs/internal/research/smi-4693-fixture-leak-rca.md` for the full
 * remediation rationale.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every git environment variable that can redirect git's repo-discovery walk
 * away from the spawned process's `cwd:`. Stripping these ensures the spawned
 * `git` resolves the repo via cwd-walk, not via inherited env hints.
 *
 * SMI-5126: exported (was module-private) so the production read-path helper
 * `stripGitDiscoveryEnv` and the canonical copy at
 * `scripts/tests/_lib/git-fixture-env.ts` single-source the same list. A
 * vitest sync check asserts the two copies are byte-identical.
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
  // SMI-4699: HOME / XDG_CONFIG_HOME / GIT_CONFIG can route a stray
  // `git config` (without --local) into the user's real ~/.gitconfig
  // or trigger an `[includeIf "gitdir:..."]` rule that lands in the
  // parent worktree. Strip them; callers may opt back in by passing
  // an explicit override (e.g. HOME: scratch).
  'GIT_CONFIG',
  'XDG_CONFIG_HOME',
] as const

const realpath: (p: string) => string =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

export function makeFixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of GIT_DISCOVERY_VARS) delete env[v]
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

export function makeFixtureTempDir(prefix: string): string {
  const base = realpath(tmpdir())
  return mkdtempSync(join(base, `${prefix}-`))
}

/**
 * SMI-5126 — PRODUCTION read-path env scrub.
 *
 * Returns `{ ...process.env, <GIT_DISCOVERY_VARS deleted>, ...extra }`.
 *
 * Unlike `makeFixtureEnv`, this does NOT pin test identity
 * (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_CONFIG_GLOBAL=/dev/null`):
 * the adapters' read path must still see the user's real git config so
 * `git config --get remote.origin.url` resolves normally. Its sole job is
 * to strip the location-pointing discovery vars (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …) that git honors OVER the spawned
 * process's `cwd:`. An ambient `GIT_DIR` (e.g. exported by git into the
 * pre-push hook) would otherwise make the adapter read the wrong repo.
 *
 * Pass via the `env:` option of every `execFileSync('git', …)` /
 * `execSync('git …')` / `execFileSync('gh', …)` in the read path:
 *
 *     execFileSync('git', [...], { cwd, env: stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' }) })
 */
export function stripGitDiscoveryEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of GIT_DISCOVERY_VARS) delete env[v]
  return { ...env, ...extra }
}
