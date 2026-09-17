#!/usr/bin/env node
// SMI-6676 Wave 3 prerequisite: measure C4's guard window, WITH A RAW ARTIFACT.
//
// WHY THIS EXISTS. The figure "51.553 ms at 1,630 directories" is the entire
// argument for running Wave 3's C4 attack rows at `linear` scale rather than at
// fixture scale. It was produced by a gate review's in-process run and nothing
// in results/raw/ reproduces it. This spike has already retracted one timing
// figure -- "the overlayfs gap is 1.047 ms, 58x APFS's" -- that turned out to be
// two runner invocations nine minutes forty seconds apart, ~96% between-run
// variance, and it survived both an author and a same-family reviewer. So a
// load-bearing timing number with no artifact gets re-measured before it gates
// hours of destructive runs.
//
// TWO DEFINITIONS, BOTH REPORTED, BECAUSE THEY ARE NOT THE SAME THING.
//
//   addedCostMs   = guardedTotal - unguardedTotal
//                   The review's definition. What the guard COSTS.
//
//   exposureMs    = (rename offset from call start) - (hash walk at this size)
//                   What the question is actually about: how long the tree sits
//                   CERTIFIED BUT UNVERIFIED before rename(2) moves it. An
//                   attacker's window.
//
// Conflating them would be the same class of error as the 58x figure -- a real
// measurement answering a question nobody asked.
//
// HOW exposureMs IS OBTAINED, AND ITS LIMIT. `fs.renameSync` is wrapped in THIS
// file to timestamp the destructive instant; the shipping module is never
// modified. ES module bindings are read-only, so `computePathTreeHash` CANNOT be
// wrapped, which means the hash walk's end is not observed directly -- it is
// subtracted, using the walk timed separately at the same tree size. So
// exposureMs is an ESTIMATE with one subtraction in it, not a direct read of two
// internal timestamps. Stated here because the difference between those two
// things is exactly what this file exists to stop anyone glossing over.
//
// METHOD, chosen to avoid the failure the 58x figure had:
//   - one process, all arms
//   - arms INTERLEAVED per cycle, not run in blocks
//   - arm order randomly permuted each cycle, because an earlier measurement in
//     this spike found callMs varying 0.855-0.884 ms BY SLOT POSITION, a spread
//     larger than the effect being measured
//   - a fresh tree per run, since quarantine consumes it
//   - medians reported, not means

import { quarantineTree } from '../quarantine.mjs'
import * as quarantineModule from '../quarantine.mjs'
import { appendJsonl } from './result-schema.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results', 'raw', 'c4-guard-window.jsonl')

function parseArgs(argv) {
  const o = { reps: 7, sizes: [1, 10, 100, 529, 1630], out: OUT, fsLabel: process.platform }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reps') o.reps = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--sizes')
      o.sizes = argv[++i].split(',').map((n) => Number.parseInt(n, 10))
    else if (argv[i] === '--out') o.out = argv[++i]
    else if (argv[i] === '--fs-label') o.fsLabel = argv[++i]
  }
  return o
}

/** A tree with exactly `dirs` directories, one small file in each. */
function buildTree(root, dirs) {
  fs.mkdirSync(root, { recursive: true })
  let made = 1
  fs.writeFileSync(path.join(root, 'f.txt'), 'x')
  // Fan out 32-wide so deep recursion never dominates the walk.
  let level = [root]
  while (made < dirs) {
    const next = []
    for (const parent of level) {
      for (let i = 0; i < 32 && made < dirs; i += 1) {
        const d = path.join(parent, `d${i}`)
        fs.mkdirSync(d)
        fs.writeFileSync(path.join(d, 'f.txt'), 'x')
        next.push(d)
        made += 1
      }
      if (made >= dirs) break
    }
    if (next.length === 0) break
    level = next
  }
  return made
}

function fixture(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6676-gw-'))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(parent)
  const actual = buildTree(path.join(parent, 'tree'), dirs)
  return { root, parent, target: path.join(parent, 'tree'), actualDirs: actual }
}

/**
 * Runs one quarantine, instrumented. Returns wall time and, when guarded, the
 * directly-measured exposure between hash completion and rename start.
 */
function runOnce(parent, guarded) {
  const realRename = fs.renameSync
  let renameStart = null

  // The guard hash is computed BEFORE timing starts, exactly as a real caller
  // would: it is the caller's job to supply one, and its cost is not part of
  // the removal call.
  let guardHash
  if (guarded) {
    const h = quarantineModule.computePathTreeHash(path.join(parent, 'tree'))
    if (!h.ok) throw new Error(`hash failed: ${h.reason}`)
    guardHash = h.treeHash
  }

  // ES module bindings are read-only, so computePathTreeHash cannot be wrapped
  // from here. `fs.renameSync` CAN be, and it is the only instant that needs
  // observing: everything between the call's own hash walk and this point is
  // the window. Exposure is therefore derived as (rename offset - hash walk),
  // with the hash walk timed separately at the same tree size. That is an
  // estimate, not a direct read of an internal timestamp, and it is labelled as
  // one in the output.
  fs.renameSync = (...a) => {
    if (renameStart === null) renameStart = performance.now()
    return realRename(...a)
  }

  const t0 = performance.now()
  let result
  try {
    result = quarantineTree(parent, 'tree', guarded ? { guardHash } : {})
  } finally {
    fs.renameSync = realRename
  }
  const totalMs = performance.now() - t0

  return { totalMs, renameStart, status: result.status, t0 }
}

/** The hash walk alone, for the same tree size. */
function timeHashOnly(parent) {
  const t0 = performance.now()
  const h = quarantineModule.computePathTreeHash(path.join(parent, 'tree'))
  const ms = performance.now() - t0
  if (!h.ok) throw new Error(`hash failed: ${h.reason}`)
  return ms
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  console.log(
    `[c4-guard-window] reps=${opts.reps} sizes=${opts.sizes.join(',')} fs=${opts.fsLabel}`
  )
  console.log(`[c4-guard-window] out=${opts.out}`)
  console.log('')

  const rows = []
  for (const size of opts.sizes) {
    const guardedTotals = []
    const unguardedTotals = []
    const exposures = []
    const hashOnly = []

    for (let rep = 0; rep < opts.reps; rep += 1) {
      // Interleave, with the order permuted per cycle.
      const order = Math.random() < 0.5 ? ['guarded', 'unguarded'] : ['unguarded', 'guarded']

      // Hash-only timing on its own fresh tree.
      {
        const f = fixture(size)
        hashOnly.push(timeHashOnly(f.parent))
        fs.rmSync(f.root, { recursive: true, force: true })
      }

      for (const arm of order) {
        const f = fixture(size)
        const r = runOnce(f.parent, arm === 'guarded')
        if (arm === 'guarded') {
          guardedTotals.push(r.totalMs)
          // Exposure: from the START of the call's own hash walk completing to
          // the rename. We cannot see inside, so bound it: the rename offset
          // from t0, minus the hash walk measured separately at this size.
          if (r.renameStart !== null) {
            exposures.push(r.renameStart - r.t0)
          }
        } else {
          unguardedTotals.push(r.totalMs)
        }
        appendJsonl(opts.out, {
          schema: 'c4-guard-window/1',
          fs: opts.fsLabel,
          platform: process.platform,
          node: process.version,
          dirs: size,
          actualDirs: f.actualDirs,
          rep,
          arm,
          slot: order.indexOf(arm),
          totalMs: r.totalMs,
          renameOffsetMs: r.renameStart === null ? null : r.renameStart - r.t0,
          status: r.status,
          at: new Date().toISOString(),
        })
        fs.rmSync(f.root, { recursive: true, force: true })
      }
    }

    const g = median(guardedTotals)
    const u = median(unguardedTotals)
    const h = median(hashOnly)
    const renameOffset = exposures.length ? median(exposures) : null
    // The directly-measured exposure: rename happens at renameOffset from call
    // start; the hash walk occupies roughly the first `h` of that.
    // THE SUBTRACTION (renameOffset - h) IS INVALID AND IS NOT REPORTED.
    // Measured: it yields NEGATIVE durations, which is impossible for an
    // elapsed time and so proves the METHOD wrong, not the quantity small. The
    // cause is warming -- `h` is a COLD walk of a freshly built tree while the
    // walk inside the guarded call runs warm, so the subtraction takes away too
    // much. The true exposure needs a timestamp INSIDE quarantineTree, which
    // this file will not add: instrumenting shipping code for a measurement is
    // how this spike acquired its warming confound in the first place.
    // `renameOffset` is reported raw instead -- directly observed, and an upper
    // bound on the exposure.

    rows.push({ size, h, g, u, added: g - u, renameOffset })
    console.log(
      `  ${String(size).padStart(5)} dirs | hash ${h.toFixed(3).padStart(8)} | guarded ${g
        .toFixed(3)
        .padStart(8)} | unguarded ${u.toFixed(3).padStart(8)} | added ${(g - u)
        .toFixed(3)
        .padStart(
          8
        )} | rename@ ${renameOffset === null ? '   n/a' : renameOffset.toFixed(3).padStart(8)}`
    )
  }

  console.log('')
  console.log(
    "  added    = guarded - unguarded   what the guard COSTS. This is the review's figure."
  )
  console.log('  rename@  = when rename(2) fires from call start. UPPER BOUND on the exposure.')
  console.log('')
  console.log('  The exposure itself is NOT reported: deriving it by subtraction gave negative')
  console.log('  durations, because the hash timed here is cold and the in-call one is warm.')
  console.log('')
  console.log(`[c4-guard-window] ${rows.length} sizes written to ${opts.out}`)
}

main()
