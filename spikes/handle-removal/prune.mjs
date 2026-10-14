// SMI-7123 Wave 5 (design §1, §4, §7.1): verified prune -- move aside, verify,
// delete. Replaces D-2's C0-walk prune.
//
// The parent never chdirs and never deletes a user entry itself: every approved
// item runs in a dedicated walker child (prune.walk.mjs, §3.4). The parent only
// lists, classifies, asks, and removes Skillsmith's own staging metadata (§4).
//
// fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listTrash, classifyCopy, human } from './prune.classify.mjs'
import { inspectLeftover } from './prune.leftovers.mjs'
import { encodeJob } from './prune.job.mjs'
import { shapeResult } from './result-shape.mjs'
import { removeIfIdentical } from './prune.metadata.mjs'

/** Leftover states holding only Skillsmith's metadata (§4); cleaned only after a batch yes. */
const CLEANABLE = new Set(['empty', 'intent-only', 'finished'])

/** §7.1, verbatim. Shown after the count and size. */
export const CONFIRMATION_TEXT =
  'deletes them permanently; nothing restores them. Each copy is moved aside, checked against the ' +
  'hash Skillsmith recorded when it parked it, and only then deleted. A program that has a file open ' +
  'inside a copy can still write to it while it is being deleted, and those writes are lost. If a ' +
  'file changes at the exact moment prune reaches it, prune stops and tells you where that file now ' +
  'is.'

export const DEFAULT_WALKER = fileURLToPath(new URL('./prune.walk.mjs', import.meta.url))

const held = new Set()
/** Spike lock 1: in-process and exclusive per real root. Production lock 1 is SMI-6531. */
export function inProcessLock(root) {
  let key
  try {
    key = fs.realpathSync(root)
  } catch {
    key = path.resolve(root)
  }
  if (held.has(key)) return null
  held.add(key)
  return () => held.delete(key)
}

const kept = (copy, reason, detail = null) =>
  shapeResult({ status: 'kept', reason, path: copy.copyPath, entry: copy.name, detail })

function sizeOf(abs) {
  let n = 0
  const visit = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    n += st.size
    if (st.isDirectory()) for (const c of fs.readdirSync(p)) visit(path.join(p, c))
  }
  visit(abs)
  return n
}

/**
 * Runs one approved item in the walker child and returns its ItemResult.
 * `walker` is a spike seam: {path, execArgv, env, stdio} -- the harness uses it
 * to interpose fs in the child and to run named stubs.
 */
export function runWalker(job, walker = {}) {
  const args = [...(walker.execArgv ?? []), walker.path ?? DEFAULT_WALKER]
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify(encodeJob(job)),
    env: { ...process.env, ...(walker.env ?? {}), SKILLSMITH_PRUNE_WALKER: '1' },
    stdio: walker.stdio ?? ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const lines = String(r.stdout ?? '')
    .trim()
    .split('\n')
  try {
    const parsed = JSON.parse(lines[lines.length - 1])
    if (parsed && typeof parsed.status === 'string') return parsed
  } catch {
    /* fall through */
  }
  return shapeResult({
    status: 'stopped',
    reason: 'walker-died',
    path: job.copyPath,
    entry: job.leaf,
    detail: `walker exited status=${r.status} signal=${r.signal}: ${String(r.stderr ?? '').slice(0, 400)}`,
  })
}

/**
 * @returns {{plan:object, items:object[], exitCode:number}}
 */
export function prune({
  roots,
  indexPath,
  apply = false,
  allowChanged = false,
  confirmBatch,
  confirmItem,
  isTTY = false,
  lock = inProcessLock,
  walker = {},
}) {
  // P0
  const releases = []
  for (const root of roots) {
    const rel = lock(root)
    if (typeof rel !== 'function') {
      for (const f of releases) f()
      return { plan: { refused: 'lock-unavailable', root }, items: [], exitCode: 4 }
    }
    releases.push(rel)
  }
  try {
    return pruneLocked({
      roots,
      indexPath,
      apply,
      allowChanged,
      confirmBatch,
      confirmItem,
      isTTY,
      walker,
    })
  } finally {
    for (const f of releases) f()
  }
}

function pruneLocked({
  roots,
  indexPath,
  apply,
  allowChanged,
  confirmBatch,
  confirmItem,
  isTTY,
  walker,
}) {
  // P1
  const listing = listTrash({ roots, indexPath })
  const entries = []
  const leftovers = []
  const refused = []
  for (const r of listing.roots) {
    if (r.refused) {
      refused.push({ trashRoot: r.trashRoot, reason: r.refused, detail: r.detail })
      continue
    }
    for (const copy of r.copies) entries.push({ copy, cls: classifyCopy(copy), from: 'trash' })
    for (const l of r.leftovers) {
      const ins = inspectLeftover(l)
      leftovers.push(ins)
      if (ins.item) {
        const cls =
          ins.state === 'staged-orphan'
            ? { ...classifyCopy(ins.item), klass: 'unverified', reason: 'staged-orphan' }
            : classifyCopy(ins.item)
        entries.push({ copy: ins.item, cls, from: ins.state })
      }
    }
  }
  // P2 summary
  const totals = {}
  for (const e of entries) {
    const t = (totals[e.cls.klass] ??= { count: 0, bytes: 0 })
    t.count += 1
    t.bytes += sizeOf(e.copy.copyPath)
  }
  const plan = {
    totals,
    count: entries.length,
    bytes: Object.values(totals).reduce((n, t) => n + t.bytes, 0),
    rows: entries.map((e) => ({
      path: e.copy.copyPath,
      klass: e.cls.klass,
      reason: e.cls.reason,
      detail: e.cls.detail,
      from: e.from,
    })),
    refused,
    leftovers: leftovers.map((l) => ({ S: l.S, state: l.state, detail: l.detail ?? null })),
    misplaced: leftovers.filter((l) => l.misplaced).map((l) => l.misplaced),
    index: listing.index,
    confirmationText: CONFIRMATION_TEXT,
  }
  plan.summary = `${entries.length} copies, ${human(plan.bytes)}`
  if (!apply) return { plan, items: [], exitCode: 0 }

  // §4 + Sol c1 finding 2: nothing is deleted without confirmation, anywhere. Pure
  // metadata leftovers are listed in the clean-tier batch prompt below and cleaned
  // only after a yes, and only files still identical to what was inspected.
  const metaLeftovers = leftovers.filter((l) => CLEANABLE.has(l.state))

  // P3
  const items = []
  const approved = []
  const clean = []
  for (const e of entries) {
    const { copy, cls } = e
    if (cls.klass === 'mounted') items.push(kept(copy, 'mounted', cls.detail))
    else if (cls.klass === 'unverified' && cls.reason === 'tree-unreadable')
      items.push(kept(copy, 'unreadable', cls.detail))
    else if (cls.klass === 'clean') clean.push(e)
    else if (!allowChanged)
      items.push(
        kept(copy, 'needs-allow-changed', `${cls.klass}${cls.reason ? `/${cls.reason}` : ''}`)
      )
    else if (!isTTY)
      items.push(kept(copy, 'not-confirmed', 'no TTY: non-clean copies need a per-item yes'))
    else if (typeof cls.freshHash !== 'string')
      items.push(kept(copy, 'unreadable', 'no fresh hash to approve'))
    else {
      const yes =
        typeof confirmItem === 'function' &&
        confirmItem({
          path: copy.copyPath,
          klass: cls.klass,
          reason: cls.reason,
          recordedHash: cls.recordedHash,
          freshHash: cls.freshHash,
        }) === true
      if (yes) approved.push({ ...e, approvedHash: cls.freshHash, authorization: 'per-item' })
      else items.push(kept(copy, 'not-confirmed'))
    }
  }
  const cleanups = []
  if (clean.length > 0 || metaLeftovers.length > 0) {
    const views = [
      ...clean.map((e) => ({
        path: e.copy.copyPath,
        klass: 'clean',
        recordedHash: e.cls.recordedHash,
      })),
      ...metaLeftovers.map((l) => ({ path: l.S, klass: 'metadata', state: l.state })),
    ]
    const yes =
      typeof confirmBatch === 'function' && confirmBatch(views, CONFIRMATION_TEXT) === true
    for (const e of clean) {
      if (yes) approved.push({ ...e, approvedHash: e.cls.recordedHash, authorization: 'batch' })
      else items.push(kept(e.copy, 'not-confirmed'))
    }
    for (const l of metaLeftovers) {
      cleanups.push(yes ? cleanLeftover(l) : { S: l.S, state: l.state, result: 'not-confirmed' })
    }
  }

  // P4
  const walked = []
  for (const a of approved) {
    const c = a.copy
    const job = {
      copyPath: c.copyPath,
      // Kept even when absent, so P4a can see a sidecar that appeared since P2.
      sidecarPath: c.sidecarPath ?? `${c.copyPath}.json`,
      leaf: c.name,
      approvedHash: a.approvedHash,
      rootIdentity: a.cls.rootIdentity,
      sidecarRead: a.cls.sidecarRead ?? null,
      trashRoot: c.trashRoot,
      opDir: c.opDir,
      klass: a.cls.klass,
      authorization: a.authorization,
      ...(c.staged
        ? { S: c.S, resume: c.interruptedDelete === true, inheritedMeta: c.inheritedMeta ?? {} }
        : {}),
    }
    const res = runWalker(job, walker)
    walked.push(res)
    items.push(res)
  }
  // P5: 0 only if every approved item is `removed` (vacuously 0 when none was approved).
  const exitCode = walked.every((r) => r.status === 'removed') ? 0 : 4
  return { plan, items, exitCode, cleanups }
}

/** §4: remove only our own metadata, only in the states where it is all there is. */
// Called only after the batch yes. Each metadata file is removed only if it is still
// the inode and bytes recorded at inspection (prune.metadata.mjs); anything else is
// kept and reported. The staging dir is removed with rmdir(2), so only if empty.
function cleanLeftover(l) {
  const kept = []
  for (const m of l.cleanup ?? []) {
    const r = removeIfIdentical(path.join(l.S, m), l.meta?.[m])
    if (!r.removed && r.kept !== null) kept.push(r.kept)
  }
  let dir = 'kept'
  if (!l.misplaced) {
    try {
      fs.rmdirSync(l.S)
      dir = 'removed'
    } catch (err) {
      dir = `kept (${err.code})`
    }
  }
  return { S: l.S, state: l.state, result: kept.length ? 'metadata-kept' : 'cleaned', dir, kept }
}
