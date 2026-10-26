/**
 * SMI-6531 (A1 step 6a-i): what a staging directory holds, for doctor's listing
 * (plan §3.9 `doctor recovery`: op dirs, and "Leftover probes (UD25)").
 *
 * `ST`'s entries are of three kinds: an op dir (a real directory whose name
 * doesn't start with `.`), a leftover probe (`.skillsmith-probe-<opId>-<n>`,
 * the clock gate's empty directory, left by a kill between its `mkdir` and its
 * `rmdir`), and everything else (`.skillsmith-parked/`, stray files, links:
 * not listed here). The listing must not skip dot names wholesale, or it would
 * miss the probes; the reader's `stagingEntries` rule keeps exactly those two
 * shapes and nothing else, and records the names it kept.
 *
 * A probe never changes an op dir's state and never blocks an update. This
 * module only lists them: removing one is a `rmdir` that a later doctor action
 * does under lock 1.
 *
 * All reads go through the reader. This module has no `fs`.
 *
 * @module @skillsmith/core/services/skill-recovery.opdir
 */
import path from 'node:path'
import { PROBE_NAME } from './skill-recovery.reader.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import type { FileType } from './skill-recovery.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

/** A leftover clock-gate probe in ST. */
export interface ProbeFact {
  name: string
  path: string
  /** What it is now: `dir` for the empty directory the gate made; anything else was put there by someone else. */
  type: FileType | null
  identity: RecordIdentity | null
  /** The errno when it could not be inspected. */
  errno: string | null
}

export type StagingView =
  | { ok: true; opIds: string[]; probes: ProbeFact[] }
  | { ok: false; errno: string }

/** The op dirs and leftover probes of `stagingDir`. */
export function listStaging(r: ClassifierReader, stagingDir: string): StagingView {
  const list = r.list(stagingDir, { name: 'stagingEntries' })
  if (!list.ok) return { ok: false, errno: list.errno }
  const opIds: string[] = []
  const probes: ProbeFact[] = []
  for (const name of list.names) {
    const p = path.join(stagingDir, name)
    const st = r.stat(p)
    if (PROBE_NAME.test(name)) {
      probes.push({
        name,
        path: p,
        type: st.ok ? st.type : null,
        identity: st.ok ? st.identity : null,
        errno: st.ok ? null : st.errno,
      })
      continue
    }
    // Only a real directory is an op dir; a link is never followed, a file is not one.
    if (st.ok && st.type === 'dir') opIds.push(name)
  }
  return { ok: true, opIds, probes }
}
