/**
 * SMI-6531 (A1 step 6c-i): prune's deletion engine (ADR-166 D-11), ported from
 * the SMI-6676 spike's `prune.walk.mjs`: stage one approved copy, verify it at
 * the staging path, write the approved inventory, and delete only entries that
 * match it. CHILD PROCESS ONLY: the walk chdirs, and `process.chdir` changes
 * the whole process's cwd.
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
 * Prune deletes only approved entries (F1, owner decision 2026-11-06). The
 * first run writes the inventory (`prune.inventory.ts`) before its first
 * delete; every delete, on any run, matches a row of it; anything else is kept
 * and reported, and the walk goes on. A run removes a directory only after
 * renaming that exact directory to its random name and verifying it itself,
 * so a resume never removes one. The sidecar goes last, and only once no entry
 * of the tree is kept, so a stopped walk keeps its restore metadata.
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
import { decodeJob, isResume } from './prune.job.js'
import type { FreshJob, PruneJob, ResumeJob } from './prune.job.js'
import { removeIfIdentical } from './prune.metadata.js'
import type { MetaRecord } from './prune.metadata.js'
import {
  D_NAME_RE,
  INVENTORY_FILE,
  STAGING_KEY,
  buildInventory,
  writeInventory,
} from './prune.inventory.js'
import type { ApprovedRow } from './prune.inventory.js'
import {
  Approved,
  STAGING_METADATA,
  contentProblem,
  dirProblem,
  leafProblem,
} from './prune.inventory.match.js'
import type { FoundAt, KeptEntry } from './prune.inventory.match.js'
import {
  Stop,
  SIDECAR_KEY,
  rand,
  renameNoReplace,
  sameDirId,
  sameLeafPost,
  stagingProblem,
} from './prune.walk.shared.js'
import type { InventoryRow } from './prune.walk.shared.js'
import { checkResume } from './prune.walk.resume.js'
import {
  dirMisplacedStop,
  intentFor,
  notDone,
  removeEmptyDirs,
  writeDeleting,
  writeIntent,
} from './prune.walk.stage.js'
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
type Out = (partial: PartialParkResult) => ParkResult

/** What the walk is told about its run. */
interface WalkCtx {
  pruneId: string
  alive: () => boolean
  resume: boolean
}

/** What a walk that did not hard-stop did. */
interface WalkOutcome {
  deleted: number
  kept: KeptEntry[]
  skeletons: string[]
}

const dirIdOf = (st: BigIntStats): DirId => ({
  type: 'dir',
  dev: st.dev,
  ino: st.ino,
  birthtimeNs: st.birthtimeNs,
})

/**
 * P4a-g for one approved copy, or a resume. Module-private: the only caller is
 * the entry below. The env check is a second guard. Returns one shaped result.
 */
function stageVerifyDelete(job: PruneJob): ParkResult {
  if (!IS_ENTRY || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {
    throw new Error(
      'stageVerifyDelete runs only in the dedicated prune walker child (SKILLSMITH_PRUNE_WALKER=1)'
    )
  }
  const startPpid = process.ppid
  const pruneId = crypto.randomBytes(8).toString('hex')
  const ctx: WalkCtx = {
    pruneId,
    alive: () => process.ppid === startPpid,
    resume: isResume(job),
  }
  const out: Out = (partial) =>
    shapeResult({
      path: job.copyPath,
      entry: job.leaf,
      treeHash: isResume(job) ? null : job.approvedHash,
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
  return isResume(job) ? resumeRun(job, ctx, out) : freshRun(job, ctx, out)
}

/** P4a-P4e' for a fresh job: stage, verify, write the inventory, then delete. */
function freshRun(job: FreshJob, ctx: WalkCtx, out: Out): ParkResult {
  const kept = (reason: string, detail: string, errno: string | null = null): ParkResult =>
    out({ status: 'kept', reason, detail, errno })
  // P4a
  const worse = recheck(job)
  if (worse !== null) return kept('class-worsened', worse)
  if (!ctx.alive()) return kept('stage-failed', 'the parent process is gone')
  const own: Record<string, MetaRecord> = {}
  const leaf = job.leaf
  // P4b
  const S = path.join(job.stagingRoot, `.prune-${crypto.randomBytes(8).toString('hex')}`)
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
  // P4c
  try {
    own['intent.json'] = writeIntent(S, intentFor(job, ctx.pruneId))
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
  const leafPath = path.join(S, leaf)
  const held = (reason: string, detail: string): ParkResult =>
    out({ status: 'held', reason, detail, path: leafPath, heldPath: leafPath, stagingPath: S })
  // P4d'
  const stagedSidecar = path.join(S, 'sidecar.json')
  if (job.sidecarRead !== null && job.sidecarPath !== null) {
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
  const v = verifyAtStaging(S, leaf, {
    approvedHash: job.approvedHash,
    rootIdentity: job.rootIdentity,
    sidecar: job.sidecarRead ? { ino: job.sidecarRead.ino, bytes: job.sidecarRead.bytes } : null,
  })
  if (!v.ok) return held(v.reason, v.detail)
  // P4e': the approved inventory, durably, before the first delete. Without it, nothing is deleted.
  const inv = buildInventory({
    pruneId: ctx.pruneId,
    leaf,
    treeHash: v.hash,
    staging: sd,
    verified: v.inventory,
  })
  const w = writeInventory(S, inv)
  if (!w.ok) {
    return w.step === 'too-large'
      ? held('inventory-too-large', `${inv.rows.length} entries; nothing was deleted`)
      : held('inventory-unwritten', `${w.step} failed (${w.errno}); nothing was deleted`)
  }
  own[INVENTORY_FILE] = w.record
  // The delete marker binds the inventory to this run (its digest and run ID) before any delete.
  try {
    own.deleting = writeDeleting(S, inv.pruneId, w.digest)
  } catch (err) {
    return held(
      'marker-unwritten',
      `deleting write failed (${errCodeOrMessage(err)}); nothing deleted`
    )
  }
  return walkAndFinish(job, S, new Approved(inv), dirIdOf(sd), ctx, own, out)
}

/** A resume: the checks against the leftover and its inventory, then the same walk. */
function resumeRun(job: ResumeJob, ctx: WalkCtx, out: Out): ParkResult {
  const rc = checkResume(job)
  if (!rc.ok) return out({ status: 'kept', reason: rc.reason, detail: rc.detail })
  if (!ctx.alive()) {
    return out({ status: 'kept', reason: 'stage-failed', detail: 'the parent process is gone' })
  }
  const own: Record<string, MetaRecord> = {
    ...(job.inheritedMeta ?? {}),
    [INVENTORY_FILE]: rc.record,
  }
  return walkAndFinish(job, job.S, new Approved(rc.inv), dirIdOf(rc.sStat), ctx, own, out)
}

/** P4f, then P4g once nothing is left: our own metadata by inode and bytes, then the empty directories. */
function walkAndFinish(
  job: PruneJob,
  S: string,
  ap: Approved,
  sId: DirId,
  ctx: WalkCtx,
  own: Record<string, MetaRecord>,
  out: Out
): ParkResult {
  let o: WalkOutcome
  try {
    o = deleteApproved(S, ap, sId, ctx)
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    return out({
      status: err.status,
      reason: err.reason,
      detail: err.detail,
      errno: err.errno ?? null,
      stagingPath: S,
      ...err.extra,
    })
  } finally {
    try {
      process.chdir(job.stagingRoot)
    } catch {
      /* the child exits next */
    }
  }
  // Not done: the metadata stays, so the listing can say what is left and why.
  if (o.kept.length > 0 || o.skeletons.length > 0) return out(notDone(o, S))
  const metadataKept: string[] = []
  for (const m of ['deleting', 'intent.json', INVENTORY_FILE]) {
    const r = removeIfIdentical(path.join(S, m), own[m])
    if (!r.removed && r.kept !== null) metadataKept.push(r.kept)
  }
  const notes = removeEmptyDirs(S, job.opDir)
  return out({
    status: 'removed',
    deleted: o.deleted,
    stagingPath: S,
    ...(notes.length ? { detail: notes.join('; ') } : {}),
    ...(metadataKept.length ? { metadataKept } : {}),
  })
}

/**
 * The deletion walk. Deletes only an entry that matches an approved row (on a
 * resume, by content too), by a random name in a directory it has entered and
 * re-identified, with the post-rename re-check. Anything else is kept where it
 * is and reported, and the walk goes on; only a directory or cwd whose
 * identity changed stops it. Never follows a symlink, never crosses a mount,
 * never renames onto an existing name, never renames anything back, and
 * removes a directory only after renaming it itself (so never on a resume).
 * Module-private: called only through `stageVerifyDelete`, which holds the guard.
 */
function deleteApproved(S: string, ap: Approved, sId: DirId, ctx: WalkCtx): WalkOutcome {
  const o: WalkOutcome = { deleted: 0, kept: [], skeletons: [] }
  const segs: string[] = []
  const here = (n: string): string => path.join(S, ...segs, n)
  const stop = (reason: string, detail: string): Stop =>
    new Stop('stopped', reason, detail, {
      deleted: o.deleted,
      kept: o.kept,
      skeletons: o.skeletons,
    })
  const cwdIs = (want: DirId | undefined, at: string): void => {
    if (!sameDirId(want, fs.statSync('.', { bigint: true }))) {
      throw stop('mount-appeared-during-delete', `the current directory is no longer ${at}`)
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
  // Every path the walk reported or left on purpose; anything else still there is unapproved.
  const accounted = new Set<string>()
  const keep = (n: string, rel: string | null, why: string): void => {
    accounted.add(here(n))
    o.kept.push({ path: here(n), rel, why })
  }
  const unvisited = (names: string[]): void => {
    for (const n of names) if (!accounted.has(here(n))) keep(n, null, 'appeared during the walk')
  }
  const deleteLeaf = (n: string, row: ApprovedRow, at: FoundAt): void => {
    const s = fs.lstatSync(n, { bigint: true })
    const bad = leafProblem(row, s, at, ctx.resume) ?? (ctx.resume ? contentProblem(row, n) : null)
    if (bad !== null) return keep(n, row.rel, bad)
    const r = rand()
    try {
      renameNoReplace(n, r)
    } catch (err) {
      throw errnoStop(err, row.rel || '.')
    }
    // R-misplace: an entry swapped between its check and its rename is left at its random name.
    if (!sameLeafPost(row, fs.lstatSync(r, { bigint: true }))) {
      return keep(r, row.rel, 'changed between its check and its rename; left at its random name')
    }
    try {
      fs.unlinkSync(r)
    } catch (err) {
      throw errnoStop(err, row.rel || '.')
    }
    ap.consume(row)
    o.deleted += 1
  }
  const enterDir = (n: string, row: ApprovedRow, parent: DirId, parentAt: string): void => {
    const s = fs.lstatSync(n, { bigint: true })
    if (!s.isDirectory()) return keep(n, row.rel, 'no longer a directory')
    if (dirProblem(row, s) !== null) {
      throw stop('mount-appeared-during-delete', `${row.rel || '.'}: directory identity changed`)
    }
    let name = n
    if (!ctx.resume) {
      // Only a directory this run renamed and re-identified is ever removed (R2).
      name = rand()
      try {
        renameNoReplace(n, name)
      } catch (err) {
        throw errnoStop(err, row.rel || '.')
      }
      if (!sameDirId(row, fs.lstatSync(name, { bigint: true }))) {
        throw dirMisplacedStop(here(name), row.rel, o)
      }
    }
    process.chdir(name)
    segs.push(name)
    cwdIs(row, row.rel || 'the staged root')
    const keptBefore = o.kept.length
    walkDir(row)
    const names = fs.readdirSync('.')
    unvisited(names.sort())
    const left = names.length
    process.chdir('..')
    segs.pop()
    cwdIs(parent, parentAt)
    accounted.add(here(name))
    if (ctx.resume) {
      // Left in place (R2); a skeleton when nothing under it was kept.
      if (o.kept.length === keptBefore) o.skeletons.push(here(name))
      return
    }
    if (left > 0) return // it holds kept entries, each already reported
    try {
      fs.rmdirSync(name)
    } catch (err) {
      throw errnoStop(err, row.rel || '.')
    }
    ap.consume(row)
    o.deleted += 1
  }
  const visitEntry = (n: string, parentRel: string, parent: DirId, parentAt: string): void => {
    const s = fs.lstatSync(n, { bigint: true })
    const loc = ap.locate(parentRel, n, s, ctx.resume)
    if (loc.row === null) return keep(n, null, loc.why)
    if (loc.row.type === 'dir') enterDir(n, loc.row, parent, parentAt)
    else deleteLeaf(n, loc.row, loc.at)
  }
  const walkDir = (dirRow: ApprovedRow): void => {
    for (const n of fs.readdirSync('.').sort()) {
      if (!ctx.alive()) throw stop('delete-failed', 'the parent process is gone')
      cwdIs(dirRow, dirRow.rel || 'the staged root')
      visitEntry(n, dirRow.rel, dirRow, dirRow.rel || 'the staged root')
    }
  }
  /** Where `rel` (the root or the sidecar) sits in S: its own name, or, on a resume, a `.d-` name. */
  const findTop = (own: string, rel: string): string | null => {
    const names = fs.readdirSync('.')
    if (names.includes(own)) return own
    if (!ctx.resume) return null
    for (const n of names.filter((x) => D_NAME_RE.test(x)).sort()) {
      const loc = ap.locate(STAGING_KEY, n, fs.lstatSync(n, { bigint: true }), true)
      if (loc.row !== null && loc.row.rel === rel) return n
    }
    return null
  }
  try {
    process.chdir(S)
    cwdIs(sId, 'S')
    const rootAt = findTop(ap.inv.leaf, '')
    const sideAt = ap.row(SIDECAR_KEY) ? findTop('sidecar.json', SIDECAR_KEY) : null
    if (rootAt !== null) visitEntry(rootAt, STAGING_KEY, sId, 'S')
    // Every other entry directly in S that is not prune's own metadata is unapproved.
    const skip = new Set<string | null>([...STAGING_METADATA, rootAt, sideAt])
    unvisited(
      fs
        .readdirSync('.')
        .filter((n) => !skip.has(n))
        .sort()
    )
    // The sidecar last, and only once no entry is kept: empty directories a
    // resume may not remove (R2) hold nothing it describes, but a kept entry does.
    if (sideAt !== null && o.kept.length === 0) visitEntry(sideAt, STAGING_KEY, sId, 'S')
    return o
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
