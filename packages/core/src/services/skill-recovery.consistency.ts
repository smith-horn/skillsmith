/**
 * SMI-6531 (A1 steps 6a-i, 6b-iii): the checks a verified record goes through
 * before its op is observed (plan §3.3 "Doctor classification",
 * `inconsistent-record`, `recovery-moved`; design `step6b-design.md` § 1.3
 * "The classifier for `moved`").
 *
 *  - `movedOf`: the record belongs to another root or op dir (`foreign-op-dir`,
 *    `foreign-root`, `root-identity`, `op-dir-identity`), or null.
 *  - `inconsistency`: the record is not internally consistent. Its checks are
 *    keyed by the record's own skills root (`target.skillsDir`), not the
 *    scanned one, so they run the same for a moved record; for any other
 *    record that root is R.
 *
 * Read-only, through the reader only (this module has no `fs`).
 *
 * @module @skillsmith/core/services/skill-recovery.consistency
 */
import path from 'node:path'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { sameId } from './skill-recovery.trees.js'
import type { MovedWhy } from './skill-recovery.types.js'
import { backupAreaPath } from './skill-swap.area.js'
import type { RecordIdentity, SwapRecord } from './skill-swap.types.js'

/** One path component: not empty, not `.`/`..`, no separator or NUL. */
const oneComponent = (s: string): boolean =>
  s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0')

/** The native real path of the record's state root, `dirname(manifestPath)` (or its resolved spelling). */
export function stateRealOf(r: ClassifierReader, rec: SwapRecord): string {
  const stateDir = path.dirname(rec.target.manifestPath)
  const real = r.realpath(stateDir)
  return real.ok ? real.path : path.resolve(stateDir)
}

/** `record.json` is internally consistent (see the module comment); the reason, or null. */
export function inconsistency(r: ClassifierReader, rec: SwapRecord): string | null {
  const t = rec.target
  const root = t.skillsDir
  if (rec.op !== 'update') return `its op is ${JSON.stringify(rec.op)}, not "update"`
  for (const [name, v] of [
    ['client', t.client],
    ['scope', t.scope],
    ['dirName', t.dirName],
  ] as const) {
    if (!oneComponent(v)) return `${name} ${JSON.stringify(v)} is not a single path component`
  }
  if (t.dirName !== path.basename(t.comparedPath)) return 'dirName is not the name of comparedPath'
  if (!path.isAbsolute(t.manifestPath) || path.basename(t.manifestPath) !== 'manifest.json') {
    return 'manifestPath is not an absolute path to a manifest.json'
  }
  if (path.dirname(t.realDir) !== root) return 'realDir is not directly inside the skills root'
  const area = backupAreaPath(stateRealOf(r, rec), t.client, root, t.dirName)
  if (rec.backupDest !== path.join(area, rec.opId)) {
    return 'backupDest is not the backup area the update computes for it, plus its opId'
  }
  if (
    !r.portAccepts({
      manifestPath: t.manifestPath,
      manifestKey: t.manifestKey,
      preEntry: rec.preEntry,
      postEntry: rec.postEntry,
    }).ok
  ) {
    return 'the manifest port rejects its preEntry and postEntry'
  }
  return null
}

/** Why a verified record belongs elsewhere: its verdict and the words for it. */
export interface MovedVerdict {
  why: MovedWhy
  detail: string
}

/**
 * Why the verified record in op dir `opId` (identity `opIdentity`) of the
 * skills root `root` belongs to another root or op dir, or null when it is
 * this one's.
 */
export function movedOf(
  r: ClassifierReader,
  root: string,
  opId: string,
  rec: SwapRecord,
  opIdentity: RecordIdentity
): MovedVerdict | null {
  if (rec.opId !== opId) {
    return { why: 'foreign-op-dir', detail: `the record names operation ${rec.opId}` }
  }
  if (rec.target.skillsDir !== root) {
    return {
      why: 'foreign-root',
      detail: `the record names the skills root ${rec.target.skillsDir}`,
    }
  }
  const rootNow = r.stat(root)
  if (!rootNow.ok || !sameId(rec.rootIdentity, rootNow.identity)) {
    return {
      why: 'root-identity',
      detail: 'the skills root is not the one the record was written for',
    }
  }
  if (!sameId(rec.opDirIdentity, opIdentity)) {
    return {
      why: 'op-dir-identity',
      detail: 'the op dir is not the one the record was written for',
    }
  }
  return null
}
