/**
 * SMI-6531 (A1 step 6a-i): observing the trees of one update (T, and O, N, U
 * in its op dir) and how they stand against the record (plan §3.3 "Doctor
 * classification").
 *
 * "Old" means a directory, not a symlink, with `oldIdentity`; "new" means one
 * with `newIdentity`. Identity includes the file type (SMI-7130). A present
 * directory whose identity is neither but whose hash is the role's is
 * `identity-changed` (a copy, or a remount); with no identity and no hash it is
 * foreign. Every read goes through the reader, so what is observed here is in
 * the re-plan digest.
 *
 * @module @skillsmith/core/services/skill-recovery.trees
 */
import type { ClassifierReader } from './skill-recovery.reader.js'
import type { TreeObs, TState } from './skill-recovery.types.js'
import type { RecordIdentity, SwapRecord } from './skill-swap.types.js'

/** Equal only when all four fields match and the file type is present (fail closed). */
export function sameId(a: RecordIdentity | null, b: RecordIdentity | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.fmt !== '' &&
    a.fmt === b.fmt &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs
  )
}

/** The tree at `p`: its type and identity, and, for a directory, whether it is empty and its hash. */
export function observeTree(r: ClassifierReader, p: string): TreeObs {
  const st = r.stat(p)
  if (!st.ok) {
    return {
      present: false,
      errno: st.errno === 'ENOENT' || st.errno === 'ENOTDIR' ? null : st.errno,
    }
  }
  if (st.type !== 'dir') {
    return {
      present: true,
      type: st.type,
      identity: st.identity,
      empty: false,
      hash: null,
      hashError: null,
    }
  }
  const names = r.list(p, { name: 'all' })
  const h = r.treeHash(p)
  return {
    present: true,
    type: 'dir',
    identity: st.identity,
    empty: names.ok && names.names.length === 0,
    hash: h.ok ? h.hash : null,
    hashError: h.ok ? null : `${h.reason} at ${h.path}`,
  }
}

/** How T stands against the record. `acceptIdentity` waives identity: hashes then tell old from new. */
export function tStateOf(obs: TreeObs, rec: SwapRecord, acceptIdentity: boolean): TState {
  if (!obs.present) return 'absent'
  if (obs.type !== 'dir') return 'not-directory'
  if (sameId(obs.identity, rec.oldIdentity)) return 'old'
  if (sameId(obs.identity, rec.newIdentity)) return 'new'
  if (obs.hash !== null && (obs.hash === rec.preTree || obs.hash === rec.postTree)) {
    if (!acceptIdentity) return 'identity-changed'
    return obs.hash === rec.preTree ? 'old' : 'new'
  }
  return obs.empty ? 'claim' : 'foreign'
}

export type SourceCheck = 'ok' | 'identity-changed' | 'foreign' | 'not-directory'

/**
 * Whether a tree in OP is the role's: O must have `oldIdentity`, N `newIdentity`;
 * U has none recorded (it is T's set-aside tree, new or foreign), so any
 * directory is U. A different identity with the role's hash is `identity-changed`.
 */
export function sourceCheck(
  role: 'O' | 'N' | 'U',
  obs: Extract<TreeObs, { present: true }>,
  rec: SwapRecord,
  acceptIdentity: boolean
): SourceCheck {
  if (obs.type !== 'dir') return 'not-directory'
  if (role === 'U') return 'ok'
  const want = role === 'O' ? rec.oldIdentity : rec.newIdentity
  const wantHash = role === 'O' ? rec.preTree : rec.postTree
  if (sameId(obs.identity, want)) return 'ok'
  if (obs.hash !== null && obs.hash === wantHash) return acceptIdentity ? 'ok' : 'identity-changed'
  return 'foreign'
}
