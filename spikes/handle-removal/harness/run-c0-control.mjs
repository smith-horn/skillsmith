#!/usr/bin/env node
// SMI-6676 checkpoint 1: runs the C0 control's A3-A6 and N1 cells and prints
// ran/passed/failed/never-ran verdicts, per plan §8 step 3 and §9.
//
// Usage:
//   node harness/run-c0-control.mjs [--fs-label <name>] [--out <path>]
//     [--only a3,a5] [--reduced]
//
// --reduced runs a small run count per cell (for fast local iteration);
// omit it to run the plan's full §5.1 run counts (30/30/300/300/300).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendJsonl,
  makeRecord,
  classifyRecord,
  aggregateCell,
  formatVerdict,
} from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import * as a3 from './attacks/a3.mjs'
import * as a4 from './attacks/a4.mjs'
import * as a5 from './attacks/a5.mjs'
import * as a6 from './attacks/a6.mjs'
import * as n1 from './attacks/n1.mjs'

// gateTiming values match c0-walk.mjs's ported e53.mjs/e54.mjs mechanism
// exactly -- see that module's top comment for what each one measures and
// why. 'ud25' (gateTiming: 'before-bind') is THE candidate: the plan's own
// "C0 as of UD25". 'ud25WalkStart' reproduces the attack table's own control
// for A6 (the residual the plan's design deliberately does not use).
const CANDIDATES = {
  baseline: { identityCheck: false, gateTiming: 'none', label: 'baseline (pre-UD24)' },
  ud24Only: { identityCheck: true, gateTiming: 'none', label: 'UD24-only (no gate)' },
  ud25: {
    identityCheck: true,
    gateTiming: 'before-bind',
    label: 'UD25 (ported e53/e54 gate C, before-bind)',
  },
  ud25WalkStart: {
    identityCheck: true,
    gateTiming: 'walk-start',
    label: "UD25 gate C, walk-start timing (plan's own A6 control)",
  },
}

function parseArgs(argv) {
  const opts = { out: null, only: null, reduced: false, fsLabel: process.platform }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--only') opts.only = argv[++i].split(',')
    else if (argv[i] === '--reduced') opts.reduced = true
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
  }
  return opts
}

function runCell({ attackMod, variant, candidateKey, target, harnessRoot, fsLabel, out }) {
  const candidate = CANDIDATES[candidateKey]
  const records = []
  for (let run = 0; run < target; run += 1) {
    let raw
    try {
      raw = attackMod.runOnce({ harnessRoot, candidate, variant })
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
        attack: attackMod.id,
        variant: variant ?? candidateKey,
        candidate: candidateKey,
        fs: fsLabel,
        runner: 'run-c0-control.mjs',
      },
      run,
      precondition: raw.precondition,
      outcome: raw.outcome,
      userFiles: raw.userFiles,
      durationMs: raw.durationMs,
    })
    records.push(record)
    if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
  }
  return records
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const only = opts.only

  const outDefault = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'results',
    'raw',
    `c0-control-${opts.fsLabel}.jsonl`
  )
  const out = opts.out ?? outDefault

  const lines = []
  const record = (label, verdictLine) => {
    console.log(verdictLine)
    lines.push(verdictLine)
  }

  console.log(`[run-c0-control] harnessRoot=${harnessRoot} out=${out} reduced=${opts.reduced}`)
  console.log('')

  // A3, A4: UD24-only ablation. Control = baseline (no UD24), expected FAIL.
  for (const [attackMod, label] of [
    [a3, 'A3'],
    [a4, 'A4'],
  ]) {
    if (only && !only.includes(label.toLowerCase())) continue
    const target = opts.reduced ? Math.min(10, attackMod.target) : attackMod.target

    const controlRecords = runCell({
      attackMod,
      candidateKey: 'baseline',
      target,
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const controlAgg = aggregateCell(controlRecords, () => false, { target })
    record(label, formatVerdict(`${label}/baseline (control)`, controlAgg))

    const candidateRecords = runCell({
      attackMod,
      candidateKey: 'ud25',
      target,
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const candidateAgg = aggregateCell(candidateRecords, () => false, {
      target,
      controlFailed: controlAgg.failed >= 1,
    })
    record(label, formatVerdict(`${label}/ud25 (candidate)`, candidateAgg))
    console.log('')
  }

  // A5: gate ablation. Control = UD24-only (no gate), expected FAIL >=1/300.
  // Candidate = UD25 (with gate), the step-3 "done when" bar: 0/300.
  if (!only || only.includes('a5')) {
    const target = opts.reduced ? Math.min(30, a5.target) : a5.target

    const controlRecords = runCell({
      attackMod: a5,
      candidateKey: 'ud24Only',
      target,
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const controlAgg = aggregateCell(controlRecords, () => false, { target })
    record('A5', formatVerdict('A5/ud24Only (control, gate off)', controlAgg))
    const reuseCount = controlRecords.filter((r) => r.precondition.reuseObserved === true).length
    console.log(`      reuse observed in control: ${reuseCount}/${target}`)

    const candidateRecords = runCell({
      attackMod: a5,
      candidateKey: 'ud25',
      target,
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const candidateAgg = aggregateCell(candidateRecords, () => false, {
      target,
      controlFailed: controlAgg.failed >= 1,
    })
    record('A5', formatVerdict('A5/ud25 (candidate, gate on)', candidateAgg))
    const reuseCountCandidate = candidateRecords.filter(
      (r) => r.precondition.reuseObserved === true
    ).length
    console.log(`      reuse observed in candidate: ${reuseCountCandidate}/${target}`)
    console.log('')
  }

  // A6: two sub-variants (root, inner). Control = UD24-only (no gate).
  // ud25WalkStart reproduces the plan's own attack-table control (the
  // residual "before-bind" was chosen over) as a second, documented row.
  if (!only || only.includes('a6')) {
    const target = opts.reduced ? Math.min(30, a6.target) : a6.target
    for (const variant of ['root', 'inner']) {
      const controlRecords = runCell({
        attackMod: a6,
        variant,
        candidateKey: 'ud24Only',
        target,
        harnessRoot,
        fsLabel: opts.fsLabel,
        out,
      })
      const controlAgg = aggregateCell(controlRecords, () => false, { target })
      record('A6', formatVerdict(`A6/${variant}/ud24Only (control, gate off)`, controlAgg))

      const walkStartRecords = runCell({
        attackMod: a6,
        variant,
        candidateKey: 'ud25WalkStart',
        target,
        harnessRoot,
        fsLabel: opts.fsLabel,
        out,
      })
      const walkStartAgg = aggregateCell(walkStartRecords, () => false, {
        target,
        controlFailed: controlAgg.failed >= 1,
      })
      record(
        'A6',
        formatVerdict(
          `A6/${variant}/ud25WalkStart (plan's own control, expected to fail)`,
          walkStartAgg
        )
      )

      const candidateRecords = runCell({
        attackMod: a6,
        variant,
        candidateKey: 'ud25',
        target,
        harnessRoot,
        fsLabel: opts.fsLabel,
        out,
      })
      const candidateAgg = aggregateCell(candidateRecords, () => false, {
        target,
        controlFailed: controlAgg.failed >= 1,
      })
      record('A6', formatVerdict(`A6/${variant}/ud25 (candidate, before-bind gate)`, candidateAgg))
    }
    console.log('')
  }

  // N1: sanity -- no attack, expect 300/300 removed under the shipped (UD25) config.
  if (!only || only.includes('n1')) {
    const target = opts.reduced ? Math.min(30, n1.target) : n1.target
    const records = runCell({
      attackMod: n1,
      candidateKey: 'ud25',
      target,
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const agg = aggregateCell(records, () => false, { target, controlFailed: true })
    record('N1', formatVerdict('N1/ud25 (no attack)', agg))
    console.log('')
  }

  console.log('[run-c0-control] done')
}

main()
