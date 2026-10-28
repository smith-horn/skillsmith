/**
 * SMI-6531 (A1 step 6a-i): this op's entries in the backup area, the strict
 * sidecar parse, and the publish sub-states (plan §3.3 "Publish sub-states",
 * "The one-device sidecar rewrite", UD38, UD42).
 *
 * An operation's keeps are the entries of its area that `isFullDeviceLeftover`
 * names (the reader's `areaForOp` rule); they come in groups that share a
 * `base` (`<opId>` for the backup, `<opId>.<kind>` with an optional `.<k>` for
 * the rest): the tree, its sidecar `<base>.json`, the sidecar's temp
 * `<base>.json.tmp` and the copy temp `.tmp-<base>`. Each group is checked
 * against the tree it comes from in OP and classified P0-P5 (P2-P4 exist only
 * across devices) or R1-R3 (a kill inside a sidecar rewrite: the one-device
 * one, or, beside a verified copy temp, the cross-device one). A group no
 * sub-state names is `unclassified` with a reason; it is kept and reported, and
 * the resume refuses until the user resolves it.
 *
 * All reads go through the reader. This module has no `fs`.
 *
 * @module @skillsmith/core/services/skill-recovery.pstate
 */
import path from 'node:path'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { observeTree, sameId } from './skill-recovery.trees.js'
import type { KeepGroup, PState, Role, SidecarFacts } from './skill-recovery.types.js'
import type { RecordIdentity, SwapRecord } from './skill-swap.types.js'

/** A sidecar is a few hundred bytes; this is a ceiling, not an expectation. */
const SIDECAR_CAP = 64 * 1024

/** The kinds a tree is kept as and the role each one keeps (PLAN: role resolution). */
export const KIND_ROLE: Readonly<Record<string, Role | null>> = {
  backup: 'O',
  'unused-new': 'N',
  'edited-new': 'N',
  'unrecorded-new': 'N',
  'failed-build': 'N',
  undone: 'U',
  conflict: 'U',
  'abandoned-old': 'O',
  'abandoned-new': 'N',
  'abandoned-undone': 'U',
}

/** `old/`, `new/`, `undone/`: where each role's tree is in OP. */
export const ROLE_DIR: Readonly<Record<Role, string>> = { O: 'old', N: 'new', U: 'undone' }

const SIDECAR_REQUIRED = [
  'opId',
  'kind',
  'dirName',
  'createdAt',
  'treeHash',
  'identity',
  'client',
  'skillsDir',
  'scope',
  'manifestKey',
] as const
const SIDECAR_OPTIONAL = ['treeHashError', 'sourceUnchanged', 'partialCause'] as const
const IDENTITY_KEYS = ['dev', 'ino', 'birthtimeNs', 'fmt'] as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Which entry of an area (`name`) belongs to which group, and as what. */
function groupOf(name: string): {
  base: string
  form: 'tree' | 'sidecar' | 'sidecar-tmp' | 'copy-tmp'
} {
  if (name.startsWith('.tmp-')) return { base: name.slice('.tmp-'.length), form: 'copy-tmp' }
  if (name.endsWith('.json.tmp'))
    return { base: name.slice(0, -'.json.tmp'.length), form: 'sidecar-tmp' }
  if (name.endsWith('.json')) return { base: name.slice(0, -'.json'.length), form: 'sidecar' }
  return { base: name, form: 'tree' }
}

/** The kind a base names: `backup` for `<opId>`, else the part after `<opId>.` up to the next dot. */
export function kindOfBase(base: string, opId: string): string {
  return base === opId ? 'backup' : base.slice(opId.length + 1).split('.')[0]!
}

type ParsedSidecar = {
  ok: true
  kind: string
  opId: string
  dirName: string
  client: string
  skillsDir: string
  scope: string
  manifestKey: string
  treeHash: string | null
  identity: RecordIdentity
}

/** The strict schema of a sidecar (`skill-swap.sidecar.ts`): exactly its keys and types. */
function parseSidecar(bytes: Buffer): ParsedSidecar | { ok: false; why: string } {
  let v: unknown
  try {
    v = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, why: 'not JSON' }
  }
  if (!isObject(v)) return { ok: false, why: 'not an object' }
  const keys = Object.keys(v)
  for (const k of SIDECAR_REQUIRED)
    if (!Object.hasOwn(v, k)) return { ok: false, why: `${k} missing` }
  const known: readonly string[] = [...SIDECAR_REQUIRED, ...SIDECAR_OPTIONAL]
  const extra = keys.find((k) => !known.includes(k))
  if (extra !== undefined) return { ok: false, why: `unknown key ${extra}` }
  for (const k of [
    'opId',
    'kind',
    'dirName',
    'createdAt',
    'client',
    'skillsDir',
    'scope',
    'manifestKey',
  ] as const) {
    if (typeof v[k] !== 'string') return { ok: false, why: `${k} is not a string` }
  }
  if (v.treeHash !== null && typeof v.treeHash !== 'string') {
    return { ok: false, why: 'treeHash is neither a string nor null' }
  }
  const id = v.identity
  if (!isObject(id) || !IDENTITY_KEYS.every((k) => typeof id[k] === 'string')) {
    return { ok: false, why: 'identity is malformed' }
  }
  if (v.treeHashError !== undefined && typeof v.treeHashError !== 'string') {
    return { ok: false, why: 'treeHashError is not a string' }
  }
  if (v.sourceUnchanged !== undefined && typeof v.sourceUnchanged !== 'boolean') {
    return { ok: false, why: 'sourceUnchanged is not a boolean' }
  }
  return {
    ok: true,
    kind: v.kind as string,
    opId: v.opId as string,
    dirName: v.dirName as string,
    client: v.client as string,
    skillsDir: v.skillsDir as string,
    scope: v.scope as string,
    manifestKey: v.manifestKey as string,
    treeHash: v.treeHash as string | null,
    identity: {
      dev: id.dev as string,
      ino: id.ino as string,
      birthtimeNs: id.birthtimeNs as string,
      fmt: id.fmt as string,
    },
  }
}

/**
 * What a sidecar of this op must name besides its opId and kind: the
 * record's skill and root, or (6b-ii) a no-record op dir's attribution, its
 * client-`none` layout when it has none (`keepExpectOf`). `from` words the
 * mismatch ("the record", "the op dir's attribution").
 */
interface SidecarExpect {
  dirName: string
  client: string
  skillsDir: string
  scope: string
  manifestKey: string
  from: string
}

/** A recorded op's sidecar expectations: its record's target. */
export const expectOfRecord = (rec: SwapRecord): SidecarExpect => ({
  dirName: rec.target.dirName,
  client: rec.target.client,
  skillsDir: rec.target.skillsDir,
  scope: rec.target.scope,
  manifestKey: rec.target.manifestKey,
  from: 'the record',
})

/** The sub-states of a keep that began and did not finish: a resume continues it with its kind. */
export const STARTED_STATES: ReadonlySet<string> = new Set([
  'P1',
  'P2',
  'P3',
  'P4',
  'R1',
  'R2',
  'R3',
])

/** Whether a parsed sidecar names this op, this kind, and the expected skill and root. */
function mismatch(s: ParsedSidecar, opId: string, kind: string, e: SidecarExpect): string | null {
  if (s.opId !== opId) return "opId is another operation's"
  if (s.kind !== kind) return `kind ${s.kind} is not the ${kind} its name says`
  for (const k of ['dirName', 'client', 'skillsDir', 'scope', 'manifestKey'] as const) {
    if (s[k] !== e[k]) return `${k} differs from ${e.from}`
  }
  return null
}

function sidecarFacts(
  r: ClassifierReader,
  file: string,
  opId: string,
  kind: string,
  rec: SidecarExpect
): SidecarFacts {
  const read = r.readFile(file, SIDECAR_CAP)
  const dead = (invalid: string): SidecarFacts => ({
    path: file,
    validForOp: false,
    invalid,
    kind: null,
    identity: null,
    treeHash: null,
  })
  if (read.bytes === null || !read.fact.ok) {
    return dead(`could not be read (${read.fact.ok ? 'no bytes' : read.fact.errno})`)
  }
  if (read.fact.truncated) return dead('is larger than a sidecar can be')
  const parsed = parseSidecar(read.bytes)
  if (!parsed.ok) return dead(parsed.why)
  const wrong = mismatch(parsed, opId, kind, rec)
  return {
    path: file,
    validForOp: wrong === null,
    invalid: wrong,
    kind: parsed.kind,
    identity: parsed.identity,
    treeHash: parsed.treeHash,
  }
}

/** Everything one group's classification looks at. */
type GroupInputs = Pick<KeepGroup, 'sidecar' | 'sidecarTmp' | 'dest' | 'copyTmp' | 'src'>

/** The sub-state of one group, or why none names it. */
export function classifyGroup(g: GroupInputs): { state: PState | null; why: string | null } {
  const { sidecar: sc, sidecarTmp: tmp, dest, copyTmp, src } = g
  const srcP = src.present
  const destP = dest.present
  const copyP = copyTmp.present
  const ok = (state: PState) => ({ state, why: null })
  const no = (why: string) => ({ state: null, why })
  const scOk = sc !== null && sc.validForOp

  if (scOk && tmp !== null && tmp.sameInodeAsSidecar) return ok('R3')
  if (sc === null && tmp !== null && tmp.thisOps && srcP && !destP) return ok('R2')
  // R1 beside a copy temp is the cross-device rewrite (`publishTree` step 4c's
  // `rewriteSidecar`, after the copy verified): resumed as R1, then P3 or P2.
  if (scOk && tmp !== null && srcP && !destP) return ok('R1')
  if (sc === null && srcP && !copyP && !destP) return ok('P0')
  if (sc === null) return no('a tree or copy temp has no sidecar')
  if (!scOk) return no(`its sidecar ${sc.invalid ?? 'is invalid'}`)

  if (src.present) {
    if (src.type !== 'dir') return no('its source in the op dir is not a directory')
    if (!sameId(src.identity, sc.identity)) return no("its source's identity is not the sidecar's")
    if (!destP && !copyP) return ok('P1')
    if (!destP && copyP) {
      const sameAsSidecar =
        sc.treeHash !== null &&
        copyTmp.present &&
        copyTmp.hash === sc.treeHash &&
        src.hash === sc.treeHash
      return ok(sameAsSidecar ? 'P3' : 'P2')
    }
    if (dest.present && !copyP) {
      const done = sc.treeHash !== null && dest.hash === sc.treeHash && src.hash === dest.hash
      return done
        ? ok('P4')
        : no('the copy at its destination does not match the sidecar and its source')
    }
    return no('its destination and its copy temp both exist')
  }
  if (dest.present && !copyP) {
    if (dest.type !== 'dir') return no('its destination is not a directory')
    const hashOk = sc.treeHash === null || dest.hash === sc.treeHash
    return hashOk ? ok('P5') : no("its destination does not hash to the sidecar's tree hash")
  }
  return no(destP ? 'its destination and its copy temp both exist' : 'its tree is nowhere')
}

/** A group's tree is verified as a kept copy: P5, the tree's identity the sidecar's (one device), its hash too. */
function verifiedKeep(g: Pick<KeepGroup, 'sidecar' | 'dest' | 'state'>): boolean {
  if (g.state !== 'P5' || g.sidecar === null || !g.dest.present) return false
  const sameDevice = g.sidecar.identity !== null && g.sidecar.identity.dev === g.dest.identity.dev
  // A copy across devices has an identity of its own: its hash is what ties it to the sidecar.
  if (g.sidecar.treeHash === null) return sameDevice && sameId(g.dest.identity, g.sidecar.identity)
  return !sameDevice || sameId(g.dest.identity, g.sidecar.identity)
}

export interface AreaView {
  groups: KeepGroup[]
  /** Why the area could not be listed (not `ENOENT`, which is no area); null when it could. */
  listError: string | null
}

/** This op's keep groups in `area`, each checked against its source in OP and classified. */
export function observeGroups(
  r: ClassifierReader,
  a: { opDir: string; opId: string; area: string; expect: SidecarExpect }
): AreaView {
  const list = r.list(a.area, { name: 'areaForOp', opId: a.opId })
  if (!list.ok) {
    return { groups: [], listError: list.errno === 'ENOENT' ? null : `${a.area}: ${list.errno}` }
  }
  const forms = new Map<string, Set<string>>()
  for (const n of list.names) {
    const { base, form } = groupOf(n)
    forms.set(base, (forms.get(base) ?? new Set()).add(form))
  }
  const groups: KeepGroup[] = []
  for (const base of [...forms.keys()].sort()) {
    const has = forms.get(base)!
    const kind = kindOfBase(base, a.opId)
    const role = KIND_ROLE[kind] ?? null
    const dest = path.join(a.area, base)
    const sidecar = has.has('sidecar')
      ? sidecarFacts(r, `${dest}.json`, a.opId, kind, a.expect)
      : null
    const tmpPath = `${dest}.json.tmp`
    const sidecarTmp = has.has('sidecar-tmp')
      ? tmpFacts(r, tmpPath, `${dest}.json`, a.opId, kind, a.expect)
      : null
    const group: KeepGroup = {
      base,
      destPath: dest,
      kind,
      role,
      sidecar,
      sidecarTmp,
      dest: has.has('tree') ? observeTree(r, dest) : { present: false, errno: null },
      copyTmp: has.has('copy-tmp')
        ? observeTree(r, path.join(a.area, `.tmp-${base}`))
        : { present: false, errno: null },
      src:
        role === null
          ? { present: false, errno: null }
          : observeTree(r, path.join(a.opDir, ROLE_DIR[role])),
      state: null,
      unclassified: null,
      verified: false,
      hashChanged: false,
      crossDevice: false,
    }
    const c = classifyGroup(group)
    group.state = c.state
    group.unclassified = c.why
    group.verified = verifiedKeep(group)
    group.crossDevice =
      c.state === 'P2' || c.state === 'P3' || c.state === 'P4' || group.copyTmp.present
    group.hashChanged =
      c.state === 'P1' &&
      sidecar?.treeHash !== null &&
      group.src.present &&
      group.src.hash !== sidecar?.treeHash
    groups.push(group)
  }
  return { groups, listError: null }
}

/** A sidecar temp: does it parse as this op's sidecar for `dest`, and is it the sidecar's inode or empty? */
function tmpFacts(
  r: ClassifierReader,
  tmpPath: string,
  sidecarPath: string,
  opId: string,
  kind: string,
  rec: SidecarExpect
): NonNullable<KeepGroup['sidecarTmp']> {
  const facts = sidecarFacts(r, tmpPath, opId, kind, rec)
  const st = r.stat(tmpPath)
  const sc = r.stat(sidecarPath)
  const same =
    st.ok && sc.ok && st.identity.dev === sc.identity.dev && st.identity.ino === sc.identity.ino
  return {
    path: tmpPath,
    thisOps: facts.validForOp,
    treeHash: facts.treeHash,
    identity: facts.identity,
    sameInodeAsSidecar: same,
    emptySingleLink: st.ok && st.type === 'file' && st.nlink === 1 && emptyFile(r, tmpPath),
  }
}

/** A zero-byte regular file: the bytes read, through the reader, are none. */
function emptyFile(r: ClassifierReader, p: string): boolean {
  const read = r.readFile(p, 1)
  return read.fact.ok && read.fact.size === 0
}
