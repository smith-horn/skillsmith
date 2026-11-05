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
 * fs is the DEFAULT export, looked up at call time, so an interposer sees
 * every call (D-11 "Enforcement in tests").
 *
 * @module @skillsmith/core/install/prune.walk
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { errCode, errCodeOrMessage, shapeResult } from './park-result.js'
import type { ParkResult, PartialParkResult } from './park-result.js'
import { decodeJob } from './prune.job.js'
import type { PruneJob } from './prune.job.js'
import { recordOf, removeIfIdentical, INTENT_VERSION } from './prune.metadata.js'
import type { MetaRecord, PruneIntent } from './prune.metadata.js'
import {
  Stop,
  SIDECAR_KEY,
  rand,
  typeOf,
  sameDirId,
  sameLeafPost,
  sameLeafPre,
  stagingProblem,
} from './prune.walk.shared.js'
import type { Inventory, InventoryRow } from './prune.walk.shared.js'
import { recheck, verifyAtStaging } from './prune.walk.verify.js'

/**
 * True only when this module is the process's entry. `import.meta.main` is set
 * by the loader and cannot be changed by in-process code, unlike
 * `process.argv[1]`, which an importer can point at this file (spike PR-17).
 * Measured (6c-i): true for this file run as `node --import tsx prune.walk.ts`,
 * false when another module imports it. Computed once at load.
 */
const IS_ENTRY = isMainThread && import.meta.main === true

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

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

  // The approval is per item: a batch yes covers a clean copy only (ADR-166 D-11).
  if (job.klass !== 'clean' && job.authorization !== 'per-item') {
    return out({
      status: 'kept',
      reason: 'needs-allow-changed',
      detail: `a ${job.klass} copy is deleted only with a per-item yes`,
    })
  }
  // P4a
  const worse = recheck(job)
  if (worse !== null) return out({ status: 'kept', reason: 'class-worsened', detail: worse })
  if (!alive()) {
    return out({ status: 'kept', reason: 'stage-failed', detail: 'the parent process is gone' })
  }

  // Metadata this child may remove at P4g: what it writes itself (recorded
  // below), or, for a staged leftover, what the parent inspected and the user
  // confirmed.
  const own: Record<string, MetaRecord> = { ...(job.inheritedMeta ?? {}) }
  const wrote: Record<string, MetaRecord> = {}
  let S = job.S ?? null
  let sIdentity: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'>
  const leaf = job.leaf
  if (S === null) {
    // P4b
    S = path.join(job.stagingRoot, `.prune-${crypto.randomBytes(8).toString('hex')}`)
    try {
      fs.mkdirSync(S, { mode: 0o700 })
    } catch (err) {
      return out({
        status: 'kept',
        reason: 'staging-unusable',
        detail: `mkdir ${S}: ${errCode(err)}`,
      })
    }
    const sd = fs.lstatSync(S, { bigint: true })
    const bad = stagingProblem(sd, job.rootIdentity.dev)
    if (bad !== null) {
      try {
        fs.rmdirSync(S)
      } catch {
        /* reported below */
      }
      return out({ status: 'kept', reason: 'staging-unusable', detail: `${S}: ${bad}` })
    }
    sIdentity = { type: 'dir', dev: sd.dev, ino: sd.ino, birthtimeNs: sd.birthtimeNs }
    // P4c
    const intent: PruneIntent = {
      pruneId,
      copyPath: job.copyPath,
      sidecarPath: job.sidecarPath,
      leaf,
      approvedHash: job.approvedHash,
      approvedSidecarSha256: job.sidecarRead
        ? crypto.createHash('sha256').update(job.sidecarRead.bytes).digest('hex')
        : null,
      class: job.klass,
      authorization: job.authorization,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      host: process.env.HOSTNAME ?? null,
      version: INTENT_VERSION,
    }
    const intentBytes = JSON.stringify(intent, null, 2)
    fs.writeFileSync(path.join(S, 'intent.json'), intentBytes, { flag: 'wx' })
    own['intent.json'] = recordOf(path.join(S, 'intent.json'), intentBytes)
    // P4d
    try {
      fs.renameSync(job.copyPath, path.join(S, leaf))
    } catch (err) {
      // Our own intent only, by inode and exact bytes.
      removeIfIdentical(path.join(S, 'intent.json'), own['intent.json'])
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
      })
    }
  } else {
    const sd = fs.lstatSync(S, { bigint: true })
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
      fs.renameSync(job.sidecarPath, stagedSidecar)
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
  // reported in `metadataKept`.
  const metadataKept: string[] = []
  for (const m of ['deleting', 'intent.json']) {
    const r = removeIfIdentical(path.join(stagingPath, m), wrote[m] ?? own[m])
    if (!r.removed && r.kept !== null) metadataKept.push(r.kept)
  }
  let sKept: string | null = null
  if (exists(path.join(stagingPath, 'misplaced.json'))) {
    sKept = 'misplaced.json kept for the next listing'
  } else {
    try {
      fs.rmdirSync(stagingPath)
    } catch (err) {
      sKept = `staging directory left (${errCode(err)})`
    }
  }
  try {
    fs.rmdirSync(job.opDir)
  } catch {
    /* ENOTEMPTY / ENOENT are fine */
  }
  return out({
    status: 'removed',
    deleted: del.deleted,
    ...(sKept ? { detail: sKept } : {}),
    ...(metadataKept.length ? { metadataKept } : {}),
  })
}

/**
 * The deletion walk. Unlinks only an inode whose row matched one syscall
 * earlier, by a random name in a directory it has entered and re-identified.
 * Never follows a symlink, never crosses a mount, and never renames anything
 * back (R-misplace). Module-private: called only from `stageVerifyDelete`,
 * which holds the guard. Returns the count deleted, or throws `Stop`.
 */
function deleteVerified(
  S: string,
  leaf: string,
  inventory: Inventory,
  sIdentity: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'>,
  ctx: WalkCtx
): { deleted: number } {
  let deleted = 0
  const segs: string[] = []
  const stop = (reason: string, detail: string): Stop =>
    new Stop('stopped', reason, detail, { deleted })
  const cwdIs = (
    want: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'> | undefined,
    at: string
  ): void => {
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
  const misplaced = (
    r: string,
    originalRel: string,
    curWant: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'> | undefined
  ): Stop => {
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
    const rec = {
      pruneId: ctx.pruneId,
      path: abs,
      originalRel,
      cause,
      at: new Date().toISOString(),
      lstat: lst,
    }
    let misplacedRecordError: string | null = null
    try {
      fs.writeFileSync(path.join(S, 'misplaced.json'), JSON.stringify(rec, null, 2), { flag: 'wx' })
    } catch (err) {
      misplacedRecordError = errCodeOrMessage(err)
    }
    const what = inS ? (originalRel === '' ? 'the staged root' : 'the sidecar') : originalRel
    return new Stop('stopped', 'entry-misplaced', `${what} was renamed to ${abs} and left there`, {
      deleted,
      misplaced: [{ path: abs, originalRel, cause }],
      ...(misplacedRecordError === null ? {} : { misplacedRecordError }),
    })
  }
  const deleteLeaf = (
    n: string,
    crel: string,
    want: InventoryRow | undefined,
    curWant: Pick<InventoryRow, 'type' | 'dev' | 'ino' | 'birthtimeNs'> | undefined
  ): void => {
    const s = fs.lstatSync(n, { bigint: true })
    if (!sameLeafPre(want, s)) {
      throw stop('changed-during-delete', `${crel} changed after it was verified`)
    }
    const r = rand()
    try {
      fs.renameSync(n, r)
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
        fs.renameSync(n, r)
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
  try {
    process.chdir(S)
    cwdIs(sIdentity, 'S')
    if (!ctx.resume) {
      const marker = JSON.stringify({ pruneId: ctx.pruneId, pid: process.pid })
      fs.writeFileSync('deleting', marker, { flag: 'wx' })
      // P4g removes this marker only if it is still these bytes at this inode.
      ctx.wrote.deleting = recordOf('deleting', marker)
    }
    const sc = inventory.get(SIDECAR_KEY)
    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)
    const root = inventory.get('')
    const s = fs.lstatSync(leaf, { bigint: true })
    if (!sameDirId(root, s)) {
      if (root !== undefined && root.type !== 'dir') {
        deleteLeaf(leaf, '', root, sIdentity)
        return { deleted }
      }
      throw stop('mount-appeared-during-delete', 'the staged root changed identity')
    }
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
    return { deleted }
  } catch (err) {
    throw errnoStop(err, 'walk')
  }
}

// The entry: one job as JSON on stdin, one result as JSON on stdout. This
// module exports nothing (spike PR-17).
if (IS_ENTRY) {
  const job = decodeJob(JSON.parse(fs.readFileSync(0, 'utf8')))
  const r = stageVerifyDelete(job)
  process.stdout.write(
    JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) + '\n'
  )
}
