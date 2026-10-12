#!/usr/bin/env node
// SMI-6715 milestone 1: A1-C4 (mount present before the caller hash) and
// A2-C4 (mount made at after-bind) against C4 and C4-naive. Linux only, real
// mount/umount, requires --privileged. Never run outside a throwaway container.
//
// Usage: node harness/run-c4-mount-attacks.mjs --out <path> [--fs-label <name>] [--target <n>]
//
// --out is REQUIRED: there is no default under results/raw/ (a mis-parsed command
// line must not be able to write into the evidence corpus). C4_RESULTS_RAW_DIR
// relocates the directory the short-target guard treats as the corpus; selftests only.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendJsonl,
  makeRecord,
  aggregateCell,
  classifyRecord,
  formatVerdict,
} from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { shortTargetRefusal, parseFlags } from './c4-target-guard.mjs'
import { resolveControl, controlFailedFlag, controlTag } from './control-spec.mjs'
import * as a1 from './attacks/a1-c4.mjs'
import * as a2 from './attacks/a2-c4.mjs'

const FLAGS = {
  '--target': { key: 'target', kind: 'int' },
  '--out': { key: 'out', kind: 'string' },
  '--fs-label': { key: 'fsLabel', kind: 'string' },
}

// Arguments are validated BEFORE the platform check so a typo is reported as a
// usage error on any host (and is testable off Linux).
const parsedArgs = parseFlags(process.argv.slice(2), FLAGS)
if (parsedArgs.error) {
  console.error(`[run-c4-mount-attacks] ${parsedArgs.error}`)
  process.exit(2)
}

if (parsedArgs.opts.out === undefined) {
  console.error(
    '[run-c4-mount-attacks] --out <path> is required (there is no default under results/raw/)'
  )
  process.exit(2)
}

if (process.platform !== 'linux') {
  console.error(
    '[run-c4-mount-attacks] Linux only (real mount/umount) -- refusing on',
    process.platform
  )
  process.exit(2)
}

const ATTACKS = [
  { label: 'A1-C4', mod: a1, window: 'pre-call' },
  { label: 'A2-C4', mod: a2, window: 'after-bind' },
]
const SUBCASES = ['bind', 'tmpfs']
const CANDIDATES = ['C4', 'C4-naive']

function runCell({ label, mod, window }, subcase, candidate, target, fsLabel, out) {
  const records = []
  for (let run = 0; run < target; run += 1) {
    let raw
    try {
      raw = mod.runOnce({ harnessRoot: resolveHarnessRoot(), candidate, subcase })
    } catch (err) {
      raw = {
        precondition: { hookFired: false, mutationApplied: false, traceMatched: false },
        outcome: { status: 'harness-error', reason: err.message },
        userFiles: { checked: 0, lost: 0, changed: 0 },
        durationMs: null,
        extra: { error: String(err.stack ?? err.message).slice(0, 600) },
      }
    }
    const cell = {
      attack: label,
      variant: `${subcase}/${window}`,
      candidate,
      fs: fsLabel,
      runner: 'run-c4-mount-attacks.mjs',
    }
    let record
    try {
      record = makeRecord({
        cell,
        run,
        precondition: raw.precondition,
        outcome: raw.outcome,
        userFiles: raw.userFiles,
        durationMs: raw.durationMs,
      })
    } catch (err) {
      // A malformed module result becomes a harness-error record instead of
      // killing the runner mid-cell.
      raw = {
        precondition: { hookFired: false, mutationApplied: false, traceMatched: false },
        outcome: { status: 'harness-error', reason: err?.message ?? String(err) },
        userFiles: { checked: 0, lost: 0, changed: 0 },
        durationMs: null,
        extra: { error: String(err?.stack ?? err).slice(0, 600) },
      }
      record = makeRecord({
        cell,
        run,
        precondition: raw.precondition,
        outcome: raw.outcome,
        userFiles: raw.userFiles,
        durationMs: null,
      })
    }
    record.cell.target = mod.target
    records.push(record)
    // `record` is the plain object makeRecord just built (object literal), so
    // the spread copies every field and nothing is lost.
    if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
  }
  return records
}

function main() {
  const opts = { target: null, out: null, fsLabel: process.platform, ...parsedArgs.opts }
  const rawDir =
    process.env.C4_RESULTS_RAW_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', 'raw')
  const out = opts.out
  const refusal = shortTargetRefusal({
    out,
    requested: opts.target,
    modules: ATTACKS.map((a) => ({ name: a.label, target: a.mod.target })),
    rawDir,
  })
  if (refusal) {
    console.error(`[run-c4-mount-attacks] ${refusal}`)
    process.exit(2)
  }
  console.log(
    `[run-c4-mount-attacks] fs=${opts.fsLabel} target=${opts.target ?? 'module default'} out=${out}`
  )

  const cells = []
  for (const atk of ATTACKS) {
    const target = opts.target ?? atk.mod.target
    for (const subcase of SUBCASES) {
      for (const candidate of CANDIDATES) {
        const records = runCell(atk, subcase, candidate, target, opts.fsLabel, out)
        const failed = records.filter((r) => classifyRecord(r) === 'failed').length
        cells.push({
          attack: atk.label,
          variant: `${subcase}/${atk.window}`,
          candidate,
          fs: opts.fsLabel,
          target,
          records,
          failed,
        })
      }
    }
  }

  // Controls are resolved only after every cell has run, against the rows this
  // process actually produced (never a hardcoded controlFailed).
  console.log('')
  for (const c of cells) {
    const control = resolveControl(c, cells)
    const agg = aggregateCell(c.records, () => false, {
      target: c.target,
      controlFailed: controlFailedFlag(control.state),
      controlState: control.state,
    })
    console.log(
      `${formatVerdict(`${c.attack}/${c.variant}/${c.candidate}`, agg)}\tcontrol=${controlTag(control.state)}`
    )
  }
  console.log('')
  console.log('[run-c4-mount-attacks] done')
}

main()
