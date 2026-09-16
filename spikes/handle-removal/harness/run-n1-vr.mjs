#!/usr/bin/env node
// SMI-6676: N1-VR, closing decision-memo criterion 2's own missing
// evidence -- 300/300, V0/V1/V2, guard none and guardHash, per filesystem.
//
// Usage: node harness/run-n1-vr.mjs [--fs-label <name>] [--out <path>] [--target <n>]

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import * as n1vr from './attacks/n1-vr.mjs'

function parseArgs(argv) {
  const opts = { out: null, target: 300, fsLabel: process.platform }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--target') opts.target = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const outDefault = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'results',
    'raw',
    `n1-vr-${opts.fsLabel}.jsonl`
  )
  const out = opts.out ?? outDefault
  console.log(`[run-n1-vr] harnessRoot=${harnessRoot} out=${out} target=${opts.target}`)
  console.log('')

  for (const guardMode of ['none', 'guardHash']) {
    for (const variant of ['V0', 'V1', 'V2']) {
      const records = []
      for (let run = 0; run < opts.target; run += 1) {
        let raw
        try {
          raw = n1vr.runOnce({ harnessRoot, candidate: { variant }, guardMode })
        } catch (err) {
          raw = {
            precondition: { hookFired: null },
            outcome: { status: 'harness-error', reason: err.message },
            userFiles: { checked: 0, lost: 0, changed: 0 },
            durationMs: null,
          }
        }
        const record = makeRecord({
          cell: { attack: 'N1-VR', variant: guardMode, candidate: variant, fs: opts.fsLabel, runner: 'run-n1-vr.mjs' },
          run,
          precondition: raw.precondition,
          outcome: raw.outcome,
          userFiles: raw.userFiles,
          durationMs: raw.durationMs,
        })
        records.push(record)
        if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
      }
      const agg = aggregateCell(records, () => false, { target: opts.target })
      console.log(formatVerdict(`N1-VR/${guardMode}/${variant}`, agg))
    }
  }
  console.log('')
  console.log('[run-n1-vr] done')
}

main()
