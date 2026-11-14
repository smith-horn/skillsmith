/**
 * SMI-6531 (A1 step 6c-ii-a): list the update backup store, read-only (PLAN
 * 2046, UD22, UD42): `<stateRoot>/backups/update/<client>/<rootKey>/<dirName>/`.
 *
 * Every level (the store, `<client>`, `<rootKey>`, `<dirName>`) is read with
 * lstat and never followed: a symlink or non-directory at any level is an
 * anomaly, and nothing below it is listed. An area with a mount point at it
 * is not listed either, and an unreadable mount table counts as a mount.
 *
 * Inside an area an entry is, by name:
 *  - `.prune-*`: a staging leftover, handed to `inspectLeftover` (D14: a
 *    prune of a backup stages in its own area);
 *  - `.tmp-<base>` or `<base>.json.tmp`: a crashed publish's temp, listed as
 *    unfinished and never a copy (UD42);
 *  - `<base>.json`: a sidecar, an orphan when `<base>` is not there;
 *  - any other dot-name: an anomaly, never touched;
 *  - everything else: a copy, `<opId>` or `<opId>.<kind>[.<k>]`. The classifier
 *    decides what it is from its sidecar, not from this name.
 * The sidecars are not read here.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.list.backups
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { inspectLeftover } from './prune.leftovers.js'
import { mountAt } from './prune.classify.js'
import { STAGING_PREFIX } from './prune.list.parked.js'
import type {
  Anomaly,
  BackupAreaListing,
  BackupStoreListing,
  ListedCopy,
} from './prune.list.types.js'

const isFile = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** The names under `dir`, sorted. `dir` is already known to be a real directory. */
function namesOf(dir: string, anomalies: Anomaly[]): string[] {
  try {
    return fs.readdirSync(dir).sort()
  } catch (err) {
    anomalies.push({ path: dir, detail: `unreadable (${errCode(err)})` })
    return []
  }
}

/** The children of `dir` that are real directories (lstat, never followed); the rest are anomalies. */
function realDirChildren(dir: string, anomalies: Anomaly[]): string[] {
  const out: string[] = []
  for (const n of namesOf(dir, anomalies)) {
    const abs = path.join(dir, n)
    let st: BigIntStats
    try {
      st = fs.lstatSync(abs, { bigint: true })
    } catch (err) {
      anomalies.push({ path: abs, detail: `unreadable (${errCode(err)})` })
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      anomalies.push({ path: abs, detail: 'not a real directory; never touched' })
      continue
    }
    out.push(n)
  }
  return out
}

/** One area directory's entries, sorted into copies, temps, leftovers, orphans and anomalies. */
function listArea(area: BackupAreaListing): void {
  const names = namesOf(area.areaPath, area.anomalies)
  const set = new Set(names)
  for (const n of names) {
    const abs = path.join(area.areaPath, n)
    if (n.startsWith(STAGING_PREFIX)) {
      area.leftovers.push(inspectLeftover({ S: abs, stagingRoot: area.areaPath }))
    } else if (n.startsWith('.tmp-')) {
      area.temps.push({ path: abs, kind: 'copy-temp', base: n.slice('.tmp-'.length) })
    } else if (n.endsWith('.json.tmp')) {
      area.temps.push({ path: abs, kind: 'sidecar-temp', base: n.slice(0, -'.json.tmp'.length) })
    } else if (n.endsWith('.json') && isFile(abs)) {
      if (!set.has(n.slice(0, -'.json'.length))) area.orphanSidecars.push(abs)
    } else if (n.startsWith('.')) {
      area.anomalies.push({ path: abs, detail: 'unrecognised hidden entry; never touched' })
    } else {
      const copy: ListedCopy = {
        copyPath: abs,
        name: n,
        opId: n.split('.')[0] as string,
        parentDir: area.areaPath,
        sidecarPath: `${abs}.json`,
        stagingRoot: area.areaPath,
        opDir: area.areaPath,
        area: { client: area.client, rootKey: area.rootKey, dirName: area.dirName },
      }
      area.copies.push(copy)
    }
  }
}

/** Lists every area under `updateDir` (`<stateRoot>/backups/update`). */
export function listBackupStore(updateDir: string): BackupStoreListing {
  const out: BackupStoreListing = {
    updateDir,
    absent: false,
    refused: null,
    areas: [],
    anomalies: [],
  }
  let st: BigIntStats
  try {
    st = fs.lstatSync(updateDir, { bigint: true })
  } catch (err) {
    if (errCode(err) === 'ENOENT') return Object.assign(out, { absent: true })
    return Object.assign(out, { refused: `backup store unreadable (${errCode(err)})` })
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return Object.assign(out, { refused: 'backup store is not a real directory' })
  }
  if (mountAt(updateDir)) {
    return Object.assign(out, { refused: 'a mount point is at the backup store' })
  }
  for (const client of realDirChildren(updateDir, out.anomalies)) {
    const clientDir = path.join(updateDir, client)
    for (const rootKey of realDirChildren(clientDir, out.anomalies)) {
      const rootDir = path.join(clientDir, rootKey)
      for (const dirName of realDirChildren(rootDir, out.anomalies)) {
        const areaPath = path.join(rootDir, dirName)
        if (mountAt(areaPath)) {
          out.anomalies.push({
            path: areaPath,
            detail: 'a mount point is at this area; not listed',
          })
          continue
        }
        const area: BackupAreaListing = {
          areaPath,
          client,
          rootKey,
          dirName,
          copies: [],
          temps: [],
          leftovers: [],
          orphanSidecars: [],
          anomalies: [],
        }
        listArea(area)
        out.areas.push(area)
      }
    }
  }
  return out
}
