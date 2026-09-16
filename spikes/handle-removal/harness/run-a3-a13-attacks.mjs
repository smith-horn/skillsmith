#!/usr/bin/env node
// SMI-6676: closes decision-memo criterion 1 -- A3, A4, A7, A8, A9, A10,
// A11, A12, A13 against C0 (control, every cell) and V0/V1/V2, at the
// plan's own run counts. See harness/attacks/{a3,a4,a7,a8,a9,a10,a11,a12,
// a13}[-vr].mjs for each attack's own header (hook timing, why a sub-case is
// shaped the way it is, and what was measured before the module shipped).
//
// Usage: node harness/run-a3-a13-attacks.mjs [--fs-label <name>] [--out <path>] [--only a7,a9]

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { resolveControl, controlFailedFlag, controlTag } from './control-spec.mjs'

// Every cell this process runs, kept so the plan §9 control clause can be
// applied at the end. Until this existed, `aggregateCell` was always called
// without `controlFailed`, so its `NEVER-RAN (control)` branch -- the clause
// that says "if the control didn't fail, the fixture is invalid" -- was
// unreachable from this runner, and an uncontrolled cell printed as a plain
// PASS. See harness/control-spec.mjs.
const ALL_CELLS = []

import * as a3 from './attacks/a3.mjs'
import * as a3vr from './attacks/a3-vr.mjs'
import * as a4 from './attacks/a4.mjs'
import * as a4vr from './attacks/a4-vr.mjs'
import * as a7 from './attacks/a7.mjs'
import * as a7vr from './attacks/a7-vr.mjs'
import * as a8 from './attacks/a8.mjs'
import * as a8vr from './attacks/a8-vr.mjs'
import * as a9 from './attacks/a9.mjs'
import * as a9vr from './attacks/a9-vr.mjs'
import * as a10 from './attacks/a10.mjs'
import * as a10vr from './attacks/a10-vr.mjs'
import * as a11 from './attacks/a11.mjs'
import * as a11vr from './attacks/a11-vr.mjs'
import * as a12 from './attacks/a12.mjs'
import * as a12vr from './attacks/a12-vr.mjs'
import * as a13 from './attacks/a13.mjs'
import * as a13vr from './attacks/a13-vr.mjs'

function parseArgs(argv) {
  const opts = { out: null, only: null, fsLabel: process.platform, a13Tags: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--only') opts.only = argv[++i].split(',')
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
    // Selects which A13 case tag(s) run, without touching the other A13/A3/
    // A9/A10 attacks selected by --only. Exists so the criterion-1-scored
    // guardHash arm (SMI-6676 R2) can be measured on its own, WITHOUT
    // re-running the already-fully-measured 'default' (guard=none) arm --
    // see the A13 block below for why re-running it would be wasted, slow,
    // real-concurrency work rather than merely redundant.
    else if (argv[i] === '--a13-tags') opts.a13Tags = argv[++i].split(',')
  }
  return opts
}

const CANDIDATES = {
  C0: { label: 'C0', kind: 'c0' },
  V0: { label: 'V0', kind: 'vr' },
  V1: { label: 'V1', kind: 'vr' },
  V2: { label: 'V2', kind: 'vr' },
}

/**
 * Runs one cell: `target` invocations of `runFn({harnessRoot, candidate,
 * ...extraArgs})`, recording + aggregating. `runFn` may be async.
 */
async function runCell({
  runFn,
  attackId,
  tag,
  candidateKey,
  target,
  extraArgs,
  harnessRoot,
  fsLabel,
  out,
}) {
  const candidate = candidateKey === 'C0' ? {} : { variant: candidateKey }
  const records = []
  for (let run = 0; run < target; run += 1) {
    let raw
    try {
      raw = await runFn({ harnessRoot, candidate, ...extraArgs })
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
        attack: attackId,
        variant: tag,
        candidate: candidateKey,
        fs: fsLabel,
        runner: 'run-a3-a13-attacks.mjs',
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
  const agg = aggregateCell(records, () => false, { target })
  ALL_CELLS.push({
    attack: attackId,
    variant: tag,
    candidate: candidateKey,
    fs: fsLabel,
    target,
    records,
    failed: agg.failed,
  })
  return { agg, records }
}

/**
 * Re-scores every cell this process ran with the plan §9 control clause
 * applied, and prints the difference. The per-cell lines printed live above
 * are control-blind by necessity (a cell's control may not have run yet when
 * it prints); THIS is the verdict the plan defines.
 */
function reportWithControls() {
  console.log('')
  console.log('=== plan §9 verdicts, control clause applied ===')
  console.log('(a cell whose named control never demonstrated the loss proves nothing)')
  const changed = []
  for (const cell of ALL_CELLS) {
    const c = resolveControl(cell, ALL_CELLS)
    const agg = aggregateCell(cell.records, () => false, {
      target: cell.target,
      controlFailed: controlFailedFlag(c.state),
    })
    const label = `${cell.attack}/${cell.variant}/${cell.candidate}`
    console.log(`${formatVerdict(label, agg)}\tcontrol=${controlTag(c.state)}`)
    if (agg.verdict !== 'PASS' && agg.verdict.startsWith('NEVER-RAN (control)')) {
      changed.push(`${label}: ${c.detail}`)
    }
  }
  if (changed.length) {
    console.log('')
    console.log(`${changed.length} cell(s) are NOT PASS because their control never bit:`)
    for (const line of changed) console.log(`  ${line}`)
  }
}

async function runMatrix({
  attackId,
  runFnFor,
  target,
  cases,
  harnessRoot,
  fsLabel,
  out,
  skipReason,
  candidateKeys = Object.keys(CANDIDATES),
}) {
  const results = new Map()
  for (const c of cases) {
    if (skipReason && skipReason(c)) {
      console.log(`SKIP\t${attackId}/${c.tag}\t${skipReason(c)}`)
      continue
    }
    for (const candidateKey of candidateKeys) {
      const runFn = runFnFor(CANDIDATES[candidateKey].kind, c)
      const { agg } = await runCell({
        runFn,
        attackId,
        tag: c.tag,
        candidateKey,
        target: c.target ?? target,
        extraArgs: c.extraArgs ?? {},
        harnessRoot,
        fsLabel,
        out,
      })
      results.set(`${c.tag}/${candidateKey}`, agg)
      console.log(formatVerdict(`${attackId}/${c.tag}/${candidateKey}`, agg))
    }
  }
  return results
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const outDefault = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'results',
    'raw',
    `a3-a13-attacks-${opts.fsLabel}.jsonl`
  )
  const out = opts.out ?? outDefault
  console.log(
    `[run-a3-a13-attacks] harnessRoot=${harnessRoot} out=${out} platform=${process.platform}`
  )
  console.log('')

  const want = (id) => !opts.only || opts.only.includes(id)

  // --- A3: guard none/hash --------------------------------------------
  if (want('a3')) {
    await runMatrix({
      attackId: 'A3',
      target: 30,
      cases: [
        { tag: 'none', extraArgs: { guardMode: 'none' } },
        { tag: 'guardHash', extraArgs: { guardMode: 'guardHash' } },
      ],
      runFnFor: (kind, c) => (kind === 'c0' ? a3.runOnce : a3vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A4: single timing, no guard split (fd already pinned) ----------
  if (want('a4')) {
    await runMatrix({
      attackId: 'A4',
      target: 30,
      cases: [{ tag: 'default', extraArgs: {} }],
      runFnFor: (kind) => (kind === 'c0' ? a4.runOnce : a4vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A7: subcase x entryKind -----------------------------------------
  if (want('a7')) {
    const cases = []
    for (const subcase of ['between', 'before-unlink']) {
      for (const entryKind of ['file', 'symlink']) {
        cases.push({ tag: `${subcase}/${entryKind}`, extraArgs: { subcase, entryKind } })
      }
    }
    await runMatrix({
      attackId: 'A7',
      target: 30,
      cases,
      runFnFor: (kind) => (kind === 'c0' ? a7.runOnce : a7vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A8: subcase a/b ---------------------------------------------------
  if (want('a8')) {
    await runMatrix({
      attackId: 'A8',
      target: 30,
      cases: [
        { tag: 'a', extraArgs: { subcase: 'a' } },
        { tag: 'b', extraArgs: { subcase: 'b' } },
      ],
      runFnFor: (kind) => (kind === 'c0' ? a8.runOnce : a8vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A9: subcase stub (any fs) / apfs-setfile (macOS only), VR guard --
  if (want('a9')) {
    const isDarwin = process.platform === 'darwin'
    const cases = [{ tag: 'stub', target: 30, extraArgs: { subcase: 'stub' } }]
    if (isDarwin)
      cases.push({ tag: 'apfs-setfile', target: 30, extraArgs: { subcase: 'apfs-setfile' } })
    // C0 has no guard concept -- run once per subcase, C0 candidate only
    // (a9.runOnce always calls removeC0 regardless of what candidate label
    // it's given -- restricting candidateKeys here is load-bearing, not
    // cosmetic: an earlier draft looped this over all 4 candidate keys,
    // which silently reran C0's own algorithm three extra times under V0/
    // V1/V2 labels instead of running anything VR-specific).
    await runMatrix({
      attackId: 'A9-C0',
      cases,
      runFnFor: () => a9.runOnce,
      candidateKeys: ['C0'],
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    // VR: same subcases, x guard none/hash (see a9-vr.mjs header).
    const vrCases = []
    for (const c of cases) {
      for (const guardMode of ['none', 'guardHash']) {
        vrCases.push({
          tag: `${c.tag}/${guardMode}`,
          target: c.target,
          extraArgs: { subcase: c.extraArgs.subcase, guardMode },
        })
      }
    }
    for (const c of vrCases) {
      for (const candidateKey of ['V0', 'V1', 'V2']) {
        const { agg } = await runCell({
          runFn: a9vr.runOnce,
          attackId: 'A9-VR',
          tag: c.tag,
          candidateKey,
          target: c.target,
          extraArgs: c.extraArgs,
          harnessRoot,
          fsLabel: opts.fsLabel,
          out,
        })
        console.log(formatVerdict(`A9-VR/${c.tag}/${candidateKey}`, agg))
      }
    }
    console.log('')
  }

  // --- A10: subcase a (guard none/hash) / b (hardlink, no guard split) --
  if (want('a10')) {
    await runMatrix({
      attackId: 'A10-C0',
      target: 30,
      cases: [
        { tag: 'a', extraArgs: { subcase: 'a' } },
        { tag: 'b', extraArgs: { subcase: 'b' } },
      ],
      runFnFor: () => a10.runOnce,
      candidateKeys: ['C0'], // same reasoning as A9-C0 above -- a10.runOnce is C0-only
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    const vrCases = [
      { tag: 'a/none', extraArgs: { subcase: 'a', guardMode: 'none' } },
      { tag: 'a/guardHash', extraArgs: { subcase: 'a', guardMode: 'guardHash' } },
      { tag: 'b', extraArgs: { subcase: 'b' } },
    ]
    await runMatrix({
      attackId: 'A10-VR',
      target: 30,
      cases: vrCases,
      runFnFor: () => a10vr.runOnce,
      // Same reasoning as A9-C0/A10-C0's own candidateKeys restriction
      // above, applied in the other direction: a10vr.runOnce is VR-only, so
      // running it under a 'C0' candidate label would silently execute
      // removeVR with no variant (defaulting to V2) mislabeled as 'C0' --
      // this block's own C0 comparison lives in the separate A10-C0 block.
      candidateKeys: ['V0', 'V1', 'V2'],
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A11: property check, no attack ------------------------------------
  if (want('a11')) {
    await runMatrix({
      attackId: 'A11',
      target: 10,
      cases: [{ tag: 'default', extraArgs: {} }],
      runFnFor: (kind) => (kind === 'c0' ? a11.runOnce : a11vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  // --- A12: stop rule, plus its own failing control ----------------------
  if (want('a12')) {
    await runMatrix({
      attackId: 'A12',
      target: 10,
      cases: [
        { tag: 'ebusy-rmdir', extraArgs: { subcase: 'ebusy-rmdir' } },
        { tag: 'eacces-unlink', extraArgs: { subcase: 'eacces-unlink' } },
      ],
      runFnFor: (kind) => (kind === 'c0' ? a12.runOnce : a12vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    // required failing control: a walk that continues past errors
    for (const subcase of ['ebusy-rmdir', 'eacces-unlink']) {
      const records = []
      for (let run = 0; run < 10; run += 1) {
        const raw = a12.runControl({ harnessRoot, subcase })
        const record = makeRecord({
          cell: {
            attack: 'A12',
            variant: subcase,
            candidate: 'control-continues-past-errors',
            fs: opts.fsLabel,
            runner: 'run-a3-a13-attacks.mjs',
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
      const agg = aggregateCell(records, () => false, { target: 10 })
      ALL_CELLS.push({
        attack: 'A12',
        variant: subcase,
        candidate: 'control-continues-past-errors',
        fs: opts.fsLabel,
        target: 10,
        records,
        failed: agg.failed,
      })
      console.log(formatVerdict(`A12/${subcase}/control-continues-past-errors`, agg))
    }
    console.log('')
  }

  // --- A13: real concurrent racer, guard none/hash (same split as A3/A9/A10)
  // 'default' (guard=none, i.e. a13vr.runOnce's own guardMode default) is the
  // ORIGINAL arm -- its records and label are untouched by this addition.
  // 'guardHash' is the NEW arm this block adds: the decision memo's own
  // recommended configuration (a caller-supplied guard hash) is FORBIDDEN
  // under 'default', so until this cell existed the scored A3-A13 criterion-1
  // matrix never measured the configuration it actually recommends -- only
  // a separate, non-criterion-1 label (A13-TIMING, measure-a13-race-timing.mjs)
  // ever ran guard=guardHash. C0 has no guard concept, same as A3/A9/A10:
  // guardMode is passed to a13.runOnce too but silently ignored (it
  // destructures only {harnessRoot, candidate}), so C0's cell under BOTH
  // tags exercises the identical algorithm -- included anyway for the same
  // reason A3 includes it, so this attack's own shape is uniform across cases
  // rather than special-cased per candidate.
  if (want('a13')) {
    const a13Cases = [
      { tag: 'default', extraArgs: {} },
      { tag: 'guardHash', extraArgs: { guardMode: 'guardHash' } },
    ]
    const cases = opts.a13Tags ? a13Cases.filter((c) => opts.a13Tags.includes(c.tag)) : a13Cases
    await runMatrix({
      attackId: 'A13',
      target: 300,
      cases,
      runFnFor: (kind) => (kind === 'c0' ? a13.runOnce : a13vr.runOnce),
      harnessRoot,
      fsLabel: opts.fsLabel,
      out,
    })
    console.log('')
  }

  reportWithControls()
  console.log('[run-a3-a13-attacks] done')
}

main()
