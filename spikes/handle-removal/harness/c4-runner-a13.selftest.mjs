#!/usr/bin/env node
// SMI-6715: runner selftest: A13 handling in the runner: interleaving, straddle and vacuous counts, scored-label filing, target scope.
// Plain node; PASS/FAIL per case; non-zero exit on failure. Every runner spawn is
// sandboxed (scratch --out, --target 1, relocated short-target corpus dir) and the
// real results/raw is snapshotted around the run (see c4-selftest-util.mjs).
//
//   node harness/c4-runner-a13.selftest.mjs

import path from 'node:path'
import { readFileSync } from 'node:fs'
import { scoreCell, runCells, comboLines, buildRows } from './run-c4-attacks.mjs'
import { harnessErrorRaw } from './c4-target-guard.mjs'
import { oomRecord, oomRecordFor, makeSelftest } from './c4-selftest-util.mjs'

const { check, harnessRoot, R, finish } = makeSelftest(import.meta.url)

// ---- F4: A13 arms are interleaved per run, in random order -------------------------
const orderLog = []
const fakeMod = {
  runOnce: ({ candidate }) => {
    orderLog.push(candidate)
    throw new Error('fake: order test only')
  },
}
const cellsFor = (interleave, rng) => {
  orderLog.length = 0
  return runCells({
    mod: fakeMod,
    args: {},
    labels: ['A13-C4', 'A13-C4-OOM'],
    tag: 't',
    target: 4,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave,
    rng,
  })
}
const scripted = (vals) => {
  let i = 0
  return () => vals[i++ % vals.length]
}
check(
  'interleave: scripted rng gives exactly alternating-pair order, C4 or naive first',
  async () => {
    await cellsFor(true, scripted([0.1, 0.9, 0.1, 0.9]))
    const want = ['C4', 'C4-naive', 'C4-naive', 'C4', 'C4', 'C4-naive', 'C4-naive', 'C4']
    return JSON.stringify(orderLog) === JSON.stringify(want)
      ? true
      : `got ${JSON.stringify(orderLog)}`
  }
)
check(
  'non-interleaved (deterministic rows): all C4 runs then all C4-naive runs, unchanged',
  async () => {
    await cellsFor(false)
    const want = ['C4', 'C4', 'C4', 'C4', 'C4-naive', 'C4-naive', 'C4-naive', 'C4-naive']
    return JSON.stringify(orderLog) === JSON.stringify(want)
      ? true
      : `got ${JSON.stringify(orderLog)}`
  }
)
check(
  'interleave: real rng produces both orders; every pair has both arms; run indexes 0..n-1 per arm',
  async () => {
    orderLog.length = 0
    const cells = await runCells({
      mod: fakeMod,
      args: {},
      labels: ['A13-C4', 'A13-C4-OOM'],
      tag: 't',
      target: 40,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: true,
    })
    const pairs = []
    for (let i = 0; i < orderLog.length; i += 2) pairs.push(`${orderLog[i]}>${orderLog[i + 1]}`)
    const okPairs = pairs.every((p) => p === 'C4>C4-naive' || p === 'C4-naive>C4')
    const both = new Set(pairs).size === 2
    const idx = cells.C4.records.map((r) => r.run).join() === [...Array(40).keys()].join()
    const stamped = cells.C4.extras.every(
      (e) => e?.armOrder === 'C4-first' || e?.armOrder === 'naive-first'
    )
    return okPairs && both && idx && stamped
      ? true
      : `okPairs=${okPairs} both=${both} idx=${idx} stamped=${stamped}`
  }
)

// ---- F4: straddle count beside the A13 verdict -------------------------------------
const straddleLine = (extras) =>
  scoreCell({
    label: 'A13-C4-OOM',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [oomRecord(0, 2), oomRecord(0, 2)],
    target: 2,
    extras,
    rows: [
      {
        attack: 'A13-C4-OOM',
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: 0,
      },
    ],
  })
check('straddles: summed from extra.straddleCount when supplied', () =>
  /straddles=3(\t|$)/.test(straddleLine([{ straddleCount: 1 }, { straddleCount: 2 }]))
    ? true
    : straddleLine([{ straddleCount: 1 }, { straddleCount: 2 }])
)
check('straddles: n/a when the module supplies none', () =>
  /straddles=n\/a(\t|$)/.test(straddleLine([null, {}])) ? true : straddleLine([null, {}])
)

// ---- R2-3: every record carries the module's target for its cell -------------------
check('records carry cell.target = the module target, not the requested --target', () => {
  const o = path.join(R.scratch, 'target-check.jsonl')
  const r = R.run('run-c4-attacks.mjs', ['--only', 'a3', '--out', o])
  if (r.status !== 0) return `status=${r.status} stderr=${r.stderr.slice(0, 160)}`
  const recs = readFileSync(o, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return recs.length === 2 && recs.every((x) => x.cell.target === 30)
    ? true
    : `targets=${JSON.stringify(recs.map((x) => x.cell.target))}`
})

// ---- R2-4: A13 harness errors are filed under the scored label whatever the order --
check('A13 harness errors file under A13-C4 even when the label order is swapped', async () => {
  const throwing = {
    target: 300,
    runOnce: () => {
      throw new Error('fake: module crashed')
    },
  }
  const cells = await runCells({
    mod: throwing,
    args: {},
    labels: ['A13-C4-OOM', 'A13-C4'],
    tag: 't',
    target: 3,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: true,
  })
  const all = [...cells.C4.records, ...cells['C4-naive'].records]
  const labelsOk = [...cells.C4.runLabels, ...cells['C4-naive'].runLabels].every(
    (l) => l === 'A13-C4'
  )
  const attacksOk = all.every(
    (x) => x.cell.attack === 'A13-C4' && x.outcome.status === 'harness-error'
  )
  return labelsOk && attacksOk && all.length === 6
    ? true
    : `labelsOk=${labelsOk} attacksOk=${attacksOk}`
})

// ---- R2: vacuous-check exclusions are counted beside the A13 verdict -----------------
const vacuousLine = (extras) =>
  scoreCell({
    label: 'A13-C4',
    variant: 'racer/by-timestamp',
    candidate: 'C4',
    records: [oomRecordFor('A13-C4', 0, 2), oomRecordFor('A13-C4', 0, 2)],
    target: 2,
    extras,
    rows: [
      {
        attack: 'A13-C4',
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: 0,
      },
    ],
  })
check('vacuous: counted from extra.excludedReason === vacuous-check', () => {
  const line = vacuousLine([{ excludedReason: 'vacuous-check' }, { excludedReason: 'other' }])
  return /vacuousExcluded=1(\t|$)/.test(line) ? true : line
})
check('vacuous: n/a when the module never supplies excludedReason', () => {
  const line = vacuousLine([{}, null])
  return /vacuousExcluded=n\/a(\t|$)/.test(line) ? true : line
})

// ---- S2-High: A13 records say their target spans both A13 labels --------------------------
check(
  'A13 records carry cell.targetScope = across-a13-labels; single-label attacks do not',
  async () => {
    const throwing = {
      target: 300,
      runOnce: () => {
        throw new Error('fake: crash')
      },
    }
    const a13 = await runCells({
      mod: throwing,
      args: {},
      labels: ['A13-C4', 'A13-C4-OOM'],
      tag: 't',
      target: 2,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: true,
    })
    const one = await runCells({
      mod: throwing,
      args: {},
      labels: ['X-C4'],
      tag: 't',
      target: 2,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: false,
    })
    const a13Ok = [...a13.C4.records, ...a13['C4-naive'].records].every(
      (x) => x.cell.targetScope === 'across-a13-labels' && x.cell.target === 300
    )
    const oneOk = [...one.C4.records, ...one['C4-naive'].records].every(
      (x) => !('targetScope' in x.cell)
    )
    return a13Ok && oneOk ? true : `a13Ok=${a13Ok} oneOk=${oneOk}`
  }
)

// ---- G3-1: harness-error fallbacks never look like a racer that did not land ----------------
check('harnessErrorRaw: mutationApplied is true (a probabilistic tally must not drop it)', () => {
  const raw = harnessErrorRaw(new Error('boom'))
  return raw.precondition.mutationApplied === true &&
    raw.outcome.status === 'harness-error' &&
    /boom/.test(raw.outcome.reason)
    ? true
    : JSON.stringify(raw.precondition)
})
check('attacks runner: every harness-error record carries mutationApplied true', async () => {
  const throwing = {
    target: 30,
    runOnce: () => {
      throw new Error('fake: crash')
    },
  }
  const cells = await runCells({
    mod: throwing,
    args: {},
    labels: ['A13-C4', 'A13-C4-OOM'],
    tag: 't',
    target: 2,
    harnessRoot,
    fsLabel: 'selftest',
    out: null,
    interleave: true,
  })
  const all = [...cells.C4.records, ...cells['C4-naive'].records]
  return all.length === 4 && all.every((x) => x.precondition.mutationApplied === true)
    ? true
    : JSON.stringify(all[0]?.precondition)
})

// ---- worker-2 contract: both A13 labels share target, scope, variant, dirs and candidate ---
check(
  'A13 records of either label carry identical target, targetScope, variant, dirs and candidate',
  async () => {
    let n = 0
    const mod = {
      target: 300,
      runOnce: ({ candidate }) => {
        const label = n++ % 2 === 0 ? 'A13-C4' : 'A13-C4-OOM'
        return {
          precondition: {
            hookFired: true,
            mutationApplied: true,
            traceMatched: true,
            controlExpected: true,
          },
          outcome: { status: 'quarantined' },
          userFiles: { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 },
          durationMs: 1,
          extra: { label, variant: 'racer/by-timestamp', candidate, actualDirs: 50 },
        }
      },
    }
    const cells = await runCells({
      mod,
      args: {},
      labels: ['A13-C4', 'A13-C4-OOM'],
      tag: 'racer/by-timestamp',
      target: 4,
      harnessRoot,
      fsLabel: 'selftest',
      out: null,
      interleave: true,
      dirs: 50,
    })
    const keyOf = (x) =>
      JSON.stringify([x.cell.target, x.cell.targetScope, x.cell.variant, x.cell.dirs])
    const keys = new Set([...cells.C4.records, ...cells['C4-naive'].records].map(keyOf))
    const labels = new Set(
      [...cells.C4.records, ...cells['C4-naive'].records].map((x) => x.cell.attack)
    )
    return keys.size === 1 &&
      labels.size === 2 &&
      [...keys][0] === JSON.stringify([300, 'across-a13-labels', 'racer/by-timestamp/dirs=50', 50])
      ? true
      : `keys=${[...keys].join(' ; ')} labels=${[...labels]}`
  }
)

// ---- completeness is judged across BOTH A13 labels (universe), as generate-summary does ----
const scoped = (attack) => {
  const rec = oomRecordFor(attack, 0, 4)
  rec.cell.targetScope = 'across-a13-labels'
  rec.cell.dirs = null
  return rec
}
check(
  'scoreCell: 2 A13-C4 + 2 A13-C4-OOM records against target 4 are complete across labels',
  () => {
    const scored = [scoped('A13-C4'), scoped('A13-C4')]
    const oom = [scoped('A13-C4-OOM'), scoped('A13-C4-OOM')]
    const line = scoreCell({
      label: 'A13-C4',
      variant: 'racer/by-timestamp',
      candidate: 'C4',
      records: scored,
      target: 2,
      universe: [...scored, ...oom],
      rows: [
        {
          attack: 'A13-C4',
          variant: 'racer/by-timestamp',
          candidate: 'C4',
          fs: 'selftest',
          failed: 0,
        },
      ],
    })
    return /^INCOMPLETE/.test(line) ? `still INCOMPLETE: ${line}` : true
  }
)
check(
  'scoreCell: with only 3 of 4 runs across the labels the cell IS INCOMPLETE (negative control)',
  () => {
    const scored = [scoped('A13-C4'), scoped('A13-C4')]
    const oom = [scoped('A13-C4-OOM')]
    const line = scoreCell({
      label: 'A13-C4',
      variant: 'racer/by-timestamp',
      candidate: 'C4',
      records: scored,
      target: 2,
      universe: [...scored, ...oom],
      rows: [
        {
          attack: 'A13-C4',
          variant: 'racer/by-timestamp',
          candidate: 'C4',
          fs: 'selftest',
          failed: 0,
        },
      ],
    })
    return /^INCOMPLETE \(ran 3\/4 across A13 labels\)/.test(line) ? true : line
  }
)

check(
  'comboLines: the printed A13-C4 line is judged across both labels (the main() wiring)',
  () => {
    const scoredRecs = [scoped('A13-C4'), scoped('A13-C4')]
    const oomRecs = [scoped('A13-C4-OOM'), scoped('A13-C4-OOM')]
    const mk = (records) => ({
      records,
      extras: records.map(() => null),
      variant: 'racer/by-timestamp',
    })
    const groupsFor = (a, b) =>
      new Map([
        ['A13-C4', mk(a)],
        ['A13-C4-OOM', mk(b)],
      ])
    const lines = comboLines({
      labels: ['A13-C4', 'A13-C4-OOM'],
      cells: { C4: { records: [...scoredRecs, ...oomRecs] }, 'C4-naive': { records: [] } },
      groups: { C4: groupsFor(scoredRecs, oomRecs), 'C4-naive': groupsFor([], []) },
      rows: ['A13-C4', 'A13-C4-OOM'].map((attack) => ({
        attack,
        variant: 'racer/by-timestamp',
        candidate: 'C4',
        fs: 'selftest',
        failed: 0,
      })),
      groupTarget: (g) => g.records.length,
    })
    const line = lines.find((l) => l.includes('A13-C4/racer/by-timestamp/C4\t'))
    return line && !/^INCOMPLETE/.test(line) ? true : `got ${JSON.stringify(lines[0])}`
  }
)

// ---- control rows carry controlFailures, so harness-error losses cannot satisfy a control ----
check('buildRows copies controlFailures from the aggregate (not just failed)', () => {
  const g = { records: [{}], extras: [null], variant: 'v' }
  const groups = { C4: new Map([['X-C4', g]]), 'C4-naive': new Map([['X-C4', g]]) }
  const rows = buildRows({
    labels: ['X-C4'],
    groups,
    fsLabel: 'f',
    groupTarget: () => 1,
    aggregate: () => ({ failed: 3, controlFailures: 0 }),
  })
  return rows.length === 2 && rows.every((r) => r.failed === 3 && r.controlFailures === 0)
    ? true
    : JSON.stringify(rows)
})
check(
  'a naive arm of harness-error losses (controlFailures 0) leaves C4 with control=DID-NOT-FAIL',
  () => {
    const rec = (attack, candidate) => {
      const r = oomRecordFor('A3-C4', 0, 1)
      r.cell.candidate = candidate
      r.cell.variant = 'v'
      return r
    }
    const g = (c) => ({ records: [rec('A3-C4', c)], extras: [null], variant: 'v' })
    const groups = {
      C4: new Map([['A3-C4', g('C4')]]),
      'C4-naive': new Map([['A3-C4', g('C4-naive')]]),
    }
    const rows = buildRows({
      labels: ['A3-C4'],
      groups,
      fsLabel: 'selftest',
      groupTarget: () => 1,
      // naive: 3 failures, all from harness errors; C4: none
      aggregate: (records) =>
        records[0].cell.candidate === 'C4-naive'
          ? { failed: 3, controlFailures: 0 }
          : { failed: 0, controlFailures: 0 },
    })
    const line = scoreCell({
      label: 'A3-C4',
      variant: 'v',
      candidate: 'C4',
      records: groups.C4.get('A3-C4').records,
      target: 1,
      rows,
    })
    return /control=DID-NOT-FAIL/.test(line) ? true : line
  }
)

await finish()
