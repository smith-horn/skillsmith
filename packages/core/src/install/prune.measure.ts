/**
 * SMI-6531 (A1 step 6c-ii-a): the one size walk (ADR-166 D-11 "space warning",
 * UD66), ported from the SMI-6676 spike's `trash-usage.mjs` `allocated` and
 * `prune.classify.mjs` `sizeOf`, which the spike ran twice per copy.
 *
 * Read-only. The size is ALLOCATED bytes (`st_blocks * 512`), not the
 * apparent `st_size`: apparent size undercounts directory- and small-file-heavy
 * trees (the spike measured 0.46 MB apparent against 17.1 MB allocated), and a
 * warning that under-reports defeats its purpose (owner decision D6). The
 * apparent size is returned too, for display next to it.
 *
 * Entries are de-duplicated by `(dev, ino)` so a hard link counts once. An
 * entry that cannot be measured (lstat fails, or a directory cannot be
 * listed) is COUNTED in `unmeasured`, never silently treated as empty. Never
 * follows a symlink. Never throws.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.measure
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'

export interface Measured {
  /** Sum of `st_blocks * 512` over the distinct inodes measured. */
  allocatedBytes: number
  /** Sum of `st_size` over the same inodes. */
  apparentBytes: number
  /** Entries that could not be measured; the byte totals are then lower bounds. */
  unmeasured: number
  /** Allocated bytes per `"<dev>:<ino>"`, so a caller can de-duplicate across trees on one volume. */
  units: Map<string, number>
}

/** Measures the tree at `abs` with one lstat walk. */
export function measure(abs: string): Measured {
  const out: Measured = { allocatedBytes: 0, apparentBytes: 0, unmeasured: 0, units: new Map() }
  const visit = (p: string): void => {
    let st: BigIntStats
    try {
      st = fs.lstatSync(p, { bigint: true })
    } catch {
      out.unmeasured += 1
      return
    }
    const key = `${st.dev}:${st.ino}`
    if (!out.units.has(key)) {
      const allocated = Number(st.blocks) * 512
      out.units.set(key, allocated)
      out.allocatedBytes += allocated
      out.apparentBytes += Number(st.size)
    }
    if (!st.isDirectory()) return
    let names: string[]
    try {
      names = fs.readdirSync(p)
    } catch {
      out.unmeasured += 1
      return
    }
    for (const n of names) visit(path.join(p, n))
  }
  visit(abs)
  return out
}
