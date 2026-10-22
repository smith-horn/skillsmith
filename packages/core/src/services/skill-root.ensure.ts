/**
 * SMI-6531 (A1 step 4a, UD22): create an absent skills root, one level at a time.
 *
 * `bindSkillsRoot` resolves R with `realpath`, so an absent root is a
 * `root-unsafe` stop there. A first install into a client whose skills directory
 * does not exist yet must therefore make it first. This runs BEFORE R is bound
 * and before lock 1 (A1 plan §3.3, "An absent skills root (UD22)"), so what it
 * creates is constrained by what it can prove, not by a lock:
 *
 *  - It walks up to the deepest EXISTING ancestor and accepts that ancestor as
 *    it is, a symlink included (`/var` on macOS, a symlinked home): the rule
 *    constrains only what this call creates.
 *  - Then, top-down, each missing component is made by `mkdirWithParentBits`
 *    with its OWN parent's permission bits (never a recursive `mkdir`, which
 *    would apply the process umask and one mode to every level, and would
 *    follow a symlink planted between two levels). `EEXIST` is accepted, and the
 *    entry must then be a real directory, never a symlink; the helper's mode
 *    policy applies to it as it does to the staging directory.
 *  - A created entry is followed by a sync of its parent (the sync rule). A
 *    filesystem that cannot sync a directory (`unsupported`) is accepted; a
 *    `failed` sync stops with `root-unsafe`, because the entry may not survive
 *    a crash.
 *
 * `mkdirWithParentBits` fits as it is: it is the helper `bindSkillsRoot` uses for
 * ST, it is non-recursive, accepts `EEXIST`, refuses a symlink, and reports
 * whether this call created the entry. Its mode check is judged against the
 * parent's bits, which is the parity this rule wants.
 *
 * Expected outcomes are returned, never thrown (the `SkillWriteStop` code word
 * `root-unsafe` is reused so the caller can turn a failure into that stop).
 *
 * @module @skillsmith/core/services/skill-root.ensure
 */
import fs from 'node:fs'
import path from 'node:path'
import { syncDirectory } from '../install/dir-sync.js'
import { mkdirWithParentBits } from '../install/mkdir-parent-bits.js'
import { modeUnsafeMessage } from '../install/mkdir-parent-bits.policy.js'
import { errCode } from '../install/park-result.js'

/** One step this call took, for a test to assert order: a `mkdir` of `path`, or a `sync` of the directory `path`. */
export interface EnsureRootTraceOp {
  op: 'mkdir' | 'sync'
  path: string
}

export interface EnsureRootOptions {
  /** @internal Test seam: called before each `mkdir` and each directory sync. */
  trace?: (op: EnsureRootTraceOp) => void
}

export type EnsureRootResult =
  /** The root exists as a directory; `created` is what this call made, top-down (empty when it already existed). */
  | { ok: true; created: string[] }
  /** The root could not be made or verified: nothing past `path` was created. */
  | { ok: false; code: 'root-unsafe'; path: string; detail: string; errno: string | null }

function unsafe(p: string, detail: string, errno: string | null): EnsureRootResult {
  return { ok: false, code: 'root-unsafe', path: p, detail, errno }
}

/** The missing components of `dir`, deepest first, and the deepest existing ancestor; or a refusal. */
function missingComponents(
  dir: string
): { missing: string[]; existing: string } | EnsureRootResult {
  const missing: string[] = []
  let p = dir
  for (;;) {
    try {
      fs.lstatSync(p)
      return { missing, existing: p }
    } catch (err) {
      const code = errCode(err)
      // ENOTDIR: an ancestor is not a directory. Keep walking up to it; the
      // mkdir under it then fails and is reported as the refusal.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return unsafe(
          p,
          `the skills root path cannot be examined (${code ?? 'unknown error'})`,
          code
        )
      }
    }
    const parent = path.dirname(p)
    if (parent === p) return unsafe(p, 'no ancestor of the skills root exists', null)
    missing.push(p)
    p = parent
  }
}

/** The mode of `parent`, following a symlink (an accepted existing ancestor may be one). */
function parentMode(parent: string): number | EnsureRootResult {
  try {
    const st = fs.statSync(parent)
    if (!st.isDirectory())
      return unsafe(parent, 'an ancestor of the skills root is not a directory', null)
    return st.mode
  } catch (err) {
    const code = errCode(err)
    return unsafe(
      parent,
      `an ancestor of the skills root cannot be examined (${code ?? 'unknown error'})`,
      code
    )
  }
}

/**
 * Make `skillsDir` exist as a directory, creating only the missing components,
 * top-down, each with its own parent's bits and each followed by a sync of its
 * parent. Run before `bindSkillsRoot` and before lock 1.
 */
export async function ensureSkillsRoot(
  skillsDir: string,
  options: EnsureRootOptions = {}
): Promise<EnsureRootResult> {
  const dir = path.resolve(skillsDir)
  const walked = missingComponents(dir)
  if (!('missing' in walked)) return walked
  const { missing } = walked

  if (missing.length === 0) {
    // Present already (a symlink at the leaf is fine: R is its realpath next).
    try {
      if (fs.statSync(dir).isDirectory()) return { ok: true, created: [] }
    } catch (err) {
      const code = errCode(err)
      return unsafe(dir, `the skills root cannot be resolved (${code ?? 'unknown error'})`, code)
    }
    return unsafe(dir, 'the skills root is not a directory', null)
  }

  const created: string[] = []
  for (const component of missing.reverse()) {
    const parent = path.dirname(component)
    const mode = parentMode(parent)
    if (typeof mode !== 'number') return mode
    options.trace?.({ op: 'mkdir', path: component })
    const made = mkdirWithParentBits(component, mode)
    if (!made.ok) {
      return unsafe(
        component,
        made.phase === 'mode-unsafe'
          ? modeUnsafeMessage({
              subject: component,
              parent,
              wanted: made.wanted,
              actual: made.actual,
              reasons: made.reasons,
            })
          : `${component} could not be made as a directory (${made.phase}${made.errno === null ? '' : `: ${made.errno}`})`,
        made.errno
      )
    }
    if (!made.created) continue // Another process made it first: not ours, nothing to sync.
    created.push(component)
    options.trace?.({ op: 'sync', path: parent })
    const synced = await syncDirectory(parent)
    if (synced.outcome === 'failed') {
      return unsafe(
        parent,
        `${parent} could not be synced after creating ${component} (${synced.code}); it may not survive a crash`,
        synced.code
      )
    }
  }
  return { ok: true, created }
}
