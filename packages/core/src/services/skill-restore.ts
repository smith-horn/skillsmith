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
import { listBackups, type ListBackupsOptions } from './skill-backups.listing.js'
import { discoverRoots } from './skill-recovery.discover.js'
import { assignLocks } from './skill-backups.locks.js'
import { chooseLock } from './skill-restore.lock.js'
import { restoreClassOf } from './skill-restore.kinds.js'
import { allRows, matchRows, parseId, type Match } from './skill-restore.resolve.js'
import type {
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
async function listOptions(o: RestorePlanOptions): Promise<ListBackupsOptions> {
  const discovered =
    o.discovered ??
    (await discoverRoots({
      ...(o.stateRoot === undefined ? {} : { stateRoot: o.stateRoot }),
      ...(o.roots === undefined || o.roots.length === 0 ? {} : { roots: o.roots }),
      ...o.discovery,
    }))
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
  return planOne(matches[0]!, listing, options)
}

async function planOne(
  m: Match,
  listing: Awaited<ReturnType<typeof listBackups>>,
  options: RestorePlanOptions
): Promise<PlanRestoreResult> {
  const { row, view } = m
  const c = row.classification
  const copyPath = row.copy.copyPath
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
  if (o === null || !fs.statSync(o).isDirectory()) {
    return refuse(
      'origin-parent-missing',
      `The folder \`${dir}\` that \`${path.basename(origin)}\` came from no longer exists. Create it, then run \`skillsmith restore <id>\` again.`
    )
  }
  if (o !== realOf(view.ref.root)) {
    return refuse(
      'origin-mismatch',
      `\`${copyPath}\` says it came from \`${origin}\`, which is not beside the folder it was set aside in (\`${view.ref.areaDir}\`). Copy what you need from it by hand.`
    )
  }
  const assigned = (await assignLocks(listing)).get(copyPath)
  const chosen = await chooseLock({
    listing,
    copyPath,
    origin,
    o,
    areaDir: view.ref.areaDir,
    assigned,
  })
  if (!chosen.ok) return refuse(chosen.reason, chosen.message)
  if (idOf(origin) !== 'absent') {
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
      idOf(origin),
      idOf(o),
      idOf(view.ref.areaDir),
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
      lock: chosen.lock,
      bytes: row.apparentBytes,
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
