/**
 * Shared git repository-discovery environment scrub (SMI-6994).
 *
 * Git hooks run from a linked worktree export GIT_DIR (and GIT_INDEX_FILE for pre-commit), and
 * neither `git -C <dir>` nor a spawn `cwd` overrides them, so a child `git` would answer about
 * the hook's repository instead of the directory it was pointed at. Every audit that spawns git
 * against an explicit root strips these variables through this one definition, so two checks
 * cannot drift apart. The config-injection variables (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS)
 * are deliberately not in the set.
 *
 * Imports nothing: it must stay inside the registry check's no-node_modules import closure.
 */

export const GIT_DISCOVERY_ENV_RE =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/

/** A shallow copy of `env` without the discovery variables. Never mutates its argument. */
export function gitDiscoveryScrubbedEnv(env = process.env) {
  const out = { ...env }
  for (const k of Object.keys(out)) {
    if (GIT_DISCOVERY_ENV_RE.test(k)) delete out[k]
  }
  return out
}
