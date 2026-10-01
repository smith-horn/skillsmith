/**
 * SMI-6919: an environment for a git subprocess that must address only the
 * repository named by its `cwd`. Every husky hook exports GIT_DIR, and a
 * worktree's pre-push runs the root suite, so a fixture `git init` or
 * `git config` that inherits the hook's environment lands in the hook's
 * repository: on 2026-10-01 the attribution harness wrote `core.bare=true`
 * and its `test <t@t.example>` identity into the main repo's shared
 * `.git/config` (reproduced with a whole-config snapshot and diff around one
 * worktree push). Strip every git location variable, point the global and
 * system configs at nothing, and put HOME inside the fixture.
 */

const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
] as const

export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of GIT_LOCATION_VARS) delete env[k]
  env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  env['GIT_CONFIG_NOSYSTEM'] = '1'
  env['HOME'] = home
  return env
}
