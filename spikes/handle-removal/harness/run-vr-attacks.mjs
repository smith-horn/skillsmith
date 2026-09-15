#!/usr/bin/env node
// SMI-6676 checkpoint 2: runs A5-VR and A6-VR against V0/V1/V2, printing
// ran/passed/failed/never-ran verdicts, per plan §9.
//
// Usage: node harness/run-vr-attacks.mjs [--fs-label <name>] [--out <path>]
//   [--target <n>] [--only a5,a6]

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import * as a5vr from './attacks/a5-vr.mjs'
import * as a6vr from './attacks/a6-vr.mjs'

function parseArgs(argv) {
  const opts = { out: null, only: null, target: null, fsLabel: process.platform }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--only') opts.only = argv[++i].split(',')
    else if (argv[i] === '--target') opts.target = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
  }
  return opts
}

function runCell(attackMod, extra, target, harnessRoot, fsLabel, out, variant, tag) {
  const records = []
  const extras = []
  for (let run = 0; run < target; run += 1) {
    let raw
    try {
      raw = attackMod.runOnce({ harnessRoot, candidate: { variant }, ...extra })
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
        variant: tag,
        candidate: variant,
        fs: fsLabel,
        runner: 'run-vr-attacks.mjs',
      },
      run,
      precondition: raw.precondition,
      outcome: raw.outcome,
      userFiles: raw.userFiles,
      durationMs: raw.durationMs,
    })
    records.push(record)
    extras.push(raw.extra ?? null)
    if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
  }
  return { records, extras }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const outDefault = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'results',
    'raw',
    `vr-attacks-${opts.fsLabel}.jsonl`
  )
  const out = opts.out ?? outDefault
  console.log(`[run-vr-attacks] harnessRoot=${harnessRoot} out=${out}`)
  console.log('')

  if (!opts.only || opts.only.includes('a5')) {
    const target = opts.target ?? a5vr.target
    for (const variant of ['V0', 'V1', 'V2']) {
      const { records, extras } = runCell(
        a5vr,
        {},
        target,
        harnessRoot,
        opts.fsLabel,
        out,
        variant,
        variant
      )
      const agg = aggregateCell(records, () => false, { target, controlFailed: true })
      console.log(formatVerdict(`A5-VR/${variant}`, agg))
      const reuseCount = extras.filter((e) => e && e.reuseObserved === true).length
      console.log(
        `      inode+birthtime reuse observed: ${reuseCount}/${target} (held-fd pinning should keep this at or near 0)`
      )
    }
    console.log('')
  }

  if (!opts.only || opts.only.includes('a6')) {
    const target = opts.target ?? a6vr.target
    for (const guardMode of ['none', 'guardHash']) {
      for (const variant2 of ['root', 'inner']) {
        for (const variant of ['V0', 'V1', 'V2']) {
          const { records } = runCell(
            a6vr,
            { variant2, guardMode },
            target,
            harnessRoot,
            opts.fsLabel,
            out,
            variant,
            `${variant2}/${guardMode}`
          )
          const agg = aggregateCell(records, () => false, { target, controlFailed: true })
          console.log(formatVerdict(`A6-VR/${variant2}/${guardMode}/${variant}`, agg))
        }
      }
    }
  }

  console.log('')
  console.log('[run-vr-attacks] done')
}

main()
