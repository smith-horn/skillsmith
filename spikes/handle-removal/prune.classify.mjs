// SMI-7123 Wave 5 (design §1 P1-P2, §5): list the trash and classify each copy.
//
// Read-only. Nothing here writes, renames or deletes. fs is the DEFAULT export,
// looked up at call time, so the harness interposer sees every call.

import fs from 'node:fs'
import path from 'node:path'
import { computeTreeHash } from './hash.mjs'
import { pathTreeRecord } from './quarantine.postmove.mjs'
import { MOUNTINFO_APPLIES, readMountPointsAtOrUnder } from './quarantine.mounts.mjs'
import { readStable, parseSidecarStrict } from './prune.sidecar.mjs'
import { readParkedIndex } from './trash-index.mjs'

const SELF_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
export const TRASH_DIR = '.skillsmith-trash'
export const STAGING_PREFIX = '.prune-'

/** Linux mountinfo points at or under `abs` (real path taken here). {ok:false} fails closed. */
function mountsAtOrUnder(abs) {
  if (!MOUNTINFO_APPLIES) return { ok: true, points: [] }
  let real
  try {
    real = fs.realpathSync(abs)
  } catch (err) {
    return { ok: false, errno: err.code ?? null }
  }
  return readMountPointsAtOrUnder(real)
}

/** Linux: is there a mountinfo point exactly AT `abs`? Unreadable => true (fail closed). */
function mountAt(abs) {
  if (!MOUNTINFO_APPLIES) return false
  const m = mountsAtOrUnder(abs)
  if (!m.ok) return true
  let real
  try {
    real = fs.realpathSync(abs)
  } catch {
    return true
  }
  return m.points.includes(real)
}

/**
 * P1 (§1): every root's trash, its op dirs, copies, staging leftovers and
 * orphan sidecars. A trash root that fails its checks is refused whole.
 */
export function listTrash({ roots, indexPath }) {
  const out = []
  for (const root of roots) out.push(listOne(path.resolve(root)))
  let index = { present: false, errors: [], stale: [] }
  if (typeof indexPath === 'string') {
    const idx = readParkedIndex(indexPath)
    const listed = new Set()
    for (const r of out) for (const c of r.copies) listed.add(c.copyPath)
    const scanned = out.map((r) => r.trashRoot)
    const inScanned = (p) => scanned.some((t) => p.startsWith(t + path.sep))
    const indexed = new Set(idx.entries.map((e) => e.path))
    for (const r of out)
      for (const c of r.copies) c.index = indexed.has(c.copyPath) ? 'present' : 'missing'
    // An entry whose copy is gone is not an error (Q8 b); an entry under a root
    // that was not scanned is not listed (Q8 c).
    const stale = idx.entries.filter((e) => inScanned(e.path) && !listed.has(e.path))
    index = { present: idx.present, errors: idx.errors, stale: stale.map((e) => e.path) }
  } else {
    for (const r of out) for (const c of r.copies) c.index = 'not-checked'
  }
  return { roots: out, index }
}

function listOne(root) {
  const trashRoot = path.join(root, TRASH_DIR)
  const entry = {
    root,
    trashRoot,
    absent: false,
    refused: null,
    detail: null,
    copies: [],
    leftovers: [],
    orphanSidecars: [],
    anomalies: [],
  }
  const refuse = (detail) =>
    Object.assign(entry, {
      refused: 'trash-root-unusable',
      detail,
      copies: [],
      leftovers: [],
      orphanSidecars: [],
    })
  let rootSt
  let ts
  try {
    rootSt = fs.statSync(root, { bigint: true })
  } catch (err) {
    return refuse(`root unreadable (${err.code})`)
  }
  try {
    ts = fs.lstatSync(trashRoot, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return Object.assign(entry, { absent: true })
    return refuse(`trash root unreadable (${err.code})`)
  }
  if (ts.isSymbolicLink() || !ts.isDirectory()) return refuse('trash root is not a real directory')
  if (ts.dev !== rootSt.dev) return refuse('trash root is on another device than its root')
  if (SELF_UID !== null && ts.uid !== SELF_UID) return refuse('trash root is owned by another user')
  if (mountAt(trashRoot)) return refuse('a mount point is at the trash root')
  let names
  try {
    names = fs.readdirSync(trashRoot).sort()
  } catch (err) {
    return refuse(`trash root unreadable (${err.code})`)
  }
  for (const n of names) {
    const abs = path.join(trashRoot, n)
    if (n.startsWith(STAGING_PREFIX)) {
      entry.leftovers.push({ root, trashRoot, S: abs, name: n })
      continue
    }
    if (n.startsWith('.')) continue
    let od
    try {
      od = fs.lstatSync(abs, { bigint: true })
    } catch (err) {
      entry.anomalies.push({ path: abs, detail: `unreadable (${err.code})` })
      continue
    }
    if (od.isSymbolicLink() || !od.isDirectory()) {
      entry.anomalies.push({ path: abs, detail: 'op entry is not a real directory; never touched' })
      continue
    }
    if (mountAt(abs)) return refuse(`a mount point is at op dir ${n}`)
    let inner
    try {
      inner = fs.readdirSync(abs).sort()
    } catch (err) {
      entry.anomalies.push({ path: abs, detail: `op dir unreadable (${err.code})` })
      continue
    }
    const set = new Set(inner)
    for (const x of inner) {
      const xp = path.join(abs, x)
      if (x.endsWith('.json') && isFile(xp)) {
        if (!set.has(x.slice(0, -5))) entry.orphanSidecars.push(xp)
        continue
      }
      entry.copies.push({
        root,
        trashRoot,
        opId: n,
        opDir: abs,
        name: x,
        copyPath: xp,
        sidecarPath: `${xp}.json`,
      })
    }
  }
  return entry
}

function isFile(p) {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

const idOf = (st) => ({ dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs })

/**
 * P2 (§1): first match wins -- mounted, held, unverified, changed, clean.
 * `copy.schemaCopyPath` / `copy.schemaOpDir` let a staged copy be checked
 * against the path its sidecar names (the pre-staging trash path).
 *
 * @returns {{klass, reason, detail, freshHash, recordedHash, rootIdentity, sidecarRead, sidecar}}
 */
export function classifyCopy(copy) {
  const res = (klass, reason, extra = {}) => ({
    klass,
    reason,
    detail: null,
    freshHash: null,
    recordedHash: null,
    rootIdentity: null,
    sidecarRead: null,
    sidecar: null,
    ...extra,
  })
  let rootSt
  try {
    rootSt = fs.lstatSync(copy.copyPath, { bigint: true })
  } catch (err) {
    return res('unverified', 'tree-unreadable', { detail: `copy unreadable (${err.code})` })
  }
  const rootIdentity = idOf(rootSt)
  const base = { rootIdentity }

  // -- mounted ---------------------------------------------------------------
  const mi = mountsAtOrUnder(copy.copyPath)
  if (!mi.ok)
    return res('mounted', 'mountinfo-unreadable', {
      ...base,
      detail: `mountinfo unreadable (${mi.errno}); a bind mount cannot be ruled out`,
    })
  if (mi.points.length > 0)
    return res('mounted', 'mount-point', { ...base, detail: `mount point ${mi.points[0]}` })
  const parentDir = copy.schemaOpDir === undefined ? copy.opDir : path.dirname(copy.copyPath)
  try {
    if (fs.lstatSync(parentDir, { bigint: true }).dev !== rootSt.dev) {
      return res('mounted', 'copy-root-other-device', {
        ...base,
        detail: 'the copy root is on another device than its directory',
      })
    }
  } catch (err) {
    return res('unverified', 'tree-unreadable', {
      ...base,
      detail: `directory unreadable (${err.code})`,
    })
  }
  const walk = pathTreeRecord(copy.copyPath, { mountCheck: true })
  if (!walk.ok && walk.reason === 'mount-inside-tree') {
    return res('mounted', 'mount-inside-tree', {
      ...base,
      detail: `mount at ${walk.rel} (st_dev differs from the root)`,
    })
  }

  // -- held (sidecar absent / unreadable / unparseable / hold:true / interrupted)
  if (copy.interruptedDelete === true) {
    const fresh = walk.ok ? computeTreeHash(walk.record) : null
    return res('held', 'interrupted-delete', {
      ...base,
      freshHash: fresh,
      detail: 'prune stopped part-way through deleting this copy',
    })
  }
  let sidecarRead = null
  let parsedJson = null
  const sp = copy.sidecarPath
  if (sp === null || !exists(sp)) {
    const fresh = walk.ok ? computeTreeHash(walk.record) : null
    return res('held', 'sidecar-absent', { ...base, freshHash: fresh, detail: 'no sidecar' })
  }
  sidecarRead = readStable(sp)
  if (!sidecarRead.ok) {
    return res('held', 'sidecar-unreadable', {
      ...base,
      sidecarRead: null,
      detail: `${sidecarRead.reason}${sidecarRead.errno ? ` (${sidecarRead.errno})` : ''}`,
    })
  }
  try {
    parsedJson = JSON.parse(sidecarRead.bytes.toString('utf8'))
  } catch {
    return res('held', 'sidecar-unparseable', { ...base, sidecarRead })
  }
  const fresh = walk.ok ? computeTreeHash(walk.record) : null
  const withRead = { ...base, sidecarRead, freshHash: fresh }
  if (parsedJson !== null && typeof parsedJson === 'object' && parsedJson.hold === true) {
    return res('held', 'hold', {
      ...withRead,
      sidecar: parsedJson,
      recordedHash: parsedJson.postMoveTreeHash ?? null,
    })
  }

  // -- unverified --------------------------------------------------------------
  const strict = parseSidecarStrict(sidecarRead.bytes, {
    copyPath: copy.schemaCopyPath ?? copy.copyPath,
    opDirName: path.basename(copy.schemaOpDir ?? copy.opDir),
  })
  if (!strict.ok) return res('unverified', 'schema-invalid', { ...withRead, detail: strict.detail })
  if (strict.shape === 'U')
    return res('unverified', 'treehash-null', {
      ...withRead,
      sidecar: strict.sidecar,
      detail: 'parked without a guard hash',
    })
  if (!walk.ok)
    return res('unverified', 'tree-unreadable', {
      ...withRead,
      sidecar: strict.sidecar,
      detail: `${walk.reason} at ${walk.path}`,
    })

  // -- changed / clean -----------------------------------------------------------
  const recordedHash = strict.sidecar.postMoveTreeHash
  if (fresh !== recordedHash)
    return res('changed', 'hash-differs', { ...withRead, sidecar: strict.sidecar, recordedHash })
  return res('clean', null, { ...withRead, sidecar: strict.sidecar, recordedHash })
}

function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function sizeOf(abs) {
  let total = 0
  const visit = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    total += st.size
    if (st.isDirectory()) {
      let names = []
      try {
        names = fs.readdirSync(p)
      } catch {
        return
      }
      for (const n of names) visit(path.join(p, n))
    }
  }
  visit(abs)
  return total
}

export const human = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)} KB`
        : `${n} B`

/** Q9: one block per root -- path, size, age, origin, class -- and where the trash sits. */
export function formatTrashReport(listing, now = Date.now()) {
  const lines = []
  for (const r of listing.roots) {
    if (r.absent) continue
    if (r.refused) {
      lines.push(`${r.trashRoot}: not used (${r.detail}). Nothing in it is listed or deleted.`)
      continue
    }
    const rows = r.copies.map((c) => ({ c, k: c.cls ?? classifyCopy(c) }))
    const bytes = rows.reduce((n, { c }) => n + sizeOf(c.copyPath), 0)
    lines.push(`Trash next to your skill folders: ${rows.length} copies, ${human(bytes)}`)
    lines.push(
      `Skillsmith parked these copies in ${r.trashRoot}, next to your own directory ${r.root}. ` +
        'Nothing here is deleted automatically.'
    )
    for (const { c, k } of rows) {
      const origin = k.sidecar?.originPath ?? readOrigin(c.sidecarPath) ?? 'unknown'
      const created = Date.parse(k.sidecar?.createdAt ?? '')
      const ageMs = Number.isNaN(created) ? now - fs.lstatSync(c.copyPath).mtimeMs : now - created
      const age = `${Math.max(0, Math.floor(ageMs / 86400000))}d`
      const why = k.reason ? ` (${k.reason})` : ''
      lines.push(
        `  ${k.klass}${why}  ${human(sizeOf(c.copyPath))}  ${age}  ${c.copyPath}  origin: ${origin}`
      )
    }
    for (const l of r.leftovers) lines.push(`  staging leftover: ${l.S}`)
    for (const o of r.orphanSidecars) lines.push(`  orphan sidecar (its copy is gone): ${o}`)
  }
  return lines.join('\n')
}

function readOrigin(p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8')).originPath
    return typeof o === 'string' ? o : null
  } catch {
    return null
  }
}
