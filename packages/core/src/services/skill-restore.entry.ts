/**
 * SMI-6531 (A1 step 6d-ii, design note §5.3, PLAN:2108-2118): restoring a
 * parked regular file or symlink with a no-replace primitive. `rename` would
 * silently replace whatever now sits at the origin, so a file is put back with
 * `link` (which fails `EEXIST`) and the parked name is unlinked only after both
 * names are shown to be the same entry; a symlink is recreated with `symlink`,
 * never `link`, because whether `link` follows a symlink differs across
 * platforms. `fs` is the default import, looked up at each call, so a spy
 * installed on it sees every call.
 *
 * @module @skillsmith/core/services/skill-restore.entry
 */
import fs from 'node:fs'
import path from 'node:path'
import type { RootIdentity } from '../install/prune.job.js'

export type EntryFailure = {
  ok: false
  code: 'plan-changed' | 'origin-occupied' | 'restore-failed' | 'link-stopped' | 'unlink-failed'
  message: string
  /** True when something was created at the origin before the stop. */
  changed: boolean
}
export type EntryOutcome = { ok: true; warnings: string[] } | EntryFailure

export interface EntryArgs {
  copyPath: string
  /** Where the writes go: the bound real path. */
  target: string
  /** What messages call it: the record's own spelling of the origin. */
  display: string
  rid: RootIdentity
  /** Called immediately before every write; throws to stop. */
  guard: () => void
  /** Called as soon as something exists at the origin. */
  onChanged: () => void
  /** @internal Test seam: runs after the new name exists, before the check. */
  afterLink?: () => void
}

const errno = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'

const fail = (code: EntryFailure['code'], message: string, changed: boolean): EntryFailure => ({
  ok: false,
  code,
  message,
  changed,
})

/** The parked entry is still the one the listing bound. */
function stillBound(st: fs.BigIntStats, rid: RootIdentity, birth: boolean): boolean {
  return (
    st.dev === rid.dev &&
    st.ino === rid.ino &&
    (st.mode & 0o170000n) === rid.fmt &&
    (!birth || st.birthtimeNs === rid.birthtimeNs)
  )
}

const lstatBig = (p: string): fs.BigIntStats | null => {
  try {
    return fs.lstatSync(p, { bigint: true })
  } catch {
    return null
  }
}

/** Best-effort directory sync; the errno on failure, else null. */
function trySync(dir: string): string | null {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return null
  } catch (err) {
    return errno(err)
  }
}

function syncWarnings(a: EntryArgs): string[] {
  const out: string[] = []
  for (const d of [path.dirname(a.target), path.dirname(a.copyPath)]) {
    const e = trySync(d)
    if (e !== null) {
      out.push(
        `Restored, but \`${d}\` could not be synced (${e}); it may not survive a power loss.`
      )
    }
  }
  return out
}

/** What "both names" are, by type (design note §5.3 F4 and S5). */
export const sameEntryText = (type: 'file' | 'symlink'): string =>
  type === 'file' ? 'Both names are the same entry' : 'Both are links with the same text'

const gone = (a: EntryArgs, e: string, type: 'file' | 'symlink'): string =>
  `Restored to \`${a.display}\`, but the set-aside name \`${a.copyPath}\` could not be removed (${e}). ${sameEntryText(type)}; remove \`${a.copyPath}\` and its \`.json\` by hand.`

const stopped = (a: EntryArgs): string =>
  `Restore stopped: \`${a.display}\` was created, but \`${a.copyPath}\` changed at the same time, so it was left in place. Check both paths: \`${a.display}\` and \`${a.copyPath}\`.`

export function restoreFileEntry(a: EntryArgs): EntryOutcome {
  const f1 = lstatBig(a.copyPath)
  if (f1 === null || !stillBound(f1, a.rid, true)) {
    return fail('plan-changed', `\`${a.copyPath}\` changed after you confirmed.`, false)
  }
  a.guard()
  try {
    fs.linkSync(a.copyPath, a.target)
  } catch (err) {
    return errno(err) === 'EEXIST'
      ? fail('origin-occupied', `Something already exists at \`${a.display}\`.`, false)
      : fail('restore-failed', `Could not restore \`${a.display}\` (${errno(err)}).`, false)
  }
  a.onChanged()
  a.afterLink?.()
  const lo = lstatBig(a.target)
  const lc = lstatBig(a.copyPath)
  const same =
    lo !== null &&
    lc !== null &&
    lo.dev === lc.dev &&
    lo.ino === lc.ino &&
    (lo.mode & 0o170000n) === (lc.mode & 0o170000n) &&
    stillBound(lc, a.rid, false)
  if (!same) return fail('link-stopped', stopped(a), true)
  a.guard()
  try {
    fs.unlinkSync(a.copyPath)
  } catch (err) {
    return fail('unlink-failed', gone(a, errno(err), 'file'), true)
  }
  return { ok: true, warnings: syncWarnings(a) }
}

export function restoreSymlinkEntry(a: EntryArgs): EntryOutcome {
  const s1 = lstatBig(a.copyPath)
  if (s1 === null || !stillBound(s1, a.rid, true)) {
    return fail('plan-changed', `\`${a.copyPath}\` changed after you confirmed.`, false)
  }
  let text: string
  try {
    text = fs.readlinkSync(a.copyPath)
  } catch (err) {
    return fail('restore-failed', `Could not read \`${a.copyPath}\` (${errno(err)}).`, false)
  }
  a.guard()
  try {
    fs.symlinkSync(text, a.target)
  } catch (err) {
    return errno(err) === 'EEXIST'
      ? fail('origin-occupied', `Something already exists at \`${a.display}\`.`, false)
      : fail('restore-failed', `Could not restore \`${a.display}\` (${errno(err)}).`, false)
  }
  a.onChanged()
  a.afterLink?.()
  const lo = lstatBig(a.target)
  let nowText: string | null = null
  try {
    nowText = fs.readlinkSync(a.target)
  } catch {
    nowText = null
  }
  const lc = lstatBig(a.copyPath)
  const same =
    lo !== null &&
    lo.isSymbolicLink() &&
    nowText === text &&
    lc !== null &&
    stillBound(lc, a.rid, false)
  if (!same) return fail('link-stopped', stopped(a), true)
  a.guard()
  try {
    fs.unlinkSync(a.copyPath)
  } catch (err) {
    return fail('unlink-failed', gone(a, errno(err), 'symlink'), true)
  }
  return { ok: true, warnings: syncWarnings(a) }
}
