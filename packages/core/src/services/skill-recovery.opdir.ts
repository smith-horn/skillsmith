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
 * 6a-iii: `analyzeParkIntent` judges a `park-intent.json` (and its temp) found
 * beside a record, which a cross-device finish that stopped leaves behind;
 * `noRecordIntent` judges one in an op dir with no record (an update that
 * removed it, or a cross-device `--clean-staging`, which never had one), which
 * `--apply`/`--undo` then finish by parking the op dir as the intent says.
 *
 * All reads go through the reader. This module has no `fs`.
 *
 * @module @skillsmith/core/services/skill-recovery.opdir
 */
import path from 'node:path'
import { PROBE_NAME } from './skill-recovery.reader.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import type { FileType, NoRecordIntent, OpFacts } from './skill-recovery.types.js'
import { KIND_ROLE } from './skill-recovery.pstate.js'
import { backupAreaPath, rootKeyOf } from './skill-swap.area.js'
import { isParkIntentFor } from './skill-swap.intent-schema.js'
import { OWNER_FILE, PARK_INTENT_FILE } from './skill-swap.types.js'
import type { RecordIdentity, SwapRecord } from './skill-swap.types.js'

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

const INTENT_CAP = 4096

/** One read of an intent file: whether it is this op's `move-source` intent, and whether it is empty. */
function intentFile(r: ClassifierReader, p: string, rec: SwapRecord) {
  const read = r.readFile(p, INTENT_CAP)
  const st = r.stat(p)
  let value: unknown = null
  if (read.bytes !== null && read.fact.ok && !read.fact.truncated) {
    try {
      value = JSON.parse(read.bytes.toString('utf8'))
    } catch {
      value = null
    }
  }
  const valid =
    isParkIntentFor(value, rec.opId, rec.opDirIdentity) &&
    (value as { kind: string }).kind === 'move-source'
  const empty =
    st.ok && st.type === 'file' && st.nlink === 1 && read.fact.ok && read.fact.size === 0
  return { valid, empty }
}

/** `park-intent.json` and its temp beside a record (6a-iii: a cross-device finish that stopped). */
export function analyzeParkIntent(
  r: ClassifierReader,
  opDir: string,
  names: readonly string[],
  rec: SwapRecord
): Pick<OpFacts, 'parkIntent' | 'parkIntentTmp'> {
  const at = (n: string) => path.join(opDir, n)
  const intent = names.includes(PARK_INTENT_FILE)
    ? { path: at(PARK_INTENT_FILE), valid: intentFile(r, at(PARK_INTENT_FILE), rec).valid }
    : null
  const tmpName = `${PARK_INTENT_FILE}.tmp`
  let tmp: OpFacts['parkIntentTmp'] = null
  if (names.includes(tmpName)) {
    const f = intentFile(r, at(tmpName), rec)
    tmp = { path: at(tmpName), provable: f.valid || f.empty }
  }
  return { parkIntent: intent, parkIntentTmp: tmp }
}

/** `blocked` for an abort-new intent whose entries are its own: `--apply`/`--undo` never finish it. */
export const ABORT_NEW_BLOCK = 'an abort-new intent: --clean-staging finishes it'

/** The directories a recorded op keeps its trees in: what a no-record park may carry. */
const SOURCE_NAMES: ReadonlySet<string> = new Set(['old', 'new', 'undone'])

const oneComponent = (c: string | undefined): c is string =>
  c !== undefined && c !== '' && c !== '.' && c !== '..' && !c.includes('/') && !c.includes('\0')

/** `<opId>` (the backup) or `<opId>.<kind>` with an optional `.<k>`: a kept copy's name. */
function isKeptName(name: string, opId: string): boolean {
  if (name === opId) return true
  if (!name.startsWith(`${opId}.`)) return false
  const parts = name.slice(opId.length + 1).split('.')
  if (parts.length > 2 || !Object.hasOwn(KIND_ROLE, parts[0]!)) return false
  return parts.length === 1 || /^[1-9][0-9]*$/.test(parts[1]!)
}

/**
 * Where a move-source intent's `backupPath` puts the state root, client and
 * folder: it must be `<stateRoot>/backups/update/<client>/<rootKey of R>/<dirName>/<opId>`
 * (or `<opId>.<kind>`, a kept copy of another kind) exactly (`backupAreaPath`), or
 * no target is derived.
 */
function intentTarget(backupPath: string, root: string, opId: string): NoRecordIntent['target'] {
  const parts = backupPath.split('/')
  const [id, dirName, key, client, update, backups] = parts.slice(-6).reverse()
  if (id === undefined || !isKeptName(id, opId)) return null
  if (update !== 'update' || backups !== 'backups' || key !== rootKeyOf(root)) return null
  if (!oneComponent(client) || !oneComponent(dirName)) return null
  const stateRoot = parts.slice(0, -6).join('/')
  if (!stateRoot.startsWith('/')) return null
  const area = backupAreaPath(stateRoot, client, root, dirName)
  return path.join(area, id) === backupPath ? { stateRoot, client, dirName } : null
}

/**
 * A no-record op dir's `park-intent.json`, and whether its park can be
 * finished from it. 6b-ii: `temps` are the metadata temps the caller proved
 * this op's (`record.json.tmp`, `park-intent.json.tmp`, a kill inside a
 * metadata publish): they do not block, and the finish unlinks them first.
 */
export function noRecordIntent(
  r: ClassifierReader,
  a: {
    opDir: string
    opId: string
    root: string
    names: readonly string[]
    opIdentity: RecordIdentity
    stateRoots: readonly string[]
    temps?: ReadonlySet<string>
  }
): NoRecordIntent | null {
  if (!a.names.includes(PARK_INTENT_FILE)) return null
  const p = path.join(a.opDir, PARK_INTENT_FILE)
  const read = r.readFile(p, INTENT_CAP)
  let value: unknown = null
  if (read.bytes !== null && read.fact.ok && !read.fact.truncated) {
    try {
      value = JSON.parse(read.bytes.toString('utf8'))
    } catch {
      value = null
    }
  }
  const valid = isParkIntentFor(value, a.opId, a.opIdentity)
  const v = (valid ? value : {}) as { kind?: string; backupPath?: string; owner?: { uid: number } }
  const backupPath = v.backupPath ?? null
  const target = backupPath === null ? null : intentTarget(backupPath, a.root, a.opId)
  const sources: NoRecordIntent['sources'] = []
  let blocked: string | null = null
  for (const n of [...a.names].sort()) {
    if (n === PARK_INTENT_FILE || a.temps?.has(n) === true) continue
    const st = r.stat(path.join(a.opDir, n))
    if (n === OWNER_FILE) {
      if (!st.ok || st.type !== 'file') blocked ??= `${OWNER_FILE} is not a regular file`
      continue
    }
    if (!SOURCE_NAMES.has(n)) blocked ??= `the op dir also holds ${n}`
    else if (!st.ok || st.type !== 'dir') blocked ??= `${n} is not a directory`
    else sources.push({ name: n, identity: st.identity })
  }
  if (!valid) blocked = 'its park-intent.json does not verify for this op dir'
  // 6b-ii: an abort-new intent's entry checks stand (`--clean-staging` reads them); unblocked, it says who finishes it.
  else if (v.kind !== 'move-source') blocked ??= ABORT_NEW_BLOCK
  else if (target === null) blocked = `its backupPath ${backupPath} is not this root's backup area`
  else if (!a.stateRoots.includes(target.stateRoot)) {
    blocked = `its state root ${target.stateRoot} is not one doctor discovered or was given`
  } else if (sources.length === 0) blocked ??= 'it holds no source to park'
  return {
    path: p,
    valid,
    kind: v.kind ?? null,
    backupPath,
    ownerUid: v.owner?.uid ?? null,
    opIdentity: valid ? a.opIdentity : null,
    target,
    sources,
    blocked,
    raw: valid ? (value as Record<string, unknown>) : null,
  }
}
