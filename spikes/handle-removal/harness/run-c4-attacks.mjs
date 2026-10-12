#!/usr/bin/env node
// SMI-6715 milestone 1: runs A3/A4/A7/A8/A10/A13 against C4 and C4-naive.
//
// Usage: node harness/run-c4-attacks.mjs [--fs-label <name>] [--out <path>]
//   [--target <n>] [--only a3,a4,a7,a8,a10,a13]
//
// Each cell pair (C4, C4-naive) is run, then the control is resolved from BOTH
// rows of THIS run (never asserted), then each arm is aggregated with that
// control state and printed.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { shortTargetRefusal, parseFlags } from './c4-target-guard.mjs'
import { resolveControl, controlFailedFlag, controlTag, isProbabilistic } from './control-spec.mjs'
import * as a3 from './attacks/a3-c4.mjs'
import * as a4 from './attacks/a4-c4.mjs'
import * as a7 from './attacks/a7-c4.mjs'
import * as a8 from './attacks/a8-c4.mjs'
import * as a10 from './attacks/a10-c4.mjs'

const CANDIDATES = ['C4', 'C4-naive']

/** A13 picks its label per run; only these two are accepted (anything else is a harness-error). */
const A13_LABELS = ['A13-C4', 'A13-C4-OOM']
const A13_R6_NOTE = 'R6: landed subset, floor 100, a minimum evidence floor, not a safety bound'

/** key -> { mod, combos: [{ args, tag }] }. `tag` is the variant tag. */
const ATTACKS = {
  a3: { mod: a3, combos: [{ args: { window: 'after-bind' }, tag: 'target-swap/after-bind' }] },
  a4: { mod: a4, combos: [{ args: { window: 'post-hash' }, tag: 'target-swap/post-hash' }] },
  a7: {
    mod: a7,
    combos: [
      ['between', 'after-bind'],
      ['late', 'post-hash'],
    ].flatMap(([subcase, window]) =>
      ['file', 'symlink'].map((entryKind) => ({
        args: { subcase, entryKind, window },
        tag: `${subcase}-${entryKind}/${window}`,
      }))
    ),
  },
  a8: {
    mod: a8,
    combos: ['a', 'b'].map((subcase) => ({
      args: { subcase, window: 'after-bind' },
      tag: `${subcase}/after-bind`,
    })),
  },
  a10: {
    mod: a10,
    combos: ['a', 'b'].map((subcase) => ({
      args: { subcase, window: 'pre-call' },
      tag: `${subcase}/pre-call`,
    })),
  },
}

// a13-c4.mjs is imported lazily so the five fixed-label attacks never depend on
// it loading.
const A13 = {
  perRunLabels: A13_LABELS,
  load: () => import('./attacks/a13-c4.mjs'),
  combos: [{ args: {}, tag: 'racer/by-timestamp' }],
}

const FLAGS = {
  '--out': { key: 'out', kind: 'string' },
  '--only': { key: 'only', kind: 'list' },
  '--target': { key: 'target', kind: 'int' },
  '--fs-label': { key: 'fsLabel', kind: 'string' },
}
const KNOWN_KEYS = [...Object.keys(ATTACKS), 'a13']

function usageError(message) {
  console.error(`[run-c4-attacks] ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const parsed = parseFlags(argv, FLAGS)
  if (parsed.error) usageError(parsed.error)
  const opts = { out: null, only: null, target: null, fsLabel: process.platform, ...parsed.opts }
  const unknown = (opts.only ?? []).filter((k) => !KNOWN_KEYS.includes(k))
  if (unknown.length > 0) {
    usageError(
      `unknown --only entr${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')} (known: ${KNOWN_KEYS.join(', ')})`
    )
  }
  return opts
}

const HARNESS_ERROR_FILES = { checked: 0, lost: 0, changed: 0 }

function harnessErrorRaw(err) {
  return {
    precondition: { hookFired: null },
    outcome: { status: 'harness-error', reason: err?.message ?? String(err) },
    userFiles: HARNESS_ERROR_FILES,
    durationMs: null,
    extra: null,
  }
}

async function runCell({ mod, args, labels, tag, candidate, target, harnessRoot, fsLabel, out }) {
  // `labels`: the accepted cell labels. One entry = the label is fixed by the
  // module; several = the module picks per run via extra.label.
  const records = []
  const extras = []
  const runLabels = []
  for (let run = 0; run < target; run += 1) {
    let raw
    let label = labels[0]
    let variant = tag
    try {
      raw = await mod.runOnce({ harnessRoot, candidate, ...args })
      const got = raw.extra?.label
      if (labels.length === 1) {
        if (got !== undefined && got !== label)
          throw new Error(`module returned label ${got}, runner expected ${label}`)
      } else if (!labels.includes(got)) {
        throw new Error(`module returned label ${String(got)}, accepted: ${labels.join(', ')}`)
      } else {
        label = got
      }
      if (typeof raw.extra?.variant === 'string') variant = raw.extra.variant
    } catch (err) {
      raw = harnessErrorRaw(err)
      label = labels[0]
      variant = tag
    }
    const cell = { attack: label, variant, candidate, fs: fsLabel, runner: 'run-c4-attacks.mjs' }
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
      const e = harnessErrorRaw(err)
      raw = e
      record = makeRecord({
        cell,
        run,
        precondition: e.precondition,
        outcome: e.outcome,
        userFiles: e.userFiles,
        durationMs: null,
      })
    }
    records.push(record)
    extras.push(raw.extra ?? null)
    runLabels.push(label)
    if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
  }
  return { records, extras, runLabels }
}

function histogram(items) {
  const h = {}
  for (const k of items) h[k] = (h[k] ?? 0) + 1
  return JSON.stringify(h)
}

function describe(records, extras) {
  const sum = (f) => records.reduce((n, r) => n + (r.userFiles[f] ?? 0), 0)
  return (
    `      status=${histogram(records.map((r) => r.outcome.status))}` +
    ` displaced=${sum('displaced')} deleted=${sum('deleted')}` +
    ` firedAt=${histogram(extras.map((e) => e?.firedAt ?? null))}` +
    ` traceMatched=${records.filter((r) => r.precondition.traceMatched === true).length}/${records.length}`
  )
}

/** Splits one candidate's runs by label: Map label -> { records, extras, variant }. */
function groupByLabel(cell, labels) {
  const groups = new Map()
  for (const l of labels) groups.set(l, { records: [], extras: [], variant: null })
  cell.records.forEach((rec, i) => {
    const g = groups.get(cell.runLabels[i])
    g.records.push(rec)
    g.extras.push(cell.extras[i])
    g.variant ??= rec.cell.variant
  })
  return groups
}

/**
 * The verdict line for one (label, candidate) group. Exported so the selftest can
 * drive it with synthetic records. The verdict text is whatever verdictFor()
 * returns, including for record-only cells: this function adds nothing to it.
 */
export function scoreCell({ label, variant, candidate, records, target, rows }) {
  const row = rows.find((r) => r.attack === label && r.candidate === candidate)
  const control = resolveControl(row, rows)
  const agg = aggregateCell(records, () => false, {
    target,
    controlFailed: controlFailedFlag(control.state),
    controlState: control.state,
  })
  let line = `${formatVerdict(`${label}/${variant}/${candidate}`, agg)}\tcontrol=${controlTag(control.state)}`
  if (label === 'A13-C4') line += `\t${A13_R6_NOTE}`
  else if (agg.verdict.startsWith('PASS') && isProbabilistic(label)) {
    line += '\tR6/§9 floor is a minimum evidence floor, not a safety bound'
  }
  return line
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const rawDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', 'raw')
  const out = opts.out ?? path.join(rawDir, `c4-attacks-${opts.fsLabel}.jsonl`)

  const selected = []
  for (const [key, entry] of [...Object.entries(ATTACKS), ['a13', A13]]) {
    if (opts.only && !opts.only.includes(key)) continue
    selected.push([key, entry, entry.mod ?? (await entry.load())])
  }
  if (selected.length === 0) usageError('nothing selected: no attack matches --only')
  const refusal = shortTargetRefusal({
    out,
    requested: opts.target,
    modules: selected.map(([key, , mod]) => ({ name: key, target: mod.target })),
    rawDir,
  })
  if (refusal) {
    console.error(`[run-c4-attacks] ${refusal}`)
    process.exit(2)
  }
  console.log(`[run-c4-attacks] harnessRoot=${harnessRoot} out=${out}`)
  console.log('')

  for (const [, entry, mod] of selected) {
    const perRun = entry.perRunLabels !== undefined
    const target = opts.target ?? mod.target
    for (const { args, tag } of entry.combos) {
      const labels = perRun ? entry.perRunLabels : [mod.labelFor(args)]
      const cells = {}
      for (const candidate of CANDIDATES) {
        cells[candidate] = await runCell({
          mod,
          args,
          labels,
          tag,
          candidate,
          target,
          harnessRoot,
          fsLabel: opts.fsLabel,
          out,
        })
      }
      const groups = {}
      for (const candidate of CANDIDATES) groups[candidate] = groupByLabel(cells[candidate], labels)
      // Failed counts come from an un-controlled aggregate; the control is then
      // resolved from both rows of THIS run and the verdict recomputed with it.
      // A per-run-label attack is scored per label on the runs that carry it, so
      // its target is that group's own size; a fixed-label attack keeps `target`.
      const groupTarget = (g) => (perRun ? g.records.length : target)
      const rows = []
      for (const label of labels) {
        for (const candidate of CANDIDATES) {
          const g = groups[candidate].get(label)
          if (g.records.length === 0) continue
          rows.push({
            attack: label,
            variant: g.variant,
            candidate,
            fs: opts.fsLabel,
            failed: aggregateCell(g.records, () => false, { target: groupTarget(g) }).failed,
          })
        }
      }
      for (const label of labels) {
        for (const candidate of CANDIDATES) {
          const { records, extras, variant } = groups[candidate].get(label)
          if (records.length === 0) {
            console.log(`(no ${label}/${candidate} runs)`)
            continue
          }
          console.log(
            scoreCell({
              label,
              variant,
              candidate,
              records,
              target: groupTarget(groups[candidate].get(label)),
              rows,
            })
          )
          console.log(describe(records, extras))
        }
      }
    }
    console.log('')
  }

  console.log('[run-c4-attacks] done')
}

// Only when run as a script, so the selftest can import scoreCell.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
