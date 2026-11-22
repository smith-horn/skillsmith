/**
 * SMI-6531 (A1 step 8-i-a-2): what doctor's classifier observes and matches
 * for a fresh install's record (design § 3; plan D2): T's state against the
 * record, the roles N and U, the copies the install's post-claim park set
 * aside (P), and the rows FI0-FI4 with their post-keep forms, FI2′ and FI2u.
 * `skill-recovery.classify.ts` runs the gates shared with an update (the
 * record temp, the park intent, the marker, the manifest, the area, the
 * compared path, AB, an unclassified keep, identity-changed, role conflicts)
 * and asks this module for the rest.
 *
 *  - T (`tStateOfInstall`): `absent`; `new` (a directory with `newIdentity`);
 *    `identity-changed` (another identity, `postTree`'s hash; `new` under
 *    `--accept-identity`); `claim` (an empty directory, neither); `foreign`
 *    (a non-empty one, neither); `not-directory`. The hash test precedes the
 *    claim test; `postTree` is never the empty tree's (the sealer refuses it).
 *  - N is the source with `newIdentity` (or `postTree`'s hash: identity-changed),
 *    a verified keep, or absent; U any directory, a verified keep, or absent.
 *    An install has no O: `old/` in its op dir is a stray (refused at plan
 *    time), and a backup keep of its opId is a conflict.
 *  - P (`observeParked`): the directories of `R/.skillsmith-parked/<opId>/`
 *    named `<dirName>-<8 hex>`. A copy is the published folder when its
 *    identity is `newIdentity` (rename keeps the inode), whatever its sidecar
 *    says: a park killed before its `wx` sidecar write leaves none, and a
 *    `held` park is still set aside and restorable. A sidecar that parses but
 *    names another opId or another kind than `install-rollback`, or one that
 *    does not parse, or a candidate with another identity, is "anything else".
 *
 * Read-only, through the reader only.
 *
 * @module @skillsmith/core/services/skill-recovery.classify.install
 */
import path from 'node:path'
import type { InstallRecord } from './skill-install.record-schema.js'
import { isParkedNameOf, PARKED_DIR_NAME } from '../install/parked-index.name.js'
import { ROLE_DIR, SIDECAR_CAP, STARTED_STATES } from './skill-recovery.pstate.js'
import { originMismatchMessage, parentMissingMessage } from './skill-restore.messages.js'
import { contentsOf, saysDiffers, sidecarVerdict } from './skill-restore.verdict.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { observeTree, sameId } from './skill-recovery.trees.js'
import type {
  InstallRowState,
  KeepGroup,
  OpFacts,
  ParkedCopyFact,
  RoleRes,
  TreeObs,
  TreePosition,
  TState,
} from './skill-recovery.types.js'
import type { EntryState } from './skill-manifest.entry.js'

/** The parked kind of the install's post-claim park (§3.8 row 9). */
const INSTALL_ROLLBACK_KIND = 'install-rollback'

/** How T stands against an install's record (see the module comment). */
export function tStateOfInstall(obs: TreeObs, rec: InstallRecord, acceptIdentity: boolean): TState {
  if (!obs.present) return 'absent'
  if (obs.type !== 'dir') return 'not-directory'
  if (sameId(obs.identity, rec.newIdentity)) return 'new'
  if (obs.hash !== null && obs.hash === rec.postTree) {
    return acceptIdentity ? 'new' : 'identity-changed'
  }
  return obs.empty ? 'claim' : 'foreign'
}

/** The roles resolved, with what stops a row: conflicts, and positions whose identity changed. */
export interface InstallRoles {
  roles: OpFacts['roles']
  conflicts: string[]
  changed: TreePosition[]
}

/**
 * Resolves N and U (O is always absent). `checkSources` is false for a moved
 * record: its trees are kept as they are, so no identity is checked.
 */
export function resolveInstallRoles(
  r: ClassifierReader,
  opDir: string,
  rec: InstallRecord,
  groups: readonly KeepGroup[],
  acceptIdentity: boolean,
  checkSources: boolean
): InstallRoles {
  const conflicts: string[] = []
  const changed: TreePosition[] = []
  if (groups.some((g) => g.role === 'O' && !g.otherCopy && (g.verified || g.state !== null))) {
    conflicts.push('an install keeps no old folder, but the backup area holds one for its opId')
  }
  const one = (role: 'N' | 'U'): RoleRes => {
    const obs = observeTree(r, path.join(opDir, ROLE_DIR[role]))
    const keeps = groups.filter((g) => g.role === role && g.verified)
    if (obs.present) {
      if (obs.type !== 'dir') conflicts.push(`${role} is not a directory`)
      else if (role === 'N' && checkSources && !sameId(obs.identity, rec.newIdentity)) {
        if (obs.hash !== null && obs.hash === rec.postTree) {
          if (!acceptIdentity) changed.push('N')
        } else {
          conflicts.push('N has neither its identity nor its hash')
        }
      }
      if (keeps.length > 0) conflicts.push(`${role} is both a source and a kept copy`)
      const started =
        groups.find((g) => g.role === role && g.state !== null && STARTED_STATES.has(g.state)) ??
        null
      return { kind: 'source', obs, started }
    }
    if (obs.errno !== null) conflicts.push(`${role} could not be inspected (${obs.errno})`)
    if (keeps.length > 1) conflicts.push(`${role} has ${keeps.length} kept copies`)
    if (keeps.length === 1) return { kind: 'kept', keep: keeps[0]! }
    return { kind: 'absent' }
  }
  return { roles: { O: { kind: 'absent' }, N: one('N'), U: one('U') }, conflicts, changed }
}

type SidecarFacts = Pick<ParkedCopyFact, 'sidecar' | 'sidecarError'> & { bytes: Buffer | null }

/** A parked copy's sidecar: what it says (and its bytes, for restore's verdict), or why it could not be read. */
function sidecarOf(r: ClassifierReader, p: string): SidecarFacts {
  const read = r.readFile(`${p}.json`, SIDECAR_CAP + 1)
  if (!read.fact.ok) {
    if (read.fact.errno === 'ENOENT') return { sidecar: null, sidecarError: null, bytes: null }
    return {
      sidecar: null,
      sidecarError: `its sidecar could not be read (${read.fact.errno})`,
      bytes: null,
    }
  }
  const bytes = read.bytes!
  if (read.fact.truncated) return { sidecar: null, sidecarError: 'its sidecar is too large', bytes }
  let v: unknown
  try {
    v = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { sidecar: null, sidecarError: 'its sidecar is not JSON', bytes }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { sidecar: null, sidecarError: 'its sidecar is not a JSON object', bytes }
  }
  const o = v as Record<string, unknown>
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  return {
    sidecar: {
      opId: str(o.opId),
      kind: str(o.kind),
      hold: o.hold === true,
      treeHash: str(o.treeHash),
    },
    sidecarError: null,
    bytes,
  }
}

/**
 * `skillsmith restore`'s verdict on the copy at `p`, asked of restore's own
 * functions on what the reader read (no second read, no restore logic here):
 * the sidecar's bytes (`sidecarVerdict`), the tree hash (`contentsOf`,
 * `saysDiffers`), then the origin's folder, which restore requires to exist
 * and to be the skills root `root` the copy was set aside from. What restore
 * checks at the time it runs, and this does not: a mount inside the copy,
 * its lock, and the target being free (FI4 has the skill path absent, and the
 * strict sidecar's origin name is the copy's, so the target is the skill path).
 */
function restoreOf(
  r: ClassifierReader,
  root: string,
  p: string,
  opId: string,
  bytes: Buffer | null,
  freshHash: string | null
): ParkedCopyFact['restore'] {
  const v = sidecarVerdict(bytes, { copyPath: p, parentName: opId })
  if (!v.ok) return { would: false, reason: v.reason, message: v.message }
  const dir = path.dirname(v.origin)
  const real = r.realpath(dir)
  const st = real.ok ? r.stat(real.path) : null
  if (!real.ok || st === null || !st.ok || st.type !== 'dir') {
    return {
      would: false,
      reason: 'origin-parent-missing',
      message: parentMissingMessage(dir, path.basename(v.origin)),
    }
  }
  if (real.path !== root) {
    const areaDir = path.join(root, PARKED_DIR_NAME)
    return {
      would: false,
      reason: 'origin-mismatch',
      message: originMismatchMessage(p, v.origin, areaDir),
    }
  }
  return { would: true, differs: saysDiffers(v.held, contentsOf(v.sidecar, freshHash)) }
}

/**
 * The candidates in `<root>/.skillsmith-parked/<opId>/` (see the module
 * comment), or why that directory could not be listed. Each candidate's
 * `lstat`, tree hash and sidecar are read through the reader, so the re-plan
 * digest covers them.
 */
export function observeParked(
  r: ClassifierReader,
  root: string,
  rec: InstallRecord
): { ok: true; copies: ParkedCopyFact[] } | { ok: false; error: string } {
  const dir = path.join(root, PARKED_DIR_NAME, rec.opId)
  const listed = r.list(dir, { name: 'all' })
  if (!listed.ok) {
    if (listed.errno === 'ENOENT') return { ok: true, copies: [] }
    return { ok: false, error: `${dir} could not be listed (${listed.errno})` }
  }
  const copies: ParkedCopyFact[] = []
  for (const n of [...listed.names].sort()) {
    if (!isParkedNameOf(n, rec.target.dirName)) continue
    const p = path.join(dir, n)
    const st = r.stat(p)
    const isDir = st.ok && st.type === 'dir'
    const h = isDir ? r.treeHash(p) : null
    const { bytes, ...sidecar } = sidecarOf(r, p)
    copies.push({
      path: p,
      identityMatches: isDir && sameId(st.identity, rec.newIdentity),
      ...sidecar,
      restore: restoreOf(r, root, p, rec.opId, bytes, h !== null && h.ok ? h.hash : null),
    })
  }
  return { ok: true, copies }
}

/** Why a candidate is not the install's own set-aside copy; null when it is. */
function parkedOddity(c: ParkedCopyFact, opId: string): string | null {
  if (!c.identityMatches) return `${c.path} is not the folder the install published`
  if (c.sidecarError !== null) return `${c.path}: ${c.sidecarError}`
  const s = c.sidecar
  if (s !== null && (s.opId !== opId || s.kind !== INSTALL_ROLLBACK_KIND)) {
    return `${c.path}'s sidecar names ${s.kind ?? 'no kind'} of ${s.opId ?? 'no operation'}, not this install's ${INSTALL_ROLLBACK_KIND}`
  }
  return null
}

export type InstallMatch =
  | { ok: true; state: InstallRowState; postKeep: boolean }
  | { ok: false; reason: string }

/** The install row for T, the roles, P and the manifest, or why none matches (design § 3). */
export function matchInstallRow(
  tS: TState,
  roles: OpFacts['roles'],
  parked: readonly ParkedCopyFact[],
  m: EntryState,
  opId: string
): InstallMatch {
  const odd = parked.map((c) => parkedOddity(c, opId)).find((x) => x !== null)
  if (odd !== undefined) return { ok: false, reason: odd }
  const { N, U } = roles
  const none = (x: RoleRes): boolean => x.kind === 'absent'
  const p = parked.length
  if (p > 1) return { ok: false, reason: `${p} copies of this install were set aside` }
  if (p === 1) {
    if (tS === 'absent' && none(N) && none(U) && m === 'pre') {
      return { ok: true, state: 'FI4', postKeep: false }
    }
    return { ok: false, reason: 'a copy of this install was set aside, and something else remains' }
  }
  if (tS === 'absent' && N.kind !== 'absent' && none(U) && m === 'pre') {
    return { ok: true, state: 'FI0', postKeep: N.kind === 'kept' }
  }
  if (tS === 'claim' && N.kind !== 'absent' && none(U) && m === 'pre') {
    return { ok: true, state: 'FI1', postKeep: N.kind === 'kept' }
  }
  if (tS === 'new' && none(N) && none(U)) {
    if (m === 'pre') return { ok: true, state: 'FI2', postKeep: false }
    if (m === 'other') return { ok: true, state: 'FI2prime', postKeep: false }
    return { ok: true, state: 'FI3', postKeep: false }
  }
  if (tS === 'absent' && none(N) && U.kind !== 'absent' && m !== 'post') {
    return { ok: true, state: 'FI2u', postKeep: U.kind === 'kept' }
  }
  if (tS === 'absent' && none(N) && none(U)) {
    return {
      ok: false,
      reason:
        m === 'post'
          ? 'the manifest has the installed entry, but the skill folder is gone'
          : 'nothing of this install is left: the skill path is empty and nothing was kept',
    }
  }
  if (tS === 'foreign') return { ok: false, reason: 'something else is at the skill path' }
  return { ok: false, reason: 'no install row matches the trees and the manifest' }
}
