/**
 * SMI-6531 (A1 step 6a-iii, GPT-5.6-Sol gate bf-zyg F1): what doctor accepts
 * as "already parked" for an opId whose op dir is gone, read only through the
 * classifier's reader, so the re-plan under lock 1 compares a digest of every
 * read before it syncs anything.
 *
 * Accepted only when, under `ST/.skillsmith-parked/<opId>/`:
 *  - the landing directory is a real directory owned by the effective uid;
 *  - it holds exactly one parked tree `<opId>-<8 hex>` and that tree's
 *    sidecar `<tree>.json`, and nothing else;
 *  - the sidecar has exactly the park's keys (`finishAfterRename`), with
 *    `opId` the requested one, `kind` `move-source` (which only the
 *    `move-source` caller writes, `park-callers.ts`), `rootKey` this root's,
 *    `originPath` this root's `ST/<opId>`, and no `hold` (a held park is not
 *    a finished one); its tree hash, when recorded, is the tree's now;
 *  - the tree holds a `park-intent.json` that verifies for the opId and the
 *    tree's own identity (a rename keeps it), of kind `move-source`, whose
 *    `backupPath` is this root's backup area in a state root doctor
 *    discovered or was given, for the sidecar's client; and otherwise only
 *    the trees an op keeps (`old`, `new`, `undone`).
 *
 * All reads go through the reader. This module has no `fs`.
 *
 * @module @skillsmith/core/services/skill-recovery.parked-check
 */
import path from 'node:path'
import { intentTarget } from './skill-recovery.opdir.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { rootKeyOf } from './skill-swap.area.js'
import { isParkIntentFor } from './skill-swap.intent-schema.js'
import { PARK_INTENT_FILE } from './skill-swap.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

export type ParkedView =
  | { ok: true; landing: string; copy: string; sidecar: string; identity: RecordIdentity }
  | { ok: false; landing: string; why: string; otherUid: number | null }

const SIDECAR_CAP = 64 * 1024
const INTENT_CAP = 4096
const REQUIRED = [
  'opId',
  'kind',
  'client',
  'rootKey',
  'originPath',
  'treeHash',
  'bytes',
  'createdAt',
  'skillsmithVersion',
]
const OPTIONAL = ['bytesError', 'postMoveVerified', 'postMoveTreeHash']
const SOURCES: ReadonlySet<string> = new Set(['old', 'new', 'undone'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJson(r: ClassifierReader, p: string, cap: number): unknown {
  const read = r.readFile(p, cap)
  if (read.bytes === null || !read.fact.ok || read.fact.truncated) return undefined
  try {
    return JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

/** Why the park's sidecar is not this op's finished move-source park, or null when it is. */
function sidecarWrong(
  v: unknown,
  a: { opId: string; root: string; stagingDir: string }
): { why: string; client: string | null; treeHash: string | null } {
  const no = (why: string) => ({ why, client: null, treeHash: null })
  if (!isObject(v)) return no('its sidecar is missing or not JSON')
  for (const k of REQUIRED) if (!Object.hasOwn(v, k)) return no(`its sidecar has no ${k}`)
  const extra = Object.keys(v).find((k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k))
  if (extra !== undefined) return no(`its sidecar has ${extra} (a held or foreign park)`)
  if (v.opId !== a.opId) return no('its sidecar names another opId')
  if (v.kind !== 'move-source') return no(`its sidecar's kind is ${String(v.kind)}`)
  if (v.rootKey !== rootKeyOf(a.root)) return no('its sidecar names another skills root')
  if (v.originPath !== path.join(a.stagingDir, a.opId)) {
    return no(`its sidecar's origin is not ${path.join(a.stagingDir, a.opId)}`)
  }
  if (typeof v.client !== 'string') return no("its sidecar's client is not a string")
  if (v.treeHash !== null && typeof v.treeHash !== 'string') {
    return no("its sidecar's treeHash is malformed")
  }
  return { why: '', client: v.client, treeHash: v.treeHash as string | null }
}

/** The parked area of `opId` in this root, judged (see the module comment); null when there is none. */
export function inspectParked(
  r: ClassifierReader,
  a: {
    root: string
    stagingDir: string
    opId: string
    euid: number
    stateRoots: readonly string[]
  }
): ParkedView | null {
  const landing = path.join(a.stagingDir, '.skillsmith-parked', a.opId)
  const bad = (why: string, otherUid: number | null = null): ParkedView => ({
    ok: false,
    landing,
    why,
    otherUid,
  })
  const st = r.stat(landing)
  if (!st.ok) return null
  if (st.type !== 'dir') return bad(`${landing} is not a directory`)
  if (st.uid !== a.euid) return bad(`${landing} belongs to uid ${st.uid}`, st.uid)
  const list = r.list(landing, { name: 'all' })
  if (!list.ok) return bad(`${landing} could not be listed (${list.errno})`)
  const trees = list.names.filter((n) => !n.endsWith('.json'))
  if (trees.length !== 1) return bad(`${landing} holds ${trees.length} parked trees, not one`)
  const tree = trees[0]!
  if (!tree.startsWith(`${a.opId}-`) || !/^[0-9a-f]{8}$/.test(tree.slice(a.opId.length + 1))) {
    return bad(`${tree} is not a parked copy of ${a.opId}`)
  }
  const others = list.names.filter((n) => n !== tree && n !== `${tree}.json`)
  if (others.length > 0 || !list.names.includes(`${tree}.json`)) {
    return bad(`${landing} holds ${others.length > 0 ? others.join(', ') : 'no sidecar'}`)
  }
  const copy = path.join(landing, tree)
  const sidecar = `${copy}.json`
  const cst = r.stat(copy)
  if (!cst.ok || cst.type !== 'dir') return bad(`${copy} is not a directory`)
  const sc = sidecarWrong(parseJson(r, sidecar, SIDECAR_CAP), a)
  if (sc.why !== '') return bad(sc.why)
  const inside = r.list(copy, { name: 'all' })
  if (!inside.ok) return bad(`${copy} could not be listed (${inside.errno})`)
  const stray = inside.names.filter((n) => n !== PARK_INTENT_FILE && !SOURCES.has(n))
  if (stray.length > 0) return bad(`${copy} also holds ${stray.join(', ')}`)
  if (!inside.names.includes(PARK_INTENT_FILE)) return bad(`${copy} has no park intent`)
  if (inside.names.length < 2) return bad(`${copy} holds no source`)
  const intent = parseJson(r, path.join(copy, PARK_INTENT_FILE), INTENT_CAP)
  if (!isParkIntentFor(intent, a.opId, cst.identity) || intent.kind !== 'move-source') {
    return bad(`${copy}'s park intent does not verify`)
  }
  const target = intentTarget(intent.backupPath!, a.root, a.opId)
  if (target === null) return bad("its intent's backupPath is not this root's backup area")
  if (!a.stateRoots.includes(target.stateRoot)) {
    return bad(`its state root ${target.stateRoot} is not one doctor discovered or was given`)
  }
  if (target.client !== sc.client) return bad("its intent's client is not the sidecar's")
  if (sc.treeHash !== null) {
    const h = r.treeHash(copy)
    if (!h.ok || h.hash !== sc.treeHash) return bad(`${copy} no longer hashes to its sidecar`)
  }
  return { ok: true, landing, copy, sidecar, identity: st.identity }
}
