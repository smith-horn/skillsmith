#!/usr/bin/env node
// SMI-6715 milestone 1: runs A3/A4/A7/A8/A10/A13 against C4 and C4-naive.
//
// Usage: node harness/run-c4-attacks.mjs --out <path> [--fs-label <name>]
//   [--target <n>] [--only a3,a4,a7,a8,a10,a13] [--dirs <n>]
//
// --dirs <n> pads each fixture tree with directories (one small file each, under
// tree/zz-pad) up to n directories in total; the attacked paths do not move. The
// requested n is recorded as cell.dirs and in the variant tag ('<variant>/dirs=<n>'),
// and the measured count as extra.actualDirs. Default: the small fixed fixtures.
//
// --out is REQUIRED: there is no default under results/raw/. A default there let a
// mis-parsed command line write into the evidence corpus; the caller must name the
// file. (C4_RESULTS_RAW_DIR relocates the directory the short-target guard treats
// as the corpus; selftests only.)
//
// Each cell pair (C4, C4-naive) is run, then the control is resolved from BOTH
// rows of THIS run (never asserted), then each arm is aggregated with that
// control state and printed.

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { shortTargetRefusal, parseFlags, harnessErrorRaw } from './c4-target-guard.mjs'
import { checkTraceArtifact } from './c4-trace-check.mjs'
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
      ...[
        ['between', 'after-bind'],
        ['late', 'post-hash'],
      ].flatMap(([subcase, window]) =>
        ['file', 'symlink'].map((entryKind) => ({
          args: { subcase, entryKind, window },
          tag: `${subcase}-${entryKind}/${window}`,
        }))
      ),
      // Edit subcases (owner-approved): tag is '<subcase>/post-hash', no entryKind.
      ...a7.EDIT_SUBCASES.map((subcase) => ({
        args: { subcase, window: 'post-hash' },
        tag: `${subcase}/post-hash`,
      })),
    ],
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
  '--dirs': { key: 'dirs', kind: 'int' },
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
  if (opts.out === null)
    usageError('--out <path> is required (there is no default under results/raw/)')
  const unknown = (opts.only ?? []).filter((k) => !KNOWN_KEYS.includes(k))
  if (unknown.length > 0) {
    usageError(
      `unknown --only entr${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')} (known: ${KNOWN_KEYS.join(', ')})`
    )
  }
  return opts
}

/**
 * One run of one arm, appended to `cell`. `armOrder` is set only for interleaved
 * (A13) runs and is stamped into the run's extra so the order is auditable.
 */
async function runOne({
  mod,
  args,
  labels,
  tag,
  candidate,
  run,
  harnessRoot,
  fsLabel,
  out,
  cell: acc,
  armOrder,
  dirs,
  traceDir,
}) {
  let raw
  // Harness errors need a label too. For a per-run-label attack (A13) it is the
  // scored one, whatever order `labels` is in: a harness error filed under the
  // record-only label would make the scored cell vanish from the verdicts.
  const errorLabel = labels.includes('A13-C4') ? 'A13-C4' : labels[0]
  let label = labels[0]
  let variant = tag
  try {
    // `dirs` is passed only when requested, so default runs call modules exactly as before.
    raw = await mod.runOnce({
      harnessRoot,
      candidate,
      ...args,
      ...(dirs ? { dirs } : {}),
      ...(traceDir !== undefined ? { traceDir } : {}),
    })
    // Every full trace is kept as a side file; verify the claim (c4-trace-check.mjs). A
    // problem marks the record harness-error but keeps what it measured.
    raw = checkTraceArtifact(raw, traceDir)
    // A module that ignored --dirs would otherwise file an unpadded run under a dirs=N
    // cell. The module must report the directory count it actually built.
    if (dirs && raw.extra?.actualDirs !== dirs) {
      throw new Error(
        `module did not pad to the requested ${dirs} directories (extra.actualDirs=${String(raw.extra?.actualDirs)})`
      )
    }
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
    label = errorLabel
    variant = tag
  }
  // dirs is part of the cell key: a padded cell must never merge with a fixture-scale one.
  if (dirs) variant = `${variant}/dirs=${dirs}`
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
  // `raw.extra` is a plain object literal from the module (or null), so the spread is shape-safe.
  const extra = armOrder === undefined ? (raw.extra ?? null) : { ...(raw.extra ?? {}), armOrder }
  // The module's own target for this cell (not the requested --target), so a summary
  // can tell a short run from a complete one. `record` and `record.cell` are the
  // plain literals makeRecord built.
  record.cell.target = mod.target ?? null
  // A13 routes each run into one of several labels that are tallied separately, so
  // its target is the attempt count across all of them for this candidate.
  if (labels.length > 1) record.cell.targetScope = 'across-a13-labels'
  record.cell.dirs = dirs ?? null
  acc.records.push(record)
  acc.extras.push(extra)
  acc.runLabels.push(label)
  if (out) appendJsonl(out, { ...record, extra })
}

/**
 * Runs both arms of one combo. Deterministic attacks run all C4 then all
 * C4-naive. With `interleave` (A13, a probabilistic race) the arms alternate per
 * run index in a random order, so slow drift in the machine or filesystem
 * cannot favour one arm.
 */
export async function runCells({
  mod,
  args,
  labels,
  tag,
  target,
  harnessRoot,
  fsLabel,
  out,
  interleave,
  dirs,
  traceDir,
  rng = Math.random,
}) {
  const cells = {}
  for (const c of CANDIDATES) cells[c] = { records: [], extras: [], runLabels: [] }
  const common = { mod, args, labels, tag, harnessRoot, fsLabel, out, dirs, traceDir }
  if (interleave) {
    for (let run = 0; run < target; run += 1) {
      const naiveFirst = rng() >= 0.5
      const order = naiveFirst ? [...CANDIDATES].reverse() : CANDIDATES
      for (const candidate of order) {
        await runOne({
          ...common,
          candidate,
          run,
          cell: cells[candidate],
          armOrder: naiveFirst ? 'naive-first' : 'C4-first',
        })
      }
    }
  } else {
    for (const candidate of CANDIDATES) {
      for (let run = 0; run < target; run += 1) {
        await runOne({ ...common, candidate, run, cell: cells[candidate] })
      }
    }
  }
  return cells
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

/** Sum of extra.straddleCount over the runs that supply it; 'n/a' if none do. */
function straddleTotal(extras) {
  const counts = extras.map((e) => e?.straddleCount).filter((n) => Number.isFinite(n))
  return counts.length === 0 ? 'n/a' : String(counts.reduce((a, b) => a + b, 0))
}

/**
 * Runs excluded as vacuous (extra.excludedReason === 'vacuous-check'); 'n/a' when
 * no run carries an excludedReason at all, since 0 could not be told from "not supplied".
 */
function vacuousExcluded(extras) {
  const supplied = extras.filter((e) => e && Object.hasOwn(e, 'excludedReason'))
  if (supplied.length === 0) return 'n/a'
  return String(supplied.filter((e) => e.excludedReason === 'vacuous-check').length)
}

/**
 * The verdict line for one (label, candidate) group. Exported so the selftest can
 * drive it with synthetic records. The verdict text is whatever verdictFor()
 * returns, including for record-only cells: this function adds nothing to it.
 */
export function scoreCell({
  label,
  variant,
  candidate,
  records,
  target,
  rows,
  extras = [],
  universe = records,
  aggregate = aggregateCell,
}) {
  const row = rows.find((r) => r.attack === label && r.candidate === candidate)
  const control = resolveControl(row, rows)
  const agg = aggregate(records, () => false, {
    target,
    controlFailed: controlFailedFlag(control.state),
    controlState: control.state,
    // A13's run count spans both of its labels (cell.targetScope), so completeness is
    // judged over every record of this candidate, exactly as generate-summary does.
    universe,
  })
  let line = `${formatVerdict(`${label}/${variant}/${candidate}`, agg)}\tcontrol=${controlTag(control.state)}`
  if (A13_LABELS.includes(label)) {
    line += `\tstraddles=${straddleTotal(extras)}\tvacuousExcluded=${vacuousExcluded(extras)}\tcallerIntentExcluded=${agg.callerIntentExcluded ?? 0}`
  }
  if (label === 'A13-C4') line += `\t${A13_R6_NOTE}`
  else if (agg.verdict.startsWith('PASS') && isProbabilistic(label)) {
    line += '\tR6/§9 floor is a minimum evidence floor, not a safety bound'
  }
  return line
}

/**
 * The control rows for one combo: one per (label, candidate) group that has runs.
 * `controlFailures` (losses from non-error records) is carried beside `failed` so
 * resolveControl never lets a harness-error loss satisfy a control; `aggregate` is
 * injectable for the selftest.
 */
export function buildRows({ labels, groups, fsLabel, groupTarget, aggregate = aggregateCell }) {
  const rows = []
  for (const label of labels) {
    for (const candidate of CANDIDATES) {
      const g = groups[candidate].get(label)
      if (g.records.length === 0) continue
      const t = aggregate(g.records, () => false, { target: groupTarget(g) })
      rows.push({
        attack: label,
        variant: g.variant,
        candidate,
        fs: fsLabel,
        failed: t.failed,
        controlFailures: t.controlFailures,
      })
    }
  }
  return rows
}

/**
 * The printed lines for one combo: for every (label, candidate) group, its verdict
 * line and its detail line. `universe` for each group is ALL of that candidate's
 * records, so an attack whose run count spans several labels (A13) is judged
 * complete across them.
 */
export function comboLines({ labels, cells, groups, rows, groupTarget }) {
  const lines = []
  for (const label of labels) {
    for (const candidate of CANDIDATES) {
      const g = groups[candidate].get(label)
      const { records, extras, variant } = g
      if (records.length === 0) {
        lines.push(`(no ${label}/${candidate} runs)`)
        continue
      }
      lines.push(
        scoreCell({
          label,
          variant,
          candidate,
          records,
          target: groupTarget(g),
          rows,
          extras,
          universe: cells[candidate].records,
        }),
        describe(records, extras)
      )
    }
  }
  return lines
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const rawDir =
    process.env.C4_RESULTS_RAW_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', 'raw')
  const out = opts.out

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
      const cells = await runCells({
        mod,
        args,
        labels,
        tag,
        target,
        harnessRoot,
        fsLabel: opts.fsLabel,
        out,
        interleave: perRun,
        dirs: opts.dirs,
        // full traces go beside the output file: <out dir>/traces/<sha256>.json.br
        traceDir: path.join(path.dirname(path.resolve(out)), 'traces'),
      })
      const groups = {}
      for (const candidate of CANDIDATES) groups[candidate] = groupByLabel(cells[candidate], labels)
      // Failed counts come from an un-controlled aggregate; the control is then
      // resolved from both rows of THIS run and the verdict recomputed with it.
      // A per-run-label attack is scored per label on the runs that carry it, so
      // its target is that group's own size; a fixed-label attack keeps `target`.
      const groupTarget = (g) => (perRun ? g.records.length : target)
      const rows = buildRows({ labels, groups, fsLabel: opts.fsLabel, groupTarget })
      for (const line of comboLines({ labels, cells, groups, rows, groupTarget })) console.log(line)
    }
    console.log('')
  }

  console.log('[run-c4-attacks] done')
}

// Only when run as a script, so the selftest can import scoreCell. realpath on
// argv[1]: node leaves a symlinked invocation path unresolved while import.meta.url
// is resolved, and a plain comparison silently ran nothing (exit 0, no output).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
