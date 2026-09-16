#!/usr/bin/env node
// SMI-6676: the instrument the checkpoint-7 memo's virtiofs paragraph said it
// did not build -- "Not separately re-proven with a dedicated controlled test
// (that would need instrumenting exactly when a landed mutation occurred
// relative to the guard pass, which this pass did not build)".
//
// It is built here, and it is cheap, because a13-vr.mjs already controlled
// the racer's own delay: the racer now reports the absolute instant its
// mutation landed, and two removeVR hooks report when the guard pass started
// and ended, on the same system clock. That turns "the remaining losses are
// presumably the known guard=none residual" from the best-supported story
// into a measured distribution: a loss whose mutation landed BEFORE or DURING
// the guard pass is the residual (no earlier observation existed); a loss
// whose mutation landed AFTER it is a genuine V2 gap, because closing that
// window is exactly what V2's per-entry re-verification is for.
//
// Deliberately a SEPARATE cell label (`A13-TIMING`) writing to its own raw
// file, not an append to the existing A13 cells: the memo's own second
// methodology rule says a cell whose measurement changed is replaced at the
// source, never merged, and a regenerated summary cannot tell two generations
// of one cell apart. These runs also serve as their own control on that
// point -- if the added hooks perturbed the race, this run's landed-race loss
// rate would diverge from the A13 cell it is meant to explain. Compare them.
//
// Usage: node harness/measure-a13-race-timing.mjs [--fs-label <name>]
//          [--out <path>] [--target <n>] [--candidates V2,V1]

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendJsonl, makeRecord } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import * as a13vr from './attacks/a13-vr.mjs'

function parseArgs(argv) {
  const opts = {
    out: null,
    target: 300,
    fsLabel: process.platform,
    candidates: ['V2'],
    guardModes: ['none'],
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--target') opts.target = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
    else if (argv[i] === '--candidates') opts.candidates = argv[++i].split(',')
    else if (argv[i] === '--guard') opts.guardModes = argv[++i].split(',')
  }
  return opts
}

const PHASES = [
  'pre-guard',
  'straddles-guard-start',
  'during-guard',
  'straddles-guard-end',
  'post-guard',
  'post-call',
  'unknown',
]

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const out =
    opts.out ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'results',
      'raw',
      `a13-race-timing-${opts.fsLabel}.jsonl`
    )
  console.log(
    `[measure-a13-race-timing] harnessRoot=${harnessRoot} out=${out} target=${opts.target} candidates=${opts.candidates.join(',')}`
  )
  console.log('')

  for (const variant of opts.candidates) {
    for (const guardMode of opts.guardModes) {
      const rows = []
      for (let run = 0; run < opts.target; run += 1) {
        let raw
        try {
          raw = await a13vr.runOnce({ harnessRoot, candidate: { variant }, guardMode })
        } catch (err) {
          raw = {
            precondition: { hookFired: null },
            outcome: { status: 'harness-error', reason: err.message },
            userFiles: { checked: 0, lost: 0, changed: 0 },
            durationMs: null,
          }
        }
        const record = makeRecord({
          cell: {
            attack: 'A13-TIMING',
            variant: `guard-${guardMode}`,
            candidate: variant,
            fs: opts.fsLabel,
            runner: 'measure-a13-race-timing.mjs',
          },
          run,
          precondition: raw.precondition,
          outcome: raw.outcome,
          userFiles: raw.userFiles,
          durationMs: raw.durationMs,
        })
        appendJsonl(out, { ...record, extra: raw.extra ?? null })
        rows.push({ record, extra: raw.extra })
      }

      // --- report -----------------------------------------------------------
      const applied = rows.filter((r) => r.extra && r.extra.racerApplied != null)
      const lost = applied.filter((r) => r.record.userFiles.lost > 0)
      const skews = applied
        .map((r) => r.extra.timing?.clockSkewCheckMs)
        .filter((v) => typeof v === 'number')
      const negativeSkew = skews.filter((v) => v < 0).length
      const byPhase = {}
      const lostByPhase = {}
      const lostByPhaseKind = {}
      for (const p of PHASES) {
        byPhase[p] = 0
        lostByPhase[p] = 0
      }
      for (const r of applied) {
        const p = r.extra.timing?.phase ?? 'unknown'
        byPhase[p] = (byPhase[p] ?? 0) + 1
        if (r.record.userFiles.lost > 0) {
          lostByPhase[p] = (lostByPhase[p] ?? 0) + 1
          const k = `${p}/${r.extra.racerApplied}`
          lostByPhaseKind[k] = (lostByPhaseKind[k] ?? 0) + 1
        }
      }

      // Runs where the mutation landed AFTER removeVR() returned raced nothing,
      // yet the memo's own "landed-race" denominator (extra.racerApplied != null)
      // counts them -- and they can only ever score as passes, so they deflate
      // the rate. Reported separately rather than folded in.
      const raced = applied.filter((r) => {
        const p = r.extra.timing?.phase
        return p !== 'post-call' && p !== 'unknown'
      })
      const racedLost = raced.filter((r) => r.record.userFiles.lost > 0)

      console.log(`--- ${opts.fsLabel} / ${variant} / guard=${guardMode} -------------------`)
      console.log(
        `ran=${rows.length} racer-landed=${applied.length} lost=${lost.length} ` +
          `landed-race-loss=${applied.length ? ((100 * lost.length) / applied.length).toFixed(1) : 'n/a'}%`
      )
      console.log(
        `actually-raced-the-walk=${raced.length} lost=${racedLost.length} ` +
          `raced-loss=${raced.length ? ((100 * racedLost.length) / raced.length).toFixed(1) : 'n/a'}% ` +
          `(excludes post-call and unknown-phase landings)`
      )
      console.log(
        `clock-comparability: ${skews.length} paired timestamps, ` +
          `${negativeSkew} with parent-observed-before-child-wrote ` +
          `(any non-zero here invalidates every phase below)`
      )
      console.log('phase\tlanded\tlost\tloss-rate')
      for (const p of PHASES) {
        if (!byPhase[p]) continue
        console.log(
          `${p}\t${byPhase[p]}\t${lostByPhase[p]}\t${((100 * lostByPhase[p]) / byPhase[p]).toFixed(1)}%`
        )
      }
      console.log('losses by phase/racer-kind:', JSON.stringify(lostByPhaseKind))
      console.log('')
    }
  }
  console.log('[measure-a13-race-timing] done')
}

main()
