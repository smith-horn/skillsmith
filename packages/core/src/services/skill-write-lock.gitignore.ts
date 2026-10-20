/**
 * SMI-6531 (A1 step 2): the `.gitignore` suggestion for Skillsmith's staging
 * and parked areas (plan §3.2, UD5a', T-N1).
 *
 * Each helper answers one question, "should the user be told to ignore these
 * paths?", and returns the exact one-line hint or null. Both run OUTSIDE lock
 * 1 (the caller runs them after releasing it, or before taking it) and both
 * refuse to run under it: `assertSkillWriteLockNotHeld` throws on entry.
 *
 * Git invocation (owner decision C6): `git -c core.fsmonitor=false -C <root>
 * check-ignore -q <path>`, through `execFile` (never a shell), with a child
 * environment that drops every variable whose upper-cased name starts with
 * `GIT_` except `GIT_CEILING_DIRECTORIES` (see `childGitEnv`).
 * Without the flag a repository's own `core.fsmonitor` would run a program of
 * the repository's choosing on the first write into a cloned project; without
 * the scrub an inherited `GIT_DIR` answers for a different repository.
 * stderr is captured (never inherited) and discarded.
 *
 * Outcomes: exit 0 = ignored, 1 = not ignored, 128 = not a work tree, `ENOENT`
 * spawning git = the upward `.git` walk (C9), anything else (another status, a
 * signal, the 5 s timeout, any other spawn error) = no hint (C8). No git
 * command other than `check-ignore` is run, and no git file is ever written.
 */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { assertSkillWriteLockNotHeld } from '../config/lock-tracker.js'

/** Lock 1's file name under the skills root; `withFileLock` appends `.lock` to `.skillsmith-writes`. */
export const SKILL_WRITE_LOCK_FILE_NAME = '.skillsmith-writes.lock'
/** The staging directory inside the skills root. */
export const SKILL_STAGING_DIR_NAME = '.skillsmith-staging'
/** The parked area directory name (mirrors `PARKED_DIR_NAME` in `install/park-tree.destination.ts`). */
const PARKED_AREA_DIR_NAME = '.skillsmith-parked'

export const STAGING_GITIGNORE_HINT =
  "hint: to keep Skillsmith's temporary files out of git status, add .skillsmith-writes.lock and .skillsmith-staging/ to .gitignore"
export const PARKED_GITIGNORE_HINT =
  "hint: to keep Skillsmith's parked copies out of git status, add .skillsmith-parked/ to .gitignore"

/** The child is killed after this long and the answer is "no hint" (C8). */
export const CHECK_IGNORE_TIMEOUT_MS = 5000

export interface GitignoreHintOptions {
  /** Test seam: shortens the child timeout. */
  timeoutMs?: number
}

type PathVerdict = 'ignored' | 'not-ignored' | 'not-work-tree' | 'no-git' | 'unknown'

/**
 * The child's environment: every variable whose upper-cased name starts with
 * `GIT_` is dropped (C6), except `GIT_CEILING_DIRECTORIES`. The dropped ones
 * redirect git to another repository (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`), inject config
 * (`GIT_CONFIG*`), name a different git program (`GIT_EXEC_PATH`) or turn on
 * tracing (`GIT_TRACE*`), in any case spelling (Windows').
 *
 * `GIT_CEILING_DIRECTORIES` is kept, matched case-insensitively like the rest,
 * because it only NARROWS repository discovery: it stops git's upward search at
 * the listed directories, so it cannot make git answer for a different
 * repository. It is how a user keeps `check-ignore` from walking up out of a
 * home directory or into a slow mount.
 *
 * @internal Exported for the test that pins what is dropped and kept.
 */
export function childGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase()
    if (name.startsWith('GIT_') && name !== 'GIT_CEILING_DIRECTORIES') continue
    env[key] = value
  }
  return env
}

function checkIgnore(root: string, target: string, timeoutMs: number): Promise<PathVerdict> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', root, 'check-ignore', '-q', target],
      { env: childGitEnv(), timeout: timeoutMs, windowsHide: true },
      (error) => {
        if (error === null) return resolve('ignored')
        const code = (error as NodeJS.ErrnoException).code as string | number | undefined
        if (code === 'ENOENT') return resolve('no-git')
        if (code === 1) return resolve('not-ignored')
        if (code === 128) return resolve('not-work-tree')
        return resolve('unknown')
      }
    )
    child.stdin?.end()
  })
}

/** C9: is there a `.git` entry (any type) at `start` or any ancestor? Existence only. */
async function gitEntryAtOrAbove(start: string): Promise<boolean> {
  let dir = path.resolve(start)
  for (;;) {
    try {
      await lstat(path.join(dir, '.git'))
      return true
    } catch {
      // absent or unreadable: keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Verdicts for `targets`, run one call per path. Stops at the first answer
 * that settles the question: anything other than "ignored".
 */
async function firstSettled(
  root: string,
  targets: readonly string[],
  timeoutMs: number
): Promise<PathVerdict> {
  for (const target of targets) {
    const verdict = await checkIgnore(root, target, timeoutMs)
    if (verdict !== 'ignored') return verdict
  }
  return 'ignored'
}

async function hintFor(
  root: string,
  targets: readonly string[],
  line: string,
  options: GitignoreHintOptions | undefined
): Promise<string | null> {
  const verdict = await firstSettled(root, targets, options?.timeoutMs ?? CHECK_IGNORE_TIMEOUT_MS)
  if (verdict === 'not-ignored') return line
  if (verdict === 'no-git') return (await gitEntryAtOrAbove(root)) ? line : null
  return null
}

/**
 * The staging line, for the run whose `mkdir` of `.skillsmith-staging/`
 * created it. Call it after that `mkdir` and outside lock 1.
 */
export async function stagingGitignoreHint(
  skillsRoot: string,
  options?: GitignoreHintOptions
): Promise<string | null> {
  assertSkillWriteLockNotHeld('stagingGitignoreHint')
  return hintFor(
    skillsRoot,
    [SKILL_WRITE_LOCK_FILE_NAME, `${SKILL_STAGING_DIR_NAME}/owner.json`],
    STAGING_GITIGNORE_HINT,
    options
  )
}

/**
 * The parked-area line, for the call whose park reported `parkedAreaCreated`.
 * `parent` is the directory holding `.skillsmith-parked/`. Run it after
 * releasing lock 1 (C7); calls with no lock 1 (park rows outside every skills
 * root) can run it straight after the park.
 */
export async function parkedAreaGitignoreHint(
  parent: string,
  opId: string,
  options?: GitignoreHintOptions
): Promise<string | null> {
  assertSkillWriteLockNotHeld('parkedAreaGitignoreHint')
  return hintFor(parent, [`${PARKED_AREA_DIR_NAME}/${opId}`], PARKED_GITIGNORE_HINT, options)
}
