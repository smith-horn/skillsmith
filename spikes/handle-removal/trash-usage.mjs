// SMI-7123 Wave 5 (design §7.1, coordinator change 2026-10-14): how much the
// trash holds per volume, and the loud warning when it is over the threshold.
//
// THE TOTAL IS ALLOCATED BYTES: st_blocks x 512, de-duplicated by (dev, ino),
// summed over a no-follow lstat walk of each copy. NOT the sidecar's apparent
// `bytes` (the design's revision-2 rule): apparent size undercounts directory-
// and small-file-heavy copies (measured 0.46 MB apparent vs 17.1 MB allocated
// for ~/.claude/skills/.backups), and a warning that under-reports defeats its
// purpose. The walk is the cost of that; this runs after a park, not per file.
//
// Read-only. fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import { listTrash, human } from './prune.classify.mjs'

function readOrigin(sidecarPath) {
  try {
    const o = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')).originPath
    return typeof o === 'string' ? o : null
  } catch {
    return null
  }
}

/** Allocated bytes of the tree at `abs`, never following a symlink; `seen` de-duplicates hard links. */
function allocated(abs, seen) {
  let total = 0
  const visit = (p) => {
    let st
    try {
      st = fs.lstatSync(p, { bigint: true })
    } catch {
      return
    }
    const key = `${st.dev}:${st.ino}`
    if (!seen.has(key)) {
      seen.add(key)
      total += Number(st.blocks) * 512
    }
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

/**
 * @returns {{volumes:{dev:string, freeBytes:number, totalBytes:number,
 *            copies:{path:string, bytes:number, originPath:string|null, opId:string}[]}[]}}
 */
export function trashUsage({ roots, statfs = fs.statfsSync }) {
  const listing = listTrash({ roots })
  const byDev = new Map()
  for (const r of listing.roots) {
    if (r.absent || r.refused) continue
    const dev = String(fs.lstatSync(r.trashRoot, { bigint: true }).dev)
    let v = byDev.get(dev)
    if (!v) {
      const s = statfs(r.trashRoot)
      v = {
        dev,
        freeBytes: Number(s.bavail) * Number(s.bsize),
        totalBytes: Number(s.blocks) * Number(s.bsize),
        copies: [],
        seen: new Set(),
      }
      byDev.set(dev, v)
    }
    for (const c of r.copies) {
      v.copies.push({
        path: c.copyPath,
        bytes: allocated(c.copyPath, v.seen),
        originPath: readOrigin(c.sidecarPath),
        opId: c.opId,
      })
    }
    for (const l of r.leftovers) {
      v.copies.push({
        path: l.S,
        bytes: allocated(l.S, v.seen),
        originPath: null,
        opId: path.basename(l.S),
      })
    }
  }
  return { volumes: [...byDev.values()].map(({ seen, ...v }) => (void seen, v)) }
}

/**
 * Per volume: over when the total exceeds min(capBytes, freeFraction x free).
 * The message (stderr in the product) names the total, the threshold and the
 * largest copies with their paths, and says nothing is deleted automatically.
 */
export function trashWarning(usage, { capBytes = 1e9, freeFraction = 0.05, top = 3 } = {}) {
  const perVolume = usage.volumes.map((v) => {
    const thresholdBytes = Math.min(capBytes, freeFraction * v.freeBytes)
    const totalBytes = v.copies.reduce((n, c) => n + c.bytes, 0)
    const largest = [...v.copies].sort((a, b) => b.bytes - a.bytes).slice(0, top)
    return { dev: v.dev, thresholdBytes, totalBytes, over: totalBytes > thresholdBytes, largest }
  })
  const over = perVolume.filter((p) => p.over)
  if (over.length === 0) return { over: false, perVolume, message: null }
  const lines = over.map((p) => {
    const big = p.largest
      .map(
        (c) =>
          `${c.originPath ? path.basename(c.originPath) : c.opId} ${human(c.bytes)} (${c.path})`
      )
      .join(', ')
    return (
      `Skillsmith's trash on this disk holds ${human(p.totalBytes)}, over the ${human(p.thresholdBytes)} warning level. ` +
      `Largest: ${big}. Nothing is deleted automatically. Review and delete with \`skillsmith doctor backups --prune\`.`
    )
  })
  return { over: true, perVolume, message: lines.join('\n') }
}
