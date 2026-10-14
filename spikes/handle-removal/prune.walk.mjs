// SMI-7123 Wave 5 (design §1 P4a-g, §3): stage, verify at the staging path, and
// delete only verified entries. CHILD PROCESS ONLY (§3.4): the walk chdirs,
// and process.chdir changes the whole process's cwd.
//
// fs is the DEFAULT export, looked up at call time (the harness interposes it).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { computeTreeHash } from './hash.mjs'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './quarantine.mounts.mjs'
import { readStable } from './prune.sidecar.mjs'
import { shapeResult } from './result-shape.mjs'
import { decodeJob } from './prune.job.mjs'

const SELF_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
const SIDECAR_KEY = '\0sidecar'
const META = new Set(['intent.json', 'deleting', 'sidecar.json', 'misplaced.json'])
const rand = () => `.d-${crypto.randomBytes(8).toString('hex')}`

class Stop extends Error {
  constructor(status, reason, detail = null, extra = {}) {
    super(`${status}/${reason}`)
    Object.assign(this, { status, reason, detail, extra })
  }
}

const typeOf = (s) =>
  s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other'
const rowOf = (s) => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeNs: s.birthtimeNs,
  type: typeOf(s),
  mode: s.mode,
  size: s.size,
  mtimeNs: s.mtimeNs,
  ctimeNs: s.ctimeNs,
})
const sameDirId = (w, s) =>
  w &&
  w.type === 'dir' &&
  s.isDirectory() &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.birthtimeNs === s.birthtimeNs
const sameLeafPost = (w, s) =>
  w &&
  w.type !== 'dir' &&
  w.dev === s.dev &&
  w.ino === s.ino &&
  w.type === typeOf(s) &&
  w.mode === s.mode &&
  w.size === s.size &&
  w.mtimeNs === s.mtimeNs
const sameLeafPre = (w, s) => sameLeafPost(w, s) && w.ctimeNs === s.ctimeNs

/** Linux: mountinfo points at or under abs (real path). {ok:false} fails closed. */
function mountFinding(abs) {
  if (!MOUNTINFO_APPLIES) return null
  let real
  try {
    real = fs.realpathSync(abs)
  } catch (err) {
    return `realpath failed (${err.code})`
  }
  const m = readMountPointsAtOrUnder(real)
  if (!m.ok) return `mountinfo unreadable (${m.errno}); a bind mount cannot be ruled out`
  return m.points.length > 0 ? `mount point ${m.points[0]}` : null
}

/**
 * §3.1: walk S/leaf with lstat (st_dev checked against the root), stable-read
 * every file, hash, and build the inventory; then stable-read S/sidecar.json
 * and require it to be the very inode and bytes approved at P4a.
 * @returns {{ok:true, inventory:Map, hash:string}|{ok:false, reason:string, detail:string}}
 */
export function verifyAtStaging(S, leaf, { approvedHash, rootIdentity, sidecar }) {
  const no = (reason, detail) => ({ ok: false, reason, detail })
  const leafPath = path.join(S, leaf)
  let top
  try {
    top = fs.lstatSync(leafPath, { bigint: true })
  } catch (err) {
    return no('unreadable-in-staging', `staged copy unreadable (${err.code})`)
  }
  if (
    top.dev !== rootIdentity.dev ||
    top.ino !== rootIdentity.ino ||
    top.birthtimeNs !== rootIdentity.birthtimeNs
  ) {
    return no('changed-in-staging', 'the staged copy is not the inode that was approved')
  }
  const mi = mountFinding(leafPath)
  if (mi !== null) return no('mount-in-staging', mi)
  const record = new Map()
  const inventory = new Map()
  const visit = (rel, abs) => {
    const st = fs.lstatSync(abs, { bigint: true })
    if (st.dev !== top.dev) return no('mount-in-staging', `mount at ${rel || '.'} (st_dev differs)`)
    const mode = Number(st.mode)
    inventory.set(rel, rowOf(st))
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size: st.size })
      for (const n of fs.readdirSync(abs).sort()) {
        const r = visit(rel ? `${rel}/${n}` : n, path.join(abs, n))
        if (r) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      record.set(rel, { type: 'symlink', mode, size: st.size, linkText: fs.readlinkSync(abs) })
      return null
    }
    if (st.isFile()) {
      const rs = readStable(abs)
      if (!rs.ok)
        return no(
          rs.reason === 'unreadable' ? 'unreadable-in-staging' : 'changed-in-staging',
          `${rel}: ${rs.reason}`
        )
      if (
        rs.ino !== st.ino ||
        rs.size !== st.size ||
        rs.mtimeNs !== st.mtimeNs ||
        rs.ctimeNs !== st.ctimeNs
      ) {
        return no('changed-in-staging', `${rel} changed while it was verified`)
      }
      record.set(rel, {
        type: 'file',
        mode,
        size: st.size,
        contentHash: crypto.createHash('sha256').update(rs.bytes).digest('hex'),
      })
      return null
    }
    return no('unreadable-in-staging', `${rel}: unsupported entry type`)
  }
  let failure
  try {
    failure = visit('', leafPath)
  } catch (err) {
    return no('unreadable-in-staging', `walk failed (${err.code ?? err.message})`)
  }
  if (failure) return failure
  const hash = computeTreeHash(record)
  if (hash !== approvedHash)
    return no('changed-in-staging', 'tree hash at the staging path differs from the approved hash')
  if (sidecar) {
    const rs = readStable(path.join(S, 'sidecar.json'))
    if (!rs.ok) return no('sidecar-changed-in-staging', `staged sidecar: ${rs.reason}`)
    if (rs.ino !== sidecar.ino || !rs.bytes.equals(sidecar.bytes)) {
      return no(
        'sidecar-changed-in-staging',
        'the staged sidecar is not the approved inode and bytes'
      )
    }
    inventory.set(SIDECAR_KEY, {
      dev: rs.dev,
      ino: rs.ino,
      birthtimeNs: null,
      type: 'file',
      mode: rs.mode,
      size: rs.size,
      mtimeNs: rs.mtimeNs,
      ctimeNs: rs.ctimeNs,
    })
  }
  return { ok: true, inventory, hash }
}

/**
 * §3.2: the deletion walk. Unlinks only an inode whose row matched one syscall
 * earlier, by a random name in a directory it has entered and re-identified.
 * @returns {{status:'removed', deleted:number}} or throws Stop
 */
export function deleteVerified(S, leaf, inventory, sIdentity, ctx = {}) {
  let deleted = 0
  const segs = []
  const alive = ctx.alive ?? (() => true)
  const stop = (reason, detail) => new Stop('stopped', reason, detail, { deleted })
  const cwdIs = (want, at) => {
    const s = fs.statSync('.', { bigint: true })
    if (!sameDirId(want, s))
      throw stop(
        'mount-appeared-during-delete',
        `the current directory is no longer ${at || 'the staged root'}`
      )
  }
  const errnoStop = (err, at) => {
    if (err instanceof Stop) return err
    if (err.code === 'EBUSY') return stop('mount-appeared-during-delete', `${at}: EBUSY`)
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')
      return stop('entry-added-during-delete', `${at}: ${err.code}`)
    return Object.assign(stop('delete-failed', `${at}: ${err.code ?? err.message}`), {
      errno: err.code ?? null,
    })
  }
  const misplaced = (r, originalRel, curWant) => {
    let cause = 'cwd-covered'
    try {
      if (sameDirId(curWant, fs.statSync('.', { bigint: true }))) cause = 'swapped'
    } catch {
      /* unreadable cwd: covered */
    }
    const abs = originalRel === SIDECAR_KEY ? path.join(S, r) : path.join(S, leaf, ...segs, r)
    let lst = null
    try {
      const s = fs.lstatSync(r, { bigint: true })
      lst = { dev: String(s.dev), ino: String(s.ino), type: typeOf(s), size: String(s.size) }
    } catch {
      /* gone */
    }
    const rec = {
      pruneId: ctx.pruneId ?? null,
      path: abs,
      originalRel,
      cause,
      at: new Date().toISOString(),
      lstat: lst,
    }
    let misplacedRecordError = null
    try {
      fs.writeFileSync(path.join(S, 'misplaced.json'), JSON.stringify(rec, null, 2), { flag: 'wx' })
    } catch (err) {
      misplacedRecordError = err.code ?? err.message
    }
    return new Stop(
      'stopped',
      'entry-misplaced',
      `${originalRel === SIDECAR_KEY ? 'the sidecar' : originalRel} was renamed to ${abs} and left there`,
      {
        deleted,
        misplaced: [{ path: abs, originalRel, cause }],
        ...(misplacedRecordError === null ? {} : { misplacedRecordError }),
      }
    )
  }
  const deleteLeaf = (n, crel, want, curWant) => {
    const s = fs.lstatSync(n, { bigint: true })
    if (!sameLeafPre(want, s))
      throw stop('changed-during-delete', `${crel} changed after it was verified`)
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
  const walkDir = (rel) => {
    const curWant = inventory.get(rel)
    for (const n of fs.readdirSync('.').sort()) {
      if (!alive()) throw stop('delete-failed', 'the parent process is gone')
      const crel = rel ? `${rel}/${n}` : n
      const want = inventory.get(crel)
      if (!want)
        throw stop('entry-added-during-delete', `${crel} was not in the verified inventory`)
      cwdIs(curWant, rel)
      const s = fs.lstatSync(n, { bigint: true })
      if (want.type !== 'dir') {
        deleteLeaf(n, crel, want, curWant)
        continue
      }
      if (!s.isDirectory()) throw stop('changed-during-delete', `${crel} is no longer a directory`)
      if (!sameDirId(want, s))
        throw stop(
          'mount-appeared-during-delete',
          `${crel}: directory identity changed (a mount root or a replaced directory)`
        )
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
      if (fs.readdirSync('.').length !== 0)
        throw stop('entry-added-during-delete', `${crel} gained an entry`)
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
    if (!ctx.resume)
      fs.writeFileSync(
        'deleting',
        JSON.stringify({ pruneId: ctx.pruneId ?? null, pid: process.pid }),
        { flag: 'wx' }
      )
    const sc = inventory.get(SIDECAR_KEY)
    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)
    const s = fs.lstatSync(leaf, { bigint: true })
    if (!sameDirId(inventory.get(''), s)) {
      if (inventory.get('').type !== 'dir') {
        deleteLeaf(leaf, '', inventory.get(''), sIdentity)
        return { status: 'removed', deleted }
      }
      throw stop('mount-appeared-during-delete', 'the staged root changed identity')
    }
    process.chdir(leaf)
    cwdIs(inventory.get(''), '')
    walkDir('')
    if (fs.readdirSync('.').length !== 0)
      throw stop('entry-added-during-delete', 'the staged root gained an entry')
    process.chdir('..')
    cwdIs(sIdentity, 'S')
    try {
      fs.rmdirSync(leaf)
    } catch (err) {
      throw errnoStop(err, '.')
    }
    deleted += 1
    return { status: 'removed', deleted }
  } catch (err) {
    throw errnoStop(err, 'walk')
  }
}

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

/**
 * P4a-g for one approved item. Throws unless running as the dedicated walker
 * child (§3.4). Returns one shaped ItemResult.
 */
export function stageVerifyDelete(job) {
  if (!isMainThread || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {
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
    fs.writeFileSync(path.join(S, 'intent.json'), JSON.stringify(intent, null, 2), { flag: 'wx' })
    // P4d
    try {
      fs.renameSync(job.copyPath, path.join(S, leaf))
    } catch (err) {
      try {
        fs.unlinkSync(path.join(S, 'intent.json'))
        fs.rmdirSync(S)
      } catch {
        /* our own metadata; reported by the next listing */
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
  // P4g
  for (const m of ['deleting', 'intent.json']) {
    try {
      fs.unlinkSync(path.join(S, m))
    } catch {
      /* absent is fine */
    }
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
  return out({ status: 'removed', deleted: del.deleted, ...(sKept ? { detail: sKept } : {}) })
}

export { META, SIDECAR_KEY }

// Child entry: one job as JSON on stdin, one ItemResult as JSON on stdout.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const job = decodeJob(JSON.parse(fs.readFileSync(0, 'utf8')))
  const r = stageVerifyDelete(job)
  process.stdout.write(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n')
}
