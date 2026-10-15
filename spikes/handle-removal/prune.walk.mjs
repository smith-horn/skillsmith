// SMI-7123 Wave 5 (design §1 P4a-g, §3): stage, verify at the staging path, and
// delete only verified entries. CHILD PROCESS ONLY (§3.4): the walk chdirs,
// and process.chdir changes the whole process's cwd.
//
// fs is the DEFAULT export, looked up at call time (the harness interposes it).

// The verify step (prune.walk.verify.mjs), the deletion walk (prune.walk.delete.mjs)
// and the helpers they share (prune.walk.shared.mjs) were split out for the
// file-length limit; this module keeps P4a-g, the guard and the child entry.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { readStable } from './prune.sidecar.mjs'
import { shapeResult } from './result-shape.mjs'
import { decodeJob } from './prune.job.mjs'
import { recordOf, removeIfIdentical } from './prune.metadata.mjs'
import { Stop, mountFinding } from './prune.walk.shared.mjs'
import { verifyAtStaging } from './prune.walk.verify.mjs'
import { deleteVerified } from './prune.walk.delete.mjs'

const SELF_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null

/** P4a: the copy and sidecar are still what P2 classified and P3 approved. */
function recheck(job) {
  let st
  try {
    st = fs.lstatSync(job.copyPath, { bigint: true })
  } catch (err) {
    return `copy unreadable (${err.code})`
  }
  const id = job.rootIdentity
  if (st.dev !== id.dev || st.ino !== id.ino || st.birthtimeNs !== id.birthtimeNs)
    return 'the copy is no longer the inode that was classified'
  const mi = mountFinding(job.copyPath)
  if (mi !== null) return mi
  if (job.sidecarRead === null) {
    if (job.sidecarPath !== null && exists(job.sidecarPath)) return 'a sidecar appeared'
    return null
  }
  const rs = readStable(job.sidecarPath)
  if (!rs.ok) return `sidecar: ${rs.reason}`
  if (!rs.bytes.equals(job.sidecarRead.bytes))
    return 'the sidecar bytes changed since classification'
  return null
}

function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

// Sol PR #3091 finding PR-17: true only when this module is the process's entry,
// i.e. the walker child prune.mjs spawns. Computed once at load.
const IS_ENTRY =
  isMainThread &&
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/**
 * P4a-g for one approved item. MODULE-PRIVATE (Sol PR #3091 finding PR-17): not
 * exported, so the only caller is the child entry at the bottom of this file; an
 * in-process importer has nothing to call, whatever it sets in the environment.
 * The env check stays as a second guard. Returns one shaped ItemResult.
 */
function stageVerifyDelete(job) {
  if (!IS_ENTRY || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {
    throw new Error(
      'stageVerifyDelete runs only in the dedicated prune walker child (SKILLSMITH_PRUNE_WALKER=1)'
    )
  }
  const startPpid = process.ppid
  const alive = () => process.ppid === startPpid
  const pruneId = crypto.randomBytes(8).toString('hex')
  const out = (partial) =>
    shapeResult({
      path: job.copyPath,
      entry: job.leaf,
      treeHash: job.approvedHash,
      pruneId,
      walkerPid: process.pid,
      ...partial,
    })

  // P4a
  const worse = recheck(job)
  if (worse !== null) return out({ status: 'kept', reason: 'class-worsened', detail: worse })
  if (!alive())
    return out({ status: 'kept', reason: 'stage-failed', detail: 'the parent process is gone' })

  // Metadata this child may remove at P4g: what it writes itself (recorded below),
  // or, for a staged leftover, what the parent inspected and the user confirmed.
  const own = { ...(job.inheritedMeta ?? {}) }
  const wrote = {}
  let S = job.S ?? null
  let sIdentity
  const leaf = job.leaf
  if (S === null) {
    // P4b
    S = path.join(job.trashRoot, `.prune-${crypto.randomBytes(8).toString('hex')}`)
    try {
      fs.mkdirSync(S, { mode: 0o700 })
    } catch (err) {
      return out({ status: 'kept', reason: 'staging-unusable', detail: `mkdir ${S}: ${err.code}` })
    }
    const sd = fs.lstatSync(S, { bigint: true })
    const copyDev = job.rootIdentity.dev
    const bad =
      sd.isSymbolicLink() || !sd.isDirectory()
        ? 'not a directory'
        : SELF_UID !== null && sd.uid !== SELF_UID
          ? 'owned by another user'
          : (sd.mode & 0o077n) !== 0n
            ? `mode ${(sd.mode & 0o777n).toString(8)}`
            : sd.dev !== copyDev
              ? 'on another device than the copy'
              : null
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
    const intent = {
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
      version: 'smi-7123-spike',
    }
    const intentBytes = JSON.stringify(intent, null, 2)
    fs.writeFileSync(path.join(S, 'intent.json'), intentBytes, { flag: 'wx' })
    own['intent.json'] = recordOf(path.join(S, 'intent.json'), intentBytes)
    // P4d
    try {
      fs.renameSync(job.copyPath, path.join(S, leaf))
    } catch (err) {
      // Our own intent only, by inode and exact bytes (Sol c1 finding 2).
      removeIfIdentical(path.join(S, 'intent.json'), own['intent.json'])
      try {
        fs.rmdirSync(S)
      } catch {
        /* not empty: reported by the next listing */
      }
      return out({
        status: 'kept',
        reason: 'stage-failed',
        errno: err.code ?? null,
        detail: `rename into staging failed (${err.code})`,
      })
    }
  } else {
    const sd = fs.lstatSync(S, { bigint: true })
    sIdentity = { type: 'dir', dev: sd.dev, ino: sd.ino, birthtimeNs: sd.birthtimeNs }
  }
  const leafPath = path.join(S, leaf)
  const held = (reason, detail) =>
    out({ status: 'held', reason, detail, path: leafPath, heldPath: leafPath, stagingPath: S })

  // P4d'
  const stagedSidecar = path.join(S, 'sidecar.json')
  if (job.sidecarRead !== null && job.sidecarPath !== stagedSidecar) {
    try {
      fs.renameSync(job.sidecarPath, stagedSidecar)
    } catch (err) {
      return held(
        'sidecar-stage-failed',
        `sidecar rename failed (${err.code}); the copy is whole at ${leafPath}`
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
  // P4f
  let del
  try {
    del = deleteVerified(S, leaf, v.inventory, sIdentity, {
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
      stagingPath: S,
      ...err.extra,
    })
  } finally {
    try {
      process.chdir(job.trashRoot)
    } catch {
      /* the child exits next */
    }
  }
  // P4g. Sol c1 finding 2: a metadata file is removed only if it is exactly what
  // this run wrote (or what the parent inspected for this confirmed staged copy),
  // by inode and bytes, re-checked immediately before unlink. Otherwise it is
  // kept and reported in `metadataKept`.
  const metadataKept = []
  for (const m of ['deleting', 'intent.json']) {
    const r = removeIfIdentical(path.join(S, m), wrote[m] ?? own[m])
    if (!r.removed && r.kept !== null) metadataKept.push(r.kept)
  }
  let sKept = null
  if (exists(path.join(S, 'misplaced.json'))) sKept = 'misplaced.json kept for the next listing'
  else {
    try {
      fs.rmdirSync(S)
    } catch (err) {
      sKept = `staging directory left (${err.code})`
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

// Child entry: one job as JSON on stdin, one ItemResult as JSON on stdout. This
// module exports nothing (PR-17).
if (IS_ENTRY) {
  const job = decodeJob(JSON.parse(fs.readFileSync(0, 'utf8')))
  const r = stageVerifyDelete(job)
  process.stdout.write(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n')
}
