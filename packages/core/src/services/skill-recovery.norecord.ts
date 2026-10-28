/**
 * SMI-6531 (A1 steps 6a-i, 6a-iii, 6b-ii): the classifier's reading of an op
 * dir with no `record.json` (class `no-record`), moved out of
 * `skill-recovery.classify.ts`; design `step6b-design.md` § 1.2, O1, O2.
 *
 * Besides the owner, the entries and a park intent (6a), it reads what
 * `--clean-staging` needs, all through the reader so the re-plan digest
 * covers it:
 *  - **the owner verdict** (`same-host-dead`, `same-host-alive`,
 *    `other-host`, `unparseable`, `absent`): `owner.json`'s `{ pid, host }`
 *    against this host's name and the injected pid probe (`ctx.ownerProbe`;
 *    `EPERM` counts as alive). It is not a read, so the serialized plan
 *    carries it instead (`skill-recovery.plan.clean.ts`);
 *  - **the provable temps**: a `record.json.tmp` that parses as this op's
 *    record for OP's identity, a `park-intent.json.tmp` that verifies as this
 *    op's intent, or either as an empty regular file with one link
 *    (PLAN:1571-1574). Anything else is not provable;
 *  - **the first entry doctor cannot prove it wrote** (O2): anything but
 *    `new/` (a directory), `owner.json` (a regular file), a provable temp and
 *    a verifying `park-intent.json`. Without a verifying intent (which names
 *    and carries its sources), `old/` and `undone/` are among them: only an
 *    update with a record leaves them, and an `unrecorded-new` keep is a keep
 *    of the staged tree, role N (`KIND_ROLE`), so a resumed keep of either
 *    would have no source in the role table;
 *  - **O1's attribution** (`resolveAttribution`, all or nothing, from
 *    `owner.json` and a verifying intent), the area it routes a keep to, and
 *    this op's keep groups there (`observeGroups`, each sidecar checked
 *    against the attribution's fields): a keep abort cleanup started is
 *    resumed with its own kind;
 *  - **`new/`'s resolution**: a source (with its started keep), one verified
 *    keep, or absent.
 *
 * Read-only, through the reader only (this module has no `fs`).
 *
 * @module @skillsmith/core/services/skill-recovery.norecord
 */
import path from 'node:path'
import { keepAreaOf, keepExpectOf, resolveAttribution } from './skill-recovery.attribution.js'
import type { ClassifyContext } from './skill-recovery.classify.js'
import type { NoRecordObservation, OwnerProbe, OwnerVerdict } from './skill-recovery.clean.types.js'
import { OWNER_CAP } from './skill-recovery.observe.js'
import { ABORT_NEW_BLOCK, noRecordIntent } from './skill-recovery.opdir.js'
import { observeGroups, STARTED_STATES } from './skill-recovery.pstate.js'
import type { ClassifierReader } from './skill-recovery.reader.js'
import { observeTree, sameId } from './skill-recovery.trees.js'
import type { KeepGroup, NoRecordIntent, RecoveryClass, RoleRes } from './skill-recovery.types.js'
import { INTENT_CAP, isParkIntentFor } from './skill-swap.intent-schema.js'
import { MAX_RECORD_BYTES, parseRecordBytes } from './skill-swap.record-schema.js'
import { NEW_DIR, OWNER_FILE, PARK_INTENT_FILE, RECORD_FILE } from './skill-swap.types.js'
import type { RecordIdentity } from './skill-swap.types.js'

const INTENT_TMP = `${PARK_INTENT_FILE}.tmp`
const RECORD_TMP = `${RECORD_FILE}.tmp`
const TEMP_CAP = { [RECORD_TMP]: MAX_RECORD_BYTES + 1, [INTENT_TMP]: INTENT_CAP } as const

/** Parses bytes as a JSON object, or null. */
function objectOf(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null
  try {
    const v: unknown = JSON.parse(bytes.toString('utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The verdict on `owner.json`'s owner (see the module comment), with its words. */
function ownerVerdict(
  present: boolean,
  o: Record<string, unknown> | null,
  probe: OwnerProbe | undefined
): { verdict: OwnerVerdict; why: string } {
  if (!present) {
    return {
      verdict: 'absent',
      why: 'the op dir has no owner.json, so who made it is not recorded',
    }
  }
  const pid = o?.pid
  const host = o?.host
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== 'string'
  ) {
    return {
      verdict: 'unparseable',
      why: 'owner.json does not name a pid and a host, so its owner cannot be checked',
    }
  }
  const claim = `owner.json names pid ${pid} on host ${host}`
  if (probe === undefined || host !== probe.host) {
    return {
      verdict: 'other-host',
      why: `${claim}, not this host${probe === undefined ? '' : ` (${probe.host})`}: its pid cannot be checked here`,
    }
  }
  return probe.alive(pid) === false
    ? { verdict: 'same-host-dead', why: `${claim}, this host, and that pid is not running` }
    : {
        verdict: 'same-host-alive',
        why: `${claim}, this host, and that pid is running (or cannot be signalled, which counts as running)`,
      }
}

/** Whether a metadata temp is this op's: it parses as this op's file for OP's identity, or is empty. */
function tempProvable(
  r: ClassifierReader,
  file: string,
  name: string,
  opId: string,
  opIdentity: RecordIdentity
): boolean {
  const st = r.stat(file)
  if (!st.ok || st.type !== 'file') return false
  const read = r.readFile(file, TEMP_CAP[name as keyof typeof TEMP_CAP])
  if (!read.fact.ok || read.fact.truncated || read.bytes === null) return false
  if (read.fact.size === 0) return st.nlink === 1
  if (name === RECORD_TMP) {
    const p = parseRecordBytes(read.bytes)
    return p.ok && p.record.opId === opId && sameId(p.record.opDirIdentity, opIdentity)
  }
  return isParkIntentFor(objectOf(read.bytes), opId, opIdentity)
}

/** Why an entry is not one doctor can prove it wrote (O2), or null when it is. */
function unprovableWhy(
  name: string,
  type: string | null,
  temps: ReadonlySet<string>,
  intent: NoRecordIntent | null
): string | null {
  if (name === NEW_DIR) return type === 'dir' ? null : 'new is not a directory'
  if (name === OWNER_FILE) return type === 'file' ? null : 'owner.json is not a regular file'
  if (name === PARK_INTENT_FILE) {
    return intent?.valid === true ? null : 'park-intent.json does not verify for this op dir'
  }
  if (name === RECORD_TMP || name === INTENT_TMP) {
    return temps.has(name) ? null : `${name} is not provably this operation's`
  }
  if (name === 'old' || name === 'undone') {
    // A verifying intent names its sources (a cross-device finish's verified copies): it carries them.
    if (intent?.valid === true) return type === 'dir' ? null : `${name} is not a directory`
    return `${name}/ is a folder only an update with a record leaves; without one doctor cannot tell what it is`
  }
  return `${name} is not a file an update writes`
}

/** `new/` resolved to a source (with its started keep), one verified keep, or nothing. */
function resolveN(
  r: ClassifierReader,
  opDir: string,
  groups: readonly KeepGroup[]
): { n: RoleRes; conflict: string | null } {
  const obs = observeTree(r, path.join(opDir, NEW_DIR))
  const keeps = groups.filter((g) => g.role === 'N' && g.verified)
  if (obs.present) {
    const started =
      groups.find((g) => g.role === 'N' && g.state !== null && STARTED_STATES.has(g.state)) ?? null
    const conflict = keeps.length > 0 ? 'new is both in the op dir and a kept copy' : null
    return { n: { kind: 'source', obs, started }, conflict }
  }
  if (obs.errno !== null)
    return { n: { kind: 'absent' }, conflict: `new could not be inspected (${obs.errno})` }
  if (keeps.length > 1)
    return { n: { kind: 'absent' }, conflict: `new has ${keeps.length} kept copies` }
  return keeps.length === 1
    ? { n: { kind: 'kept', keep: keeps[0]! }, conflict: null }
    : { n: { kind: 'absent' }, conflict: null }
}

/** Why `--clean-staging` cannot finish a verifying intent's park; null when it can. */
function intentBlockedOf(i: NoRecordIntent, names: readonly string[]): string | null {
  if (i.kind === 'move-source') return i.blocked
  // abort-new (abort cleanup step 6): it parks `new/` and the intent, nothing else.
  if (i.sources.length !== 1 || i.sources[0]!.name !== NEW_DIR || !names.includes(NEW_DIR)) {
    return (
      'an abort-new intent parks new/ alone, and this op dir holds ' +
      (i.sources.map((s) => `${s.name}/`).join(', ') || 'no new/')
    )
  }
  // Its other entry checks (an extra entry, owner.json not a file) are `noRecordIntent`'s.
  return i.blocked === ABORT_NEW_BLOCK ? null : i.blocked
}

/** An op dir with no `record.json` (see the module comment). */
export function noRecord(
  r: ClassifierReader,
  ctx: ClassifyContext,
  base: { opId: string; opDir: string },
  names: readonly string[],
  opIdentity: RecordIdentity
): RecoveryClass {
  const { opId, opDir } = base
  const ownerRead = names.includes(OWNER_FILE)
    ? r.readFile(path.join(opDir, OWNER_FILE), OWNER_CAP)
    : null
  const ownerObj = objectOf(ownerRead?.bytes ?? null)
  const owner =
    ownerRead === null || ownerRead.bytes === null
      ? null
      : {
          pid: typeof ownerObj?.pid === 'number' ? ownerObj.pid : null,
          host: typeof ownerObj?.host === 'string' ? ownerObj.host : null,
          uid: typeof ownerObj?.uid === 'number' ? ownerObj.uid : null,
        }
  const sorted = [...names].sort()
  const entries = sorted.map((name) => ({ name, stat: r.stat(path.join(opDir, name)) }))
  const temps = new Set(
    [RECORD_TMP, INTENT_TMP].filter(
      (n) => names.includes(n) && tempProvable(r, path.join(opDir, n), n, opId, opIdentity)
    )
  )
  const stateRoots = ctx.stateRoots ?? []
  const intent = noRecordIntent(r, {
    ...base,
    root: ctx.root,
    names,
    opIdentity,
    stateRoots,
    temps,
  })
  // Whose op dir this is: owner.json's uid, else the verifying intent's (6a-iii).
  const uid = owner?.uid ?? (intent?.valid === true ? intent.ownerUid : null)
  const attribution = resolveAttribution({
    owner: ownerObj,
    intent: intent?.raw ?? null,
    stateRoots,
  })
  const area = keepAreaOf(attribution, ctx.root, opId)
  const view =
    area === null
      ? { groups: [], listError: null }
      : observeGroups(r, {
          opDir,
          opId,
          area,
          expect: {
            ...keepExpectOf(attribution, ctx.root, opId),
            from: "the op dir's attribution",
          },
        })
  const { n, conflict } = resolveN(r, opDir, view.groups)
  const unclassified = view.groups.find((g) => g.role === 'N' && g.unclassified !== null)
  const { verdict, why } = ownerVerdict(ownerRead !== null, ownerObj, ctx.ownerProbe)
  let unprovable: NoRecordObservation['unprovable'] = null
  for (const e of entries) {
    const w = unprovableWhy(e.name, e.stat.ok ? e.stat.type : null, temps, intent)
    if (w !== null) {
      unprovable = { name: e.name, why: w }
      break
    }
  }
  const clean: NoRecordObservation = {
    opIdentity,
    verdict,
    verdictWhy: why,
    attribution,
    area,
    entries,
    temps: [...temps].sort().map((t) => path.join(opDir, t)),
    unprovable,
    n,
    groups: view.groups,
    groupsBlocked:
      view.listError !== null
        ? `the backup area could not be listed (${view.listError})`
        : (conflict ??
          (unclassified === undefined
            ? null
            : `${unclassified.base} is kept but ${unclassified.unclassified}`)),
    intentBlocked: intent === null || !intent.valid ? null : intentBlockedOf(intent, names),
  }
  return {
    kind: 'no-record',
    ...base,
    owner,
    entries: [...names],
    hasParkIntent: names.includes(PARK_INTENT_FILE),
    otherUid: uid !== null && uid !== ctx.euid ? uid : null,
    intent,
    recordTmp: names.includes(RECORD_TMP) ? path.join(opDir, RECORD_TMP) : null,
    clean,
  }
}
