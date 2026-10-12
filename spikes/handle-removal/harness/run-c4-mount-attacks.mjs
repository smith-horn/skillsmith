#!/usr/bin/env node
// SMI-6715 milestone 1: A1-C4 (mount present before the caller hash) and
// A2-C4 (mount made at after-bind) against C4 and C4-naive. Linux only, real
// mount/umount, requires --privileged. Never run outside a throwaway container.
//
// Usage: node harness/run-c4-mount-attacks.mjs --out <path> [--fs-label <name>] [--target <n>]
//   [--dirs <n>]   pad each fixture tree to n directories (see run-c4-attacks.mjs); the
//                  variant tag gains '/dirs=<n>' and records carry cell.dirs
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
import { shortTargetRefusal, parseFlags, harnessErrorRaw } from './c4-target-guard.mjs'
import { checkTraceArtifact } from './c4-trace-check.mjs'
import { resolveControl, controlFailedFlag, controlTag } from './control-spec.mjs'
import * as a1 from './attacks/a1-c4.mjs'
import * as a2 from './attacks/a2-c4.mjs'

const FLAGS = {
  '--target': { key: 'target', kind: 'int' },
  '--out': { key: 'out', kind: 'string' },
  '--fs-label': { key: 'fsLabel', kind: 'string' },
  '--dirs': { key: 'dirs', kind: 'int' },
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

function runCell({ label, mod, window }, subcase, candidate, target, fsLabel, out, dirs) {
  // full traces go beside the output file: <out dir>/traces/<sha256>.json.br
  const traceDir = path.join(path.dirname(path.resolve(out)), 'traces')
  const records = []
  for (let run = 0; run < target; run += 1) {
    let raw
    try {
      raw = mod.runOnce({
        harnessRoot: resolveHarnessRoot(),
        candidate,
        subcase,
        ...(dirs ? { dirs } : {}),
        traceDir,
      })
      raw = checkTraceArtifact(raw, traceDir)
      if (dirs && raw.extra?.actualDirs !== dirs) {
        throw new Error(
          `module did not pad to the requested ${dirs} directories (extra.actualDirs=${String(raw.extra?.actualDirs)})`
        )
      }
    } catch (err) {
      raw = harnessErrorRaw(err)
    }
    const cell = {
      attack: label,
      // dirs is part of the cell key: a padded cell must never merge with a fixture-scale one.
      variant: `${subcase}/${window}${dirs ? `/dirs=${dirs}` : ''}`,
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
      raw = harnessErrorRaw(err)
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
    record.cell.dirs = dirs ?? null
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
        const records = runCell(atk, subcase, candidate, target, opts.fsLabel, out, opts.dirs)
        const failed = records.filter((r) => classifyRecord(r) === 'failed').length
        // losses from non-error records only: a harness-error loss must not satisfy a control
        const { controlFailures } = aggregateCell(records, () => false, { target })
        cells.push({
          attack: atk.label,
          variant: `${subcase}/${atk.window}${opts.dirs ? `/dirs=${opts.dirs}` : ''}`,
          candidate,
          fs: opts.fsLabel,
          target,
          records,
          failed,
          controlFailures,
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
