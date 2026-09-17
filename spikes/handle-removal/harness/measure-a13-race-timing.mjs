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
import fs, { existsSync, lstatSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { appendJsonl, makeRecord, scanQuarantineLeftovers } from './result-schema.mjs'
import { resolveHarnessRoot, makeFixtureRoot } from './fixture-root.mjs'
import * as a13vr from './attacks/a13-vr.mjs'
import { buildSwapFixture, spawnConcurrentRacer } from './attacks/_shared.mjs'
import { removeVR } from '../walk.mjs'
import { loadShim } from '../native-c/load.mjs'
import { guardPass } from '../hash.mjs'

function parseArgs(argv) {
  const opts = {
    out: null,
    target: 300,
    fsLabel: process.platform,
    candidates: ['V2'],
    guardModes: ['none'],
    // --- warm-arm experiment (SMI-6676, arm-C confound test) ---
    experiment: null,
    cycles: 400,
    replicate: 1,
    arms: ['A', 'B', 'C', 'P', 'A0', 'B0'],
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--target') opts.target = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--fs-label') opts.fsLabel = argv[++i]
    else if (argv[i] === '--candidates') opts.candidates = argv[++i].split(',')
    else if (argv[i] === '--guard') opts.guardModes = argv[++i].split(',')
    else if (argv[i] === '--experiment') opts.experiment = argv[++i]
    else if (argv[i] === '--cycles') opts.cycles = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--replicate') opts.replicate = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--arms') opts.arms = argv[++i].split(',')
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

// ===========================================================================
// WARM-ARM EXPERIMENT (SMI-6676) -- does `originalTreeHash()` warming explain
// why the guarded A13 arm's whole call is 2-2.7x shorter than the unguarded
// one on overlayfs/ext4/tmpfs?
//
// The guarded arm runs a COMPLETE guard pass over the fixture immediately
// before the racer is spawned, on every guarded run and on no unguarded run.
// That is a plausible cache-warming confound, but plausibility is not
// evidence. A third arm settles it:
//
//   A  guard=none       no warm, no guard      (a13-vr's guardMode:'none')
//   B  guard=guardHash  warm + guard           (a13-vr's guardMode:'guardHash')
//   C  warm-only        warm, hash DISCARDED, removeVR called unguarded
//
// C is B with exactly one expression changed: whether the computed hash is
// forwarded to removeVR. If C's callMs matches B's, warming is the cause; if
// it matches A's, it is not.
//
// `a13-vr.mjs::runOnce` cannot express arm C (it computes the hash only in
// the branch that also forwards it, and the harness split forbids editing
// that file), so the three arms run through ONE local replica of runOnce
// below and differ only in `armMode`. To keep that replica honest, two parity
// arms call the REAL, untouched `a13vr.runOnce` in the same interleaved loop:
//
//   A0 a13vr.runOnce({guardMode:'none'})
//   B0 a13vr.runOnce({guardMode:'guardHash'})
//
// A fourth, racer-free probe measures the causal STEP directly rather than
// its supposed effect: on a freshly built fixture, time three back-to-back
// guard passes. Pass 1 is cold, passes 2 and 3 are warm. If pass 2 is not
// faster than pass 1 on this filesystem, a warm pass buys nothing here and
// cannot be shortening anything.
//
//   P  warm-probe (no racer, no removeVR)
//
// Arms are interleaved within ONE process and ONE loop, in a fresh random
// permutation per cycle -- between-replicate variance on this host is
// enormous (a prior worker measured the same arm at 27.7% and 0.7% loss rate
// across replicates), so only within-replicate comparisons are trustworthy,
// and a fixed A,B,C rotation would confound arm with slot position.
// ===========================================================================

const nowAbs = () => Number(process.hrtime.bigint()) / 1e6

/** Byte-exact copy of a13-vr.mjs's own (unexported) originalTreeHash(). */
function originalTreeHashLocal(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/**
 * Faithful replica of a13-vr.mjs::runOnce with one added mode.
 *
 * @param {'none'|'guardHash'|'warm-only'} armMode
 *   - 'none'      : no warm pass, guardHash undefined            (arm A)
 *   - 'guardHash' : warm pass, its hash forwarded to removeVR    (arm B)
 *   - 'warm-only' : warm pass, hash DISCARDED, guardHash undefined (arm C)
 */
async function runOnceLocal({ harnessRoot, candidate, armMode }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    let warmMs = null
    let warmHash = null
    if (armMode === 'guardHash' || armMode === 'warm-only') {
      const w0 = nowAbs()
      warmHash = originalTreeHashLocal(treeRoot)
      warmMs = nowAbs() - w0
    }
    // THE one-expression difference between arm B and arm C.
    const guardHash = armMode === 'guardHash' ? warmHash : undefined

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const racer = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    const markerObservedAt = racer.wait()

    let guardStartedAt = null
    let guardEndedAt = null
    const entryObserved = new Map()
    const entrySubtreeDone = new Map()
    // A non-directory's window STARTS at beforeRead; its afterOpen is the END.
    // Omitting this hook is what left 139 records here unbracketed.
    const entryReadStarted = new Map()
    const hooks = {
      afterBind: () => {
        guardStartedAt = nowAbs()
      },
      betweenGuardAndRemoval: () => {
        guardEndedAt = nowAbs()
      },
      afterOpen: (rel, type) => {
        if (!entryObserved.has(rel)) entryObserved.set(rel, { at: nowAbs(), type })
      },
      afterSubtree: (rel) => {
        entrySubtreeDone.set(rel, nowAbs())
      },
      beforeRead: (rel) => {
        if (!entryReadStarted.has(rel)) entryReadStarted.set(rel, nowAbs())
      },
    }

    const callStartedAt = nowAbs()
    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start
    const callEndedAt = nowAbs()

    const racerResult = await racer.result
    const quarantineLeft = scanQuarantineLeftovers(fx.root, candidate?.variant)

    let userFiles = { checked: 0, lost: 0, changed: 0 }
    if (racerResult.applied && racerResult.writtenPath) {
      if (racerResult.applied === 'a8') {
        let survives = false
        try {
          lstatSync(racerResult.writtenPath)
          survives = true
        } catch {
          survives = false
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: 0 }
      } else if (racerResult.writtenContent) {
        let survives = false
        let changed = false
        if (existsSync(racerResult.writtenPath)) {
          survives = true
          changed = readFileSync(racerResult.writtenPath, 'utf8') !== racerResult.writtenContent
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: changed ? 1 : 0 }
      }
    }

    const treeRootExists = existsSync(treeRoot)
    const writtenPathExists = racerResult.writtenPath ? existsSync(racerResult.writtenPath) : null

    const targetRel = a13vr.racerTargetRel(racerResult.applied)
    const observed = targetRel != null ? entryObserved.get(targetRel) : undefined
    const observedAt = observed ? observed.at : null
    const entryType = observed ? observed.type : null
    const doneAt = entryType === 'dir' ? (entrySubtreeDone.get(targetRel) ?? null) : observedAt
    // A directory's window start IS its observedAt; a file's/symlink's is beforeRead.
    const windowStartAt =
      entryType === 'dir' ? observedAt : (entryReadStarted.get(targetRel) ?? null)

    const timingCommon = {
      guardStartedAt,
      guardEndedAt,
      callEndedAt,
      mutationStartedAt: racerResult.mutationStartedAt ?? null,
      landedAt: racerResult.landedAt ?? null,
    }

    return {
      precondition: {
        hookFired: true,
        mutationApplied: !!racerResult.applied,
        controlExpected: true,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
        quarantineLeft,
      },
      userFiles,
      durationMs,
      extra: {
        racerApplied: racerResult.applied,
        racerError: racerResult.error,
        guardMode: armMode,
        warmMs,
        postMortem: { treeRootExists, writtenPathExists },
        timing: {
          markerObservedAt,
          callStartedAt,
          guardStartedAt,
          guardEndedAt,
          callEndedAt,
          markerWrittenAt: racerResult.markerWrittenAt ?? null,
          mutationStartedAt: racerResult.mutationStartedAt ?? null,
          landedAt: racerResult.landedAt ?? null,
          racerDelayMs: racerResult.delayMs ?? null,
          clockSkewCheckMs:
            racerResult.markerWrittenAt == null
              ? null
              : markerObservedAt - racerResult.markerWrittenAt,
          entry: { targetRel, entryType, observedAt, windowStartAt, doneAt },
          phase: a13vr.classifyPhase(timingCommon),
          passPhase: a13vr.classifyPassPhase(timingCommon),
          // Generation marker. `entryPhase` was REDEFINED in place when the
          // window-bracketing fix landed, against this file's own convention
          // -- `phase` and `passPhase` coexist precisely because "a relabelled
          // field cannot be compared against" older records. Records written
          // before that fix carry entry-relative labels computed by the
          // superseded classifier under the SAME field name, discriminable
          // only by whether a sibling `windowStartAt` happens to exist. This
          // makes the generation explicit: absent or 1 = pre-fix semantics
          // (a non-directory's window collapsed to its own END), 2 = windows
          // bracketed by type.
          entryPhaseRev: 2,
          entryPhase: a13vr.classifyEntryPhase({
            targetRel,
            observedAt,
            windowStartAt,
            doneAt,
            instrumented: true,
            ...timingCommon,
          }),
        },
      },
    }
  } finally {
    fx.cleanup()
  }
}

/** Arm P: three back-to-back guard passes, no racer, no removeVR. */
function runWarmProbe({ harnessRoot }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)
    const t0 = nowAbs()
    const h1 = originalTreeHashLocal(treeRoot)
    const t1 = nowAbs()
    const h2 = originalTreeHashLocal(treeRoot)
    const t2 = nowAbs()
    const h3 = originalTreeHashLocal(treeRoot)
    const t3 = nowAbs()
    return {
      precondition: { hookFired: true, mutationApplied: false, controlExpected: true },
      outcome: { status: 'probe', reason: null, path: null, errno: null },
      userFiles: { checked: 0, lost: 0, changed: 0 },
      durationMs: t3 - t0,
      extra: {
        racerApplied: null,
        guardMode: 'warm-probe',
        probe: {
          pass1ColdMs: t1 - t0,
          pass2WarmMs: t2 - t1,
          pass3WarmMs: t3 - t2,
          hashesEqual: h1 === h2 && h2 === h3,
        },
      },
    }
  } finally {
    fx.cleanup()
  }
}

// --- statistics ------------------------------------------------------------

function pct(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))
  return s[i]
}

/** Percentile bootstrap CI for the difference in medians (x - y). */
function bootstrapMedianDiff(x, y, iters = 2000) {
  if (x.length < 5 || y.length < 5) return null
  const pick = (a) => a[Math.floor(Math.random() * a.length)]
  const diffs = []
  for (let i = 0; i < iters; i += 1) {
    const bx = new Array(x.length)
    for (let j = 0; j < x.length; j += 1) bx[j] = pick(x)
    const by = new Array(y.length)
    for (let j = 0; j < y.length; j += 1) by[j] = pick(y)
    diffs.push(pct(bx, 0.5) - pct(by, 0.5))
  }
  diffs.sort((a, b) => a - b)
  return {
    point: pct(x, 0.5) - pct(y, 0.5),
    lo: diffs[Math.floor(0.025 * (diffs.length - 1))],
    hi: diffs[Math.floor(0.975 * (diffs.length - 1))],
  }
}

function sha8(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8)
  } catch {
    return null
  }
}

const RACE_ARMS = { A: 'none', B: 'guardHash', C: 'warm-only' }

async function mainWarmArm() {
  const opts = parseArgs(process.argv.slice(2))
  const harnessRoot = resolveHarnessRoot()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out =
    opts.out ??
    path.join(
      here,
      '..',
      'results',
      'raw',
      `a13-warmarm-${opts.fsLabel}-rep${opts.replicate}.jsonl`
    )
  const variant = opts.candidates[0] ?? 'V2'

  // Recorded per-record: walk.mjs / hash.mjs / a13-vr.mjs are owned by another
  // worker this session and can change between replicates. Within a replicate
  // the modules are loaded once, so all arms share one code generation; across
  // replicates these hashes say whether they did.
  const mods = {
    walk: sha8(path.join(here, '..', 'walk.mjs')),
    hash: sha8(path.join(here, '..', 'hash.mjs')),
    a13vr: sha8(path.join(here, 'attacks', 'a13-vr.mjs')),
    shared: sha8(path.join(here, 'attacks', '_shared.mjs')),
    quarantine: sha8(path.join(here, '..', 'quarantine.mjs')),
  }

  console.log(
    `[warm-arm] harnessRoot=${harnessRoot} out=${out} cycles=${opts.cycles} ` +
      `replicate=${opts.replicate} arms=${opts.arms.join(',')} candidate=${variant}`
  )
  console.log(`[warm-arm] module hashes: ${JSON.stringify(mods)}`)
  console.log('[warm-arm] arms are INTERLEAVED in one process, random permutation per cycle')
  console.log('')

  const rows = []
  const startedAt = Date.now()
  for (let cycle = 0; cycle < opts.cycles; cycle += 1) {
    const order = [...opts.arms]
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    for (let slot = 0; slot < order.length; slot += 1) {
      const arm = order[slot]
      let raw
      try {
        if (arm === 'P') {
          raw = runWarmProbe({ harnessRoot })
        } else if (arm === 'A0' || arm === 'B0') {
          raw = await a13vr.runOnce({
            harnessRoot,
            candidate: { variant },
            guardMode: arm === 'A0' ? 'none' : 'guardHash',
          })
        } else {
          raw = await runOnceLocal({
            harnessRoot,
            candidate: { variant },
            armMode: RACE_ARMS[arm],
          })
        }
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
          attack: 'A13-WARMARM',
          variant: `arm-${arm}`,
          candidate: variant,
          fs: opts.fsLabel,
          runner: 'measure-a13-race-timing.mjs --experiment warm-arm',
        },
        run: cycle,
        precondition: raw.precondition,
        outcome: raw.outcome,
        userFiles: raw.userFiles,
        durationMs: raw.durationMs,
      })
      const full = {
        ...record,
        extra: { ...(raw.extra ?? {}), arm, cycle, slot, replicate: opts.replicate, mods },
      }
      appendJsonl(out, full)
      rows.push(full)
    }
    if ((cycle + 1) % 50 === 0) {
      console.log(
        `[warm-arm] cycle ${cycle + 1}/${opts.cycles} (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`
      )
    }
  }

  reportWarmArm(rows, opts)
  console.log(`[warm-arm] done -> ${out}`)
}

function reportWarmArm(rows, opts) {
  const t = (r) => (r.extra && r.extra.timing) || null
  const callMs = (r) => t(r).callEndedAt - t(r).callStartedAt
  const guardMs = (r) =>
    t(r).guardEndedAt != null && t(r).guardStartedAt != null
      ? t(r).guardEndedAt - t(r).guardStartedAt
      : null
  const f3 = (v) => (v == null ? 'n/a' : v.toFixed(3))

  const raceArms = opts.arms.filter((a) => a !== 'P')
  const restricted = {}

  console.log('')
  console.log(`=== replicate ${opts.replicate} / ${opts.fsLabel} ===`)
  console.log(
    'arm  ran  landed  land%  overlap  loss  |  RESTRICTED (removed & landed>callEnd)  ' +
      'n  callMs p50/p95  guardMs p50/p95  |  ALL callMs p50/p95  warmMs p50/p95'
  )
  for (const arm of raceArms) {
    const all = rows.filter((r) => r.extra.arm === arm)
    const timed = all.filter((r) => t(r) && t(r).callEndedAt != null)
    const landed = timed.filter((r) => r.extra.racerApplied != null)
    const overlap = timed.filter(
      (r) =>
        t(r).landedAt != null &&
        t(r).landedAt >= t(r).callStartedAt &&
        t(r).landedAt <= t(r).callEndedAt
    ).length
    const losses = all.filter((r) => r.userFiles.lost > 0).length
    const res = timed.filter(
      (r) =>
        r.outcome.status === 'removed' && t(r).landedAt != null && t(r).landedAt > t(r).callEndedAt
    )
    restricted[arm] = {
      call: res.map(callMs),
      guard: res.map(guardMs).filter((v) => v != null),
    }
    const warm = all.map((r) => r.extra.warmMs).filter((v) => typeof v === 'number')
    console.log(
      `${arm.padEnd(4)} ${String(all.length).padEnd(5)}${String(landed.length).padEnd(8)}` +
        `${((100 * landed.length) / (timed.length || 1)).toFixed(1).padEnd(7)}` +
        `${String(overlap).padEnd(9)}${String(losses).padEnd(6)}|  ` +
        `n=${String(res.length).padEnd(5)} ` +
        `${f3(pct(restricted[arm].call, 0.5))}/${f3(pct(restricted[arm].call, 0.95))}  ` +
        `${f3(pct(restricted[arm].guard, 0.5))}/${f3(pct(restricted[arm].guard, 0.95))}  |  ` +
        `${f3(pct(timed.map(callMs), 0.5))}/${f3(pct(timed.map(callMs), 0.95))}  ` +
        `${f3(pct(warm, 0.5))}/${f3(pct(warm, 0.95))}`
    )
  }

  const cmp = (x, y, label) => {
    if (!restricted[x] || !restricted[y]) return
    const b = bootstrapMedianDiff(restricted[x].call, restricted[y].call)
    if (!b) {
      console.log(`${label}: too few samples`)
      return
    }
    console.log(
      `${label}: median callMs diff = ${b.point.toFixed(4)} ms ` +
        `[95% CI ${b.lo.toFixed(4)}, ${b.hi.toFixed(4)}] ` +
        `(${b.lo <= 0 && b.hi >= 0 ? 'CI includes 0' : 'CI excludes 0'})`
    )
  }
  console.log('')
  cmp('C', 'A', 'C - A (restricted)')
  cmp('C', 'B', 'C - B (restricted)')
  cmp('B', 'A', 'B - A (restricted)')
  cmp('B0', 'A0', 'B0 - A0 (parity, real a13-vr.runOnce)')
  cmp('A', 'A0', 'A - A0 (replica vs real, guard=none)')
  cmp('B', 'B0', 'B - B0 (replica vs real, guard=guardHash)')

  const probes = rows.filter((r) => r.extra.arm === 'P' && r.extra.probe)
  if (probes.length) {
    const p1 = probes.map((r) => r.extra.probe.pass1ColdMs)
    const p2 = probes.map((r) => r.extra.probe.pass2WarmMs)
    const p3 = probes.map((r) => r.extra.probe.pass3WarmMs)
    const bad = probes.filter((r) => !r.extra.probe.hashesEqual).length
    console.log('')
    console.log(
      `warm-probe (no racer, n=${probes.length}, ${bad} with unequal hashes): ` +
        `cold p50/p95 ${f3(pct(p1, 0.5))}/${f3(pct(p1, 0.95))}  ` +
        `warm1 ${f3(pct(p2, 0.5))}/${f3(pct(p2, 0.95))}  ` +
        `warm2 ${f3(pct(p3, 0.5))}/${f3(pct(p3, 0.95))}`
    )
    const b = bootstrapMedianDiff(p1, p2)
    if (b) {
      console.log(
        `warm-probe cold - warm1: ${b.point.toFixed(4)} ms ` +
          `[95% CI ${b.lo.toFixed(4)}, ${b.hi.toFixed(4)}]`
      )
    }
  }

  const skews = rows.map((r) => t(r) && t(r).clockSkewCheckMs).filter((v) => typeof v === 'number')
  console.log('')
  console.log(
    `clock-comparability: ${skews.length} paired timestamps, ` +
      `${skews.filter((v) => v < 0).length} negative (any non-zero invalidates every phase label)`
  )
  const errs = rows.filter((r) => r.outcome.status === 'harness-error').length
  console.log(`harness-error rows: ${errs}`)
}

if (parseArgs(process.argv.slice(2)).experiment === 'warm-arm') {
  mainWarmArm()
} else {
  main()
}
