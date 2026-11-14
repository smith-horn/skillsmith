/**
 * SMI-6531 (A1 step 6c-ii-a): list one `.skillsmith-parked` area, read-only
 * (ADR-166 D-11 P1), ported from the SMI-6676 spike's `prune.classify.mjs`
 * `listOne`.
 *
 * An area that fails its checks (a real directory, on the device of the
 * directory holding it, owned by us, with no mount at it or at an op dir) is
 * refused whole: nothing in it is listed, and nothing in it can be selected.
 * Every entry is read with lstat and none is followed. A `.prune-*` entry is
 * handed to `inspectLeftover`, which reads it without touching it. A copy
 * with no sidecar is still listed; the classifier calls it held. A hidden
 * entry (a dot-name that is not `.prune-*`, or in an op dir not a parked copy of
 * a dot-named entry) is an anomaly in both places, never a copy and never
 * dropped.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.list.parked
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { inspectLeftover } from './prune.leftovers.js'
import { mountAt } from './prune.classify.js'
import type { ListedCopy, ParkedAreaListing } from './prune.list.types.js'

/** The parked area's directory name, under the directory it sits next to. */
export const PARKED_DIR = '.skillsmith-parked'
/** A staging directory's name prefix. */
export const STAGING_PREFIX = '.prune-'
/** The name of a parked copy of a dot-named entry: `<name>-<8 hex>` (ADR-166 D-3). */
const HIDDEN_COPY_RE = /^\..+-[0-9a-f]{8}$/

export const SELF_UID = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null

const isFile = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** The area's own checks; a reason to refuse it whole, or null. */
function refusal(root: string, areaDir: string, ts: BigIntStats): string | null {
  let rootSt: BigIntStats
  try {
    rootSt = fs.statSync(root, { bigint: true })
  } catch (err) {
    return `root unreadable (${errCode(err)})`
  }
  if (ts.isSymbolicLink() || !ts.isDirectory()) return 'set-aside area is not a real directory'
  if (ts.dev !== rootSt.dev) return 'set-aside area is on another device than its directory'
  if (SELF_UID !== null && ts.uid !== SELF_UID) return 'set-aside area is owned by another user'
  if (mountAt(areaDir)) return 'a mount point is at the set-aside area'
  return null
}

/** One op directory's copies and orphan sidecars. Returns a refusal when a mount sits at it. */
function listOpDir(entry: ParkedAreaListing, opDir: string, opId: string): string | null {
  let od: BigIntStats
  try {
    od = fs.lstatSync(opDir, { bigint: true })
  } catch (err) {
    entry.anomalies.push({ path: opDir, detail: `unreadable (${errCode(err)})` })
    return null
  }
  if (od.isSymbolicLink() || !od.isDirectory()) {
    entry.anomalies.push({ path: opDir, detail: 'op entry is not a real directory; never touched' })
    return null
  }
  if (mountAt(opDir)) return `a mount point is at op dir ${opId}`
  let inner: string[]
  try {
    inner = fs.readdirSync(opDir).sort()
  } catch (err) {
    entry.anomalies.push({ path: opDir, detail: `op dir unreadable (${errCode(err)})` })
    return null
  }
  const set = new Set(inner)
  for (const x of inner) {
    const xp = path.join(opDir, x)
    if (x.endsWith('.json') && isFile(xp)) {
      if (!set.has(x.slice(0, -5))) entry.orphanSidecars.push(xp)
      continue
    }
    if (x.startsWith('.') && !HIDDEN_COPY_RE.test(x)) {
      entry.anomalies.push({ path: xp, detail: 'unrecognised hidden entry; never touched' })
      continue
    }
    const copy: ListedCopy = {
      copyPath: xp,
      name: x,
      opId,
      parentDir: opDir,
      sidecarPath: `${xp}.json`,
      stagingRoot: entry.areaDir,
      opDir,
    }
    entry.copies.push(copy)
  }
  return null
}

/** Lists the parked area under `root` (the directory `.skillsmith-parked` sits in). */
export function listParkedArea(root: string): ParkedAreaListing {
  const areaDir = path.join(root, PARKED_DIR)
  const entry: ParkedAreaListing = {
    root,
    areaDir,
    absent: false,
    refused: null,
    copies: [],
    leftovers: [],
    orphanSidecars: [],
    anomalies: [],
  }
  const refuse = (why: string): ParkedAreaListing =>
    Object.assign(entry, { refused: why, copies: [], leftovers: [], orphanSidecars: [] })
  let ts: BigIntStats
  try {
    ts = fs.lstatSync(areaDir, { bigint: true })
  } catch (err) {
    if (errCode(err) === 'ENOENT') return Object.assign(entry, { absent: true })
    return refuse(`set-aside area unreadable (${errCode(err)})`)
  }
  const bad = refusal(root, areaDir, ts)
  if (bad !== null) return refuse(bad)
  let names: string[]
  try {
    names = fs.readdirSync(areaDir).sort()
  } catch (err) {
    return refuse(`set-aside area unreadable (${errCode(err)})`)
  }
  for (const n of names) {
    const abs = path.join(areaDir, n)
    if (n.startsWith(STAGING_PREFIX)) {
      entry.leftovers.push(inspectLeftover({ S: abs, stagingRoot: areaDir }))
      continue
    }
    if (n.startsWith('.')) {
      entry.anomalies.push({ path: abs, detail: 'unrecognised hidden entry; never touched' })
      continue
    }
    const why = listOpDir(entry, abs, n)
    if (why !== null) return refuse(why)
  }
  return entry
}
