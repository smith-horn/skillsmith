/**
 * SMI-6531 (A1 step 6c-i): prune's deletion engine (ADR-166 D-11), ported from
 * the SMI-6676 spike's `prune.walk.mjs`: stage one approved copy, verify it at
 * the staging path, and delete only what verified. CHILD PROCESS ONLY: the
 * walk chdirs, and `process.chdir` changes the whole process's cwd.
 *
 * MODULE-PRIVATE AND NOT YET CALLED. This module exports nothing: the only way
 * to reach `stageVerifyDelete` and the deletion walk is to run this file as a
 * process's entry with `SKILLSMITH_PRUNE_WALKER=1`, one job as JSON on stdin,
 * one result as JSON on stdout (spike PR-17). Importing it never starts a
 * walk. Nothing in core, the CLI or the MCP server runs it yet: 6c-iii ships
 * it as the CLI's second esbuild entry (UD59) and spawns it from
 * `doctor backups --prune --apply`.
 *
 * The walker takes no lock. Its caller must hold lock 1 of the copy's skills
 * root, or lock 1′, for the whole run (UD60, UD62, UD63).
 *
 * The sidecar is deleted last (owner decision 2026-11-05): a walk that stops
 * part-way leaves what remains of the tree beside its sidecar, so its origin
 * and restore metadata survive.
 *
 * fs is the DEFAULT export, looked up at call time, so an interposer sees
 * every call (D-11 "Enforcement in tests").
 *
 * @module @skillsmith/core/install/prune.walk
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { errCode, errCodeOrMessage, shapeResult } from './park-result.js'
import type { ParkResult, PartialParkResult } from './park-result.js'
import { decodeJob } from './prune.job.js'
import type { PruneJob } from './prune.job.js'
import { recordOf, removeIfIdentical } from './prune.metadata.js'
import type { MetaRecord } from './prune.metadata.js'
import {
  Stop,
  SIDECAR_KEY,
  rand,
  renameNoReplace,
  typeOf,
  sameDirId,
  sameLeafPost,
  sameLeafPre,
  stagingProblem,
} from './prune.walk.shared.js'
import type { Inventory, InventoryRow } from './prune.walk.shared.js'
import { recordMisplacement } from './prune.misplaced.js'
import { checkResume } from './prune.walk.resume.js'
import { intentFor, writeIntent } from './prune.walk.stage.js'
import { recheck, verifyAtStaging } from './prune.walk.verify.js'

/**
 * True only when this module is the process's entry. `import.meta.main` is set
 * by the loader and cannot be changed by in-process code, unlike
 * `process.argv[1]`, which an importer can point at this file (spike PR-17).
 * Measured (6c-i): true for this file run as `node --import tsx prune.walk.ts`,
 * false when another module imports it. Computed once at load.
 */
const IS_ENTRY = isMainThread && import.meta.main === true

type DirId = Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'>

/** What the walk is told about its run. */
interface WalkCtx {
  pruneId: string
  alive: () => boolean
  resume: boolean
  wrote: Record<string, MetaRecord>
}

/**
 * P4a-g for one approved copy. Module-private: the only caller is the entry
 * below. The env check is a second guard. Returns one shaped result.
 */
function stageVerifyDelete(job: PruneJob): ParkResult {
  if (!IS_ENTRY || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {
    throw new Error(
      'stageVerifyDelete runs only in the dedicated prune walker child (SKILLSMITH_PRUNE_WALKER=1)'
    )
  }
  const startPpid = process.ppid
  const alive = (): boolean => process.ppid === startPpid
  const pruneId = crypto.randomBytes(8).toString('hex')
  const out = (partial: PartialParkResult): ParkResult =>
    shapeResult({
      path: job.copyPath,
      entry: job.leaf,
      treeHash: job.approvedHash,
      pruneId,
      walkerPid: process.pid,
      ...partial,
    })
  const kept = (reason: string, detail: string, errno: string | null = null): ParkResult =>
    out({ status: 'kept', reason, detail, errno })

  // The approval is per item: a batch yes covers a clean copy only (ADR-166 D-11).
  if (job.klass !== 'clean' && job.authorization !== 'per-item') {
    return kept('needs-allow-changed', `a ${job.klass} copy is deleted only with a per-item yes`)
  }
  // A resumed run is checked first: its staging directory, any misplaced entry
  // still present (never deleted, F1), and agreement with the intent on disk.
  let cleared: Record<string, MetaRecord> = {}
  if (job.S != null) {
    const rc = checkResume({ ...job, S: job.S })
    if (!rc.ok) return kept(rc.reason, rc.detail)
    cleared = rc.cleared
  }
  // P4a
  const worse = recheck(job)
  if (worse !== null) return kept('class-worsened', worse)
  if (!alive()) return kept('stage-failed', 'the parent process is gone')

  // Metadata this child may remove at P4g: what it writes itself (recorded
  // below), or, for a staged leftover, what the parent inspected and the user
  // confirmed.
  const own: Record<string, MetaRecord> = { ...(job.inheritedMeta ?? {}) }
  const wrote: Record<string, MetaRecord> = {}
  const leaf = job.leaf
  let S: string
  let sIdentity: DirId
  if (job.S == null) {
    // P4b
    S = path.join(job.stagingRoot, `.prune-${crypto.randomBytes(8).toString('hex')}`)
    try {
      fs.mkdirSync(S, { mode: 0o700 })
    } catch (err) {
      return kept('staging-unusable', `mkdir ${S}: ${errCode(err)}`, errCode(err))
    }
    let sd: BigIntStats
    try {
      sd = fs.lstatSync(S, { bigint: true })
    } catch (err) {
      return kept('staging-unusable', `lstat ${S}: ${errCode(err)}`, errCode(err))
    }
    const bad = stagingProblem(sd, job.rootIdentity.dev)
    if (bad !== null) {
      try {
        fs.rmdirSync(S)
      } catch {
        /* reported below */
      }
      return kept('staging-unusable', `${S}: ${bad}`)
    }
    sIdentity = { type: 'dir', dev: sd.dev, ino: sd.ino, birthtimeNs: sd.birthtimeNs }
    // P4c
    try {
      own['intent.json'] = writeIntent(S, intentFor(job, pruneId))
    } catch (err) {
      try {
        fs.rmdirSync(S)
      } catch {
        /* an intent temp is left: the listing reports it as partial-intent */
      }
      return kept('stage-failed', `intent write failed (${errCodeOrMessage(err)})`, errCode(err))
    }
    // P4d
    try {
      renameNoReplace(job.copyPath, path.join(S, leaf))
    } catch (err) {
      // Our own intent only, by inode and exact bytes; a kept one is reported.
      const r = removeIfIdentical(path.join(S, 'intent.json'), own['intent.json'])
      try {
        fs.rmdirSync(S)
      } catch {
        /* not empty: reported by the next listing */
      }
      return out({
        status: 'kept',
        reason: 'stage-failed',
        errno: errCode(err),
        detail: `rename into staging failed (${errCode(err)})`,
        ...(!r.removed && r.kept !== null ? { metadataKept: [r.kept] } : {}),
      })
    }
  } else {
    S = job.S
    let sd: BigIntStats
    try {
      sd = fs.lstatSync(S, { bigint: true })
    } catch (err) {
      return kept('staging-unusable', `lstat ${S}: ${errCode(err)}`, errCode(err))
    }
    sIdentity = { type: 'dir', dev: sd.dev, ino: sd.ino, birthtimeNs: sd.birthtimeNs }
  }
  const stagingPath = S
  const leafPath = path.join(stagingPath, leaf)
  const held = (reason: string, detail: string): ParkResult =>
    out({ status: 'held', reason, detail, path: leafPath, heldPath: leafPath, stagingPath })

  // P4d'
  const stagedSidecar = path.join(stagingPath, 'sidecar.json')
  if (job.sidecarRead !== null && job.sidecarPath !== null && job.sidecarPath !== stagedSidecar) {
    try {
      renameNoReplace(job.sidecarPath, stagedSidecar)
    } catch (err) {
      return held(
        'sidecar-stage-failed',
        `sidecar rename failed (${errCode(err)}); the copy is whole at ${leafPath}`
      )
    }
  }
  // P4e
  const v = verifyAtStaging(stagingPath, leaf, {
    approvedHash: job.approvedHash,
    rootIdentity: job.rootIdentity,
    sidecar: job.sidecarRead ? { ino: job.sidecarRead.ino, bytes: job.sidecarRead.bytes } : null,
  })
  if (!v.ok) return held(v.reason, v.detail)
  // P4f
  let del: { deleted: number }
  try {
    del = deleteVerified(stagingPath, leaf, v.inventory, sIdentity, {
      pruneId,
      alive,
      resume: job.resume === true,
      wrote,
    })
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    return out({
      status: err.status,
      reason: err.reason,
      detail: err.detail,
      errno: err.errno ?? null,
      path: leafPath,
      stagingPath,
      ...err.extra,
    })
  } finally {
    try {
      process.chdir(job.stagingRoot)
    } catch {
      /* the child exits next */
    }
  }
  // P4g: a metadata file is removed only if it is exactly what this run wrote
  // (or what the parent inspected for this confirmed staged copy), by inode
  // and bytes, re-checked immediately before unlink. Otherwise it is kept and
  // reported in `metadataKept`; the copy is removed either way.
  // Misplacement records whose entries were gone when this run checked them
  // are removed the same way.
  const metadataKept: string[] = []
  const toRemove: [string, MetaRecord | undefined][] = [
    ['deleting', wrote.deleting ?? own.deleting],
    ['intent.json', own['intent.json']],
    ...Object.entries(cleared),
  ]
  for (const [m, rec] of toRemove) {
    const r = removeIfIdentical(path.join(stagingPath, m), rec)
    if (!r.removed && r.kept !== null) metadataKept.push(r.kept)
  }
  // Only empty directories are removed. Anything left keeps them, and is named.
  const notes: string[] = []
  for (const [dir, label] of [
    [stagingPath, 'staging directory'],
    [job.opDir, 'op directory'],
  ] as const) {
    try {
      fs.rmdirSync(dir)
    } catch (err) {
      const code = errCode(err)
      if (dir === stagingPath || (code !== 'ENOTEMPTY' && code !== 'ENOENT')) {
        notes.push(`${label} left (${code})`)
      }
    }
  }
  return out({
    status: 'removed',
    deleted: del.deleted,
    ...(notes.length ? { detail: notes.join('; ') } : {}),
    ...(metadataKept.length ? { metadataKept } : {}),
  })
}

/**
 * The deletion walk. Unlinks only an inode whose row matched one syscall
 * earlier, by a random name in a directory it has entered and re-identified.
 * Never follows a symlink, never crosses a mount, never renames onto an
 * existing name, and never renames anything back (R-misplace). The tree goes
 * first and the sidecar last. Module-private: called only from
 * `stageVerifyDelete`, which holds the guard. Returns the count deleted, or
 * throws `Stop`.
 */
function deleteVerified(
  S: string,
  leaf: string,
  inventory: Inventory,
  sIdentity: DirId,
  ctx: WalkCtx
): { deleted: number } {
  let deleted = 0
  const segs: string[] = []
  const stop = (reason: string, detail: string): Stop =>
    new Stop('stopped', reason, detail, { deleted })
  const cwdIs = (want: DirId | undefined, at: string): void => {
    const s = fs.statSync('.', { bigint: true })
    if (!sameDirId(want, s)) {
      throw stop(
        'mount-appeared-during-delete',
        `the current directory is no longer ${at || 'the staged root'}`
      )
    }
  }
  const errnoStop = (err: unknown, at: string): Stop => {
    if (err instanceof Stop) return err
    const code = errCode(err)
    if (code === 'EBUSY') return stop('mount-appeared-during-delete', `${at}: EBUSY`)
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return stop('entry-added-during-delete', `${at}: ${code}`)
    }
    const s = stop('delete-failed', `${at}: ${errCodeOrMessage(err)}`)
    s.errno = code
    return s
  }
  const misplaced = (r: string, originalRel: string, curWant: DirId | undefined): Stop => {
    let cause = 'cwd-covered'
    try {
      if (sameDirId(curWant, fs.statSync('.', { bigint: true }))) cause = 'swapped'
    } catch {
      /* unreadable cwd: covered */
    }
    // The rename ran in the walker's cwd. That is S for the sidecar and for a
    // staged root that is not a directory (originalRel ''), and S/<leaf>/<segs>
    // for anything below a directory root, so the entry's real location
    // follows the cwd, not the name.
    const inS = originalRel === SIDECAR_KEY || originalRel === ''
    const abs = inS ? path.join(S, r) : path.join(S, leaf, ...segs, r)
    let lst: Record<string, string> | null = null
    try {
      const s = fs.lstatSync(r, { bigint: true })
      lst = { dev: String(s.dev), ino: String(s.ino), type: typeOf(s), size: String(s.size) }
    } catch {
      /* gone */
    }
    const at = new Date().toISOString()
    const rec = recordMisplacement(S, {
      pruneId: ctx.pruneId,
      path: abs,
      originalRel,
      cause,
      at,
      lstat: lst,
    })
    const what = inS ? (originalRel === '' ? 'the staged root' : 'the sidecar') : originalRel
    return new Stop('stopped', 'entry-misplaced', `${what} was renamed to ${abs} and left there`, {
      deleted,
      misplaced: [{ path: abs, originalRel, cause }],
      ...(rec.recordError === null ? {} : { misplacedRecordError: rec.recordError }),
      ...(rec.markerError === null ? {} : { misplacedMarkerError: rec.markerError }),
    })
  }
  const deleteLeaf = (
    n: string,
    crel: string,
    want: InventoryRow | undefined,
    curWant: DirId | undefined
  ): void => {
    const s = fs.lstatSync(n, { bigint: true })
    if (!sameLeafPre(want, s)) {
      throw stop('changed-during-delete', `${crel} changed after it was verified`)
    }
    const r = rand()
    try {
      renameNoReplace(n, r)
    } catch (err) {
      throw errnoStop(err, crel)
    }
    if (!sameLeafPost(want, fs.lstatSync(r, { bigint: true }))) throw misplaced(r, crel, curWant)
    try {
      fs.unlinkSync(r)
    } catch (err) {
      throw errnoStop(err, crel)
    }
    deleted += 1
  }
  const walkDir = (rel: string): void => {
    const curWant = inventory.get(rel)
    for (const n of fs.readdirSync('.').sort()) {
      if (!ctx.alive()) throw stop('delete-failed', 'the parent process is gone')
      const crel = rel ? `${rel}/${n}` : n
      const want = inventory.get(crel)
      if (!want) {
        throw stop('entry-added-during-delete', `${crel} was not in the verified inventory`)
      }
      cwdIs(curWant, rel)
      const s = fs.lstatSync(n, { bigint: true })
      if (want.type !== 'dir') {
        deleteLeaf(n, crel, want, curWant)
        continue
      }
      if (!s.isDirectory()) throw stop('changed-during-delete', `${crel} is no longer a directory`)
      if (!sameDirId(want, s)) {
        throw stop(
          'mount-appeared-during-delete',
          `${crel}: directory identity changed (a mount root or a replaced directory)`
        )
      }
      const r = rand()
      try {
        renameNoReplace(n, r)
      } catch (err) {
        throw errnoStop(err, crel)
      }
      if (!sameDirId(want, fs.lstatSync(r, { bigint: true }))) throw misplaced(r, crel, curWant)
      process.chdir(r)
      segs.push(r)
      cwdIs(want, crel)
      walkDir(crel)
      if (fs.readdirSync('.').length !== 0) {
        throw stop('entry-added-during-delete', `${crel} gained an entry`)
      }
      process.chdir('..')
      segs.pop()
      cwdIs(curWant, rel)
      try {
        fs.rmdirSync(r)
      } catch (err) {
        throw errnoStop(err, crel)
      }
      deleted += 1
    }
  }
  /** The tree: a non-directory root by its name, or a directory root by the walk. */
  const deleteTree = (root: InventoryRow): void => {
    const s = fs.lstatSync(leaf, { bigint: true })
    if (root.type !== 'dir') {
      deleteLeaf(leaf, '', root, sIdentity)
      return
    }
    if (!sameDirId(root, s))
      throw stop('mount-appeared-during-delete', 'the staged root changed identity')
    process.chdir(leaf)
    cwdIs(root, '')
    walkDir('')
    if (fs.readdirSync('.').length !== 0) {
      throw stop('entry-added-during-delete', 'the staged root gained an entry')
    }
    process.chdir('..')
    cwdIs(sIdentity, 'S')
    try {
      fs.rmdirSync(leaf)
    } catch (err) {
      throw errnoStop(err, '.')
    }
    deleted += 1
  }
  try {
    const root = inventory.get('')
    if (root === undefined) {
      // verifyAtStaging always records the root; a missing row is a bug, not a race.
      throw new Stop('stopped', 'internal-error', 'the verified inventory has no root row', {
        deleted,
      })
    }
    process.chdir(S)
    cwdIs(sIdentity, 'S')
    if (!ctx.resume) {
      const marker = JSON.stringify({ pruneId: ctx.pruneId, pid: process.pid })
      fs.writeFileSync('deleting', marker, { flag: 'wx' })
      // P4g removes this marker only if it is still these bytes at this inode.
      ctx.wrote.deleting = recordOf(path.join(S, 'deleting'), marker)
    }
    deleteTree(root)
    // The sidecar last, so a stop above leaves the remaining tree beside it.
    const sc = inventory.get(SIDECAR_KEY)
    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)
    return { deleted }
  } catch (err) {
    throw errnoStop(err, 'walk')
  }
}

// The entry: one job as JSON on stdin, one result as JSON on stdout. This
// module exports nothing (spike PR-17). A job that does not decode is
// answered with a shaped `kept/invalid-job` result, never walked.
if (IS_ENTRY) {
  let job: PruneJob | null = null
  let r: ParkResult | null = null
  try {
    job = decodeJob(JSON.parse(fs.readFileSync(0, 'utf8')))
  } catch (err) {
    if (!(err instanceof TypeError || err instanceof SyntaxError)) throw err
    r = shapeResult({ status: 'kept', reason: 'invalid-job', detail: err.message })
  }
  if (job !== null) r = stageVerifyDelete(job)
  process.stdout.write(
    JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) + '\n'
  )
}
