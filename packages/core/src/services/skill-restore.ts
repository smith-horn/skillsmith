/**
 * SMI-6531 (A1 step 6d-ii): `planRestore`, the lock-free half of
 * `skillsmith restore <id>` (design note §4). It reads the whole machine's
 * set-aside copies with `listBackups`, resolves `<id>` to one copy, applies the
 * refusals in §4.3's order, chooses the lock from the origin's current skills
 * root (§4.1a) and digests everything the confirmation covers (§4.4). It takes
 * no lock and writes nothing; `executeRestore` re-plans under the lock and
 * compares digests.
 *
 * @module @skillsmith/core/services/skill-restore
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseSidecarStrict } from '../install/prune.sidecar.js'
import { PARKED_DIR } from '../install/prune.list.parked.js'
import { classifyCopy, type Classification } from '../install/prune.classify.js'
import type { ListedCopy } from '../install/prune.list.types.js'
import type { LockAssignment } from '../install/prune.plan.types.js'
import { readIndexes, type IndexedLine } from './skill-backups.areas.js'
import { listBackups, type ListBackupsOptions } from './skill-backups.listing.js'
import { discoverRoots, type Discovery } from './skill-recovery.discover.js'
import { assignLocks } from './skill-backups.locks.js'
import { chooseLock } from './skill-restore.lock.js'
import { restoreClassOf } from './skill-restore.kinds.js'
import { allRows, matchRows, parseId } from './skill-restore.resolve.js'
import type {
  RestorePlan,
  PlanRestoreResult,
  RestoreContents,
  RestorePlanOptions,
  RestoreRefusalReason,
  RestoreType,
} from './skill-restore.types.js'

export type { PlanRestoreResult, RestorePlan } from './skill-restore.types.js'

const S_IFMT = 0o170000n
const TYPE_OF: Record<string, RestoreType> = {
  [String(0o040000n)]: 'directory',
  [String(0o100000n)]: 'file',
  [String(0o120000n)]: 'symlink',
}

const refuse = (
  reason: RestoreRefusalReason,
  message: string
): { status: 'refused'; reason: RestoreRefusalReason; message: string } => ({
  status: 'refused',
  reason,
  message,
})

const sha = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex')

/** `dev:ino` of `p`, `absent`, or the errno: part of the digest. */
export function idOf(p: string): string {
  try {
    const st = fs.lstatSync(p, { bigint: true })
    return `${st.dev}:${st.ino}`
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : `error:${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`
  }
}

/** False when `p` is not a directory, or vanished before it could be read. */
const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const realOf = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * `--root` adds a root to discovery here and never narrows the listing:
 * `listBackups` narrows its rows to a given root, which would hide a copy only
 * the parked index names (the very copy §4.1a's `--root` remedy is for). So
 * discovery is made here and handed over, which the listing never narrows by.
 */
async function discoverFor(o: RestorePlanOptions): Promise<Discovery> {
  return (
    o.discovered ??
    (await discoverRoots({
      ...(o.stateRoot === undefined ? {} : { stateRoot: o.stateRoot }),
      ...(o.roots === undefined || o.roots.length === 0 ? {} : { roots: o.roots }),
      ...o.discovery,
    }))
  )
}

async function listOptions(o: RestorePlanOptions): Promise<ListBackupsOptions> {
  const discovered = await discoverFor(o)
  return {
    ...(o.stateRoot === undefined ? {} : { stateRoot: o.stateRoot }),
    discovered,
    ...(o.discovery === undefined ? {} : { discovery: o.discovery }),
    ...(o.measure === undefined ? {} : { measure: o.measure }),
  }
}

function contentsOf(sidecar: Record<string, unknown>, freshHash: string | null): RestoreContents {
  const recorded = typeof sidecar.treeHash === 'string' ? sidecar.treeHash : null
  if (recorded === null)
    return { state: 'not-checked', why: 'no hash was recorded when it was set aside' }
  if (freshHash === null) return { state: 'not-checked', why: 'the copy could not be hashed now' }
  return { state: recorded === freshHash ? 'unchanged' : 'changed' }
}

export async function planRestore(
  id: string,
  options: RestorePlanOptions = {}
): Promise<PlanRestoreResult> {
  const form = parseId(id)
  if (form.form === 'bad') {
    return refuse(
      'restore-bad-id',
      `\`${id}\` is not a set-aside copy id. Give an op id, \`<opId>/<name>\`, or the full path.`
    )
  }
  const listing = await listBackups(await listOptions(options))
  const matches = matchRows(form, allRows(listing.parked))
  if (matches.length === 0) {
    return refuse(
      'restore-not-found',
      `No set-aside copy matches \`${id}\`. Run \`skillsmith doctor backups\` to list them.`
    )
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => ({
      copyPath: m.row.copy.copyPath,
      kind: m.row.kind,
      origin: m.row.origin,
    }))
    return {
      ...refuse(
        'restore-ambiguous',
        `\`${id}\` names ${matches.length} set-aside copies. Choose one with \`skillsmith restore <opId>/<name>\` or its full path:\n` +
          candidates
            .map(
              (c) => `  ${c.copyPath}  kind ${c.kind ?? 'unknown'}, from ${c.origin ?? 'unknown'}`
            )
            .join('\n')
      ),
      candidates,
    }
  }
  const { row } = matches[0]!
  return evaluate(
    {
      copy: row.copy,
      classification: row.classification,
      bytes: row.apparentBytes,
    },
    {
      discovery: listing.discovery,
      indexLines: listing.index.facts.lines,
      assigned: (await assignLocks(listing)).get(row.copy.copyPath),
    },
    options
  )
}

/**
 * The re-plan under the lock (D12, §5.1 step 3): rediscovery, `classifyCopy` of
 * the one copy, the same checks and the same digest. It makes no whole-machine
 * listing and no `assignLocks` (the note it feeds is not in the digest), so
 * the root's lock is not held across a scan of every area.
 */
export async function replanUnderLock(plan: RestorePlan): Promise<PlanRestoreResult> {
  const { discovered: _stale, ...options } = plan.options
  // Nothing the plan says about where the copy sits is trusted: the area comes from the copy's own
  // listing fields, and those must agree with each other and with the parked layout.
  const inconsistent = copyShapeProblem(plan.copy)
  if (inconsistent !== null) return refuse('plan-changed', inconsistent)
  const discovery = await discoverFor(options)
  const classification = classifyCopy(plan.copy, 'parked')
  return evaluate(
    {
      copy: plan.copy,
      classification,
      bytes: classification.measured.apparentBytes,
    },
    { discovery, indexLines: readIndexes(discovery.stateRoots).lines, assigned: undefined },
    options
  )
}

/**
 * Why `copy` cannot be a parked copy as the listing makes one, or null: the
 * area is `stagingRoot` (a `.skillsmith-parked` folder), and the copy, its op
 * folder, its parent and its record all follow from it.
 */
export function copyShapeProblem(copy: ListedCopy): string | null {
  const area = copy.stagingRoot
  const opDir = path.join(area, copy.opId)
  const ok =
    path.basename(area) === PARKED_DIR &&
    copy.opDir === opDir &&
    copy.parentDir === opDir &&
    copy.copyPath === path.join(opDir, copy.name) &&
    copy.sidecarPath === `${copy.copyPath}.json`
  return ok
    ? null
    : 'The restore plan does not describe a set-aside copy in a parked area, so nothing was restored. Run `skillsmith restore <id>` again.'
}

interface Subject {
  copy: ListedCopy
  classification: Classification
  bytes: number
}

async function evaluate(
  s: Subject,
  ctx: {
    discovery: Pick<Discovery, 'roots'>
    indexLines: readonly IndexedLine[]
    assigned: LockAssignment | undefined
  },
  options: RestorePlanOptions
): Promise<PlanRestoreResult> {
  const row = { copy: s.copy }
  const c = s.classification
  // The area is the copy's own `stagingRoot`; its parent is where `.skillsmith-parked` sits.
  const areaDir = s.copy.stagingRoot
  const areaRoot = path.dirname(areaDir)
  const copyPath = s.copy.copyPath
  const unknownOrigin = refuse(
    'origin-unknown',
    `The record beside \`${copyPath}\` can't be read, so where it came from is unknown. Copy what you need from it by hand.`
  )
  if (c.sidecarRead === null) return unknownOrigin
  // A held copy skips the strict schema in the listing, yet its originPath decides where
  // restore writes: the strict parse is run here on the bytes the listing read.
  const parsed = parseSidecarStrict(c.sidecarRead.bytes, {
    copyPath,
    parentName: path.basename(row.copy.parentDir),
    store: 'parked',
  })
  if (!parsed.ok) return unknownOrigin
  const sc = parsed.sidecar
  const kind = String(sc.kind)
  const origin = String(sc.originPath)
  if (!path.isAbsolute(origin)) return unknownOrigin
  const cls = restoreClassOf(kind)
  if (cls === null) {
    return refuse(
      'restore-kind-unknown',
      `\`${copyPath}\` has a kind (\`${kind}\`) this version of Skillsmith doesn't know, so it won't restore it.`
    )
  }
  if (!cls.restorable) {
    return refuse(
      'nothing-to-restore-into',
      `\`${copyPath}\` came from Skillsmith's own ${cls.what}, so there is nothing to restore it into. Copy what you need from it by hand.`
    )
  }
  if (c.klass === 'mounted') {
    return refuse(
      'restore-mounted',
      `A filesystem is mounted inside \`${copyPath}\`. Unmount it first, then run \`skillsmith restore <id>\` again.`
    )
  }
  if (c.rootIdentity === null) {
    return refuse(
      'restore-unreadable',
      `\`${copyPath}\` can't be read right now, so it won't be restored.`
    )
  }
  const type = TYPE_OF[String(c.rootIdentity.fmt & S_IFMT)]
  if (type === undefined) {
    return refuse(
      'restore-unsupported-type',
      `\`${copyPath}\` is not a folder, file or link, so it won't be restored.`
    )
  }
  const dir = path.dirname(origin)
  const o = realOf(dir)
  if (o === null || !isDirectory(o)) {
    return refuse(
      'origin-parent-missing',
      `The folder \`${dir}\` that \`${path.basename(origin)}\` came from no longer exists. Create it, then run \`skillsmith restore <id>\` again.`
    )
  }
  if (o !== realOf(areaRoot)) {
    return refuse(
      'origin-mismatch',
      `\`${copyPath}\` says it came from \`${origin}\`, which is not beside the folder it was set aside in (\`${areaDir}\`). Copy what you need from it by hand.`
    )
  }
  const chosen = await chooseLock({
    discovery: ctx.discovery,
    indexLines: ctx.indexLines,
    copyPath,
    origin,
    o,
    areaDir,
    assigned: ctx.assigned,
  })
  if (!chosen.ok) return refuse(chosen.reason, chosen.message)
  // Writes go to the bound real parent plus the name, never through the sidecar's own spelling.
  const target = path.join(o, path.basename(origin))
  if (idOf(target) !== 'absent') {
    return refuse(
      'origin-occupied',
      `Something already exists at \`${origin}\`. Move it aside first, then run \`skillsmith restore <id>\` again.`
    )
  }
  const digest = sha(
    JSON.stringify([
      copyPath,
      String(c.rootIdentity.dev),
      String(c.rootIdentity.ino),
      String(c.rootIdentity.birthtimeNs),
      String(c.rootIdentity.fmt),
      sha(c.sidecarRead.bytes),
      c.freshHash,
      c.klass,
      kind,
      origin,
      target,
      idOf(target),
      idOf(o),
      idOf(areaDir),
      idOf(row.copy.opDir),
      chosen.lock,
      chosen.rootIdentity,
    ])
  )
  return {
    status: 'planned',
    plan: {
      copyPath,
      opId: row.copy.opId,
      kind,
      held: sc.hold === true,
      type,
      origin,
      target,
      lock: chosen.lock,
      bytes: s.bytes,
      contents: contentsOf(sc, c.freshHash),
      lockNote: chosen.note,
      lockDisagreement: chosen.disagreement,
      digest,
      copy: row.copy,
      rootIdentity: c.rootIdentity,
      sidecarBytes: c.sidecarRead.bytes,
      sidecarIno: c.sidecarRead.ino,
      options,
    },
  }
}
