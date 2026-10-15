// SMI-6715 Step 1b part 2, item 4: A13-C4-POSTHASH and A13's held scoring.
//
//  P1-P6  phaseClass: a landing's class against C4's OWN hash end
//         (pre-hash / post-hash / post-rename / unknown), boundaries exact.
//  G1-G3  the step racer's go-marker mode: it does not mutate before the
//         marker exists, and its first step starts after it saw the marker.
//  S1-S2  scoreRacer for a HELD run scores the racer's expectations in the held
//         copy (location of record); the same input without held scores them at
//         the origin, where they read lost/displaced.
//  R1-R3  one real A13-C4-POSTHASH run per arm (fixture scale): label, variant,
//         release stamp, phase classes, held evidence when C4 holds.
//
// DECLARED FAILURE ON THE PRE-CHANGE CODE: phaseClass, scoreRacer and
// a13-c4.posthash.mjs do not exist, so this file fails at import -- a setup
// failure, not the property. Each property is therefore pinned by a named
// mutation in the hand-back instead (phase boundary, go-marker wait, held probe
// root, posthash label).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { phaseClass } from './attacks/a13-c4.classify.mjs'
import { scoreRacer } from './attacks/a13-c4.mjs'
import { spawnStepRacer } from './attacks/a13-c4.racer.mjs'
import * as posthash from './attacks/a13-c4.posthash.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { makeRecord, classifyRecord } from './result-schema.mjs'
import { sleepMs } from './postmove-seam.mjs'

const TAG = '[a13-c4 posthash self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

// --- phaseClass --------------------------------------------------------------
const pc = (s, l) => phaseClass({ s, l, hashEndAt: 10, moveEnd: 20 })
check('P1 ends before the hash end -> pre-hash', pc(5, 9.99), 'pre-hash')
check(
  'P2 ends exactly at the hash end -> post-hash (window closed at its start)',
  pc(9, 10),
  'post-hash'
)
check('P3 inside the window -> post-hash', pc(12, 13), 'post-hash')
check(
  'P4 starts exactly at the move end -> post-hash (window includes the return)',
  pc(20, 21),
  'post-hash'
)
check('P5 starts after the move end -> post-rename', pc(20.01, 21), 'post-rename')
check(
  'P6 a missing stamp -> unknown',
  phaseClass({ s: 1, l: 2, hashEndAt: null, moveEnd: 3 }),
  'unknown'
)

// --- the racer's go-marker mode ----------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-go-'))
  const target = path.join(root, 'tree', 'target')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'orig-f1'), 'orig')
  const go = path.join(root, '.racer-go')
  const sp = spawnStepRacer(target, path.join(root, '.racer-ready'), 'a7', {
    goMarkerPath: go,
    delayMs: 0,
  })
  sp.wait()
  sleepMs(150)
  check(
    'G1 nothing mutated before the go marker',
    fs.readFileSync(path.join(target, 'orig-f1'), 'utf8'),
    'orig'
  )
  fs.writeFileSync(go, '1')
  const res = await sp.result
  check('G2 the racer ran after the marker', Array.isArray(res.steps) && res.steps.length, 2)
  check(
    'G3 its first step started after it saw the marker',
    typeof res.goSeenAt === 'number' && res.steps[0].startAt >= res.goSeenAt,
    true
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// --- scoreRacer: held runs are scored in the held copy -------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-sr-'))
  const treeRoot = path.join(root, 'tree') // the origin: empty after the move
  const held = path.join(root, '.skillsmith-trash', 'op', 'tree-1')
  fs.mkdirSync(path.join(held, 'target'), { recursive: true })
  fs.writeFileSync(path.join(held, 'target', 'orig-f1'), 'racer-bytes')
  const racer = {
    steps: [
      { op: 'unlink', path: path.join(treeRoot, 'target', 'orig-f1') },
      { op: 'write', path: path.join(treeRoot, 'target', 'orig-f1'), content: 'racer-bytes' },
    ],
  }
  const h = scoreRacer(racer, treeRoot, held, { held: true })
  check('S1 held: the racer bytes are intact in the held copy (lost 0)', h.scored?.lost, 0)
  const q = scoreRacer(racer, treeRoot, held, { held: false })
  check(
    'S2 control, not held: scored at the origin they read lost and displaced',
    `${q.scored?.lost}/${q.scored?.displaced}`,
    '1/1'
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// --- one real run per arm ---------------------------------------------------------
const harnessRoot = resolveHarnessRoot()
for (const candidate of ['C4', 'C4-naive']) {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-tr-'))
  let raw
  try {
    raw = await posthash.runOnce({ harnessRoot, candidate, traceDir })
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
  const L = `R ${candidate}`
  check(`${L} label`, raw.extra.label, 'A13-C4-POSTHASH')
  check(`${L} variant`, raw.extra.variant, 'racer/post-hash')
  check(`${L} release stamp recorded`, typeof raw.extra.timing?.hashEndAt, 'number')
  check(
    `${L} one phase class per landing`,
    raw.extra.phaseClasses?.length,
    raw.extra.landings?.length
  )
  // Every run ATTEMPTED a mutation, landed or not: a racer whose first step
  // failed (ENOENT: the tree had already moved) has no landing but still has an
  // attempt phase, so the distribution counts non-landings too.
  check(
    `${L} the racer's attempt has a phase class`,
    ['pre-hash', 'post-hash', 'post-rename'].includes(raw.extra.racerAttemptPhase),
    true
  )
  if (raw.outcome.status === 'held') {
    check(
      `${L} a held run carries held-copy evidence`,
      raw.outcome.heldEvidence?.location,
      'held-copy'
    )
  }
  const rec = makeRecord({
    cell: {
      attack: raw.extra.label,
      variant: raw.extra.variant,
      candidate,
      fs: 'f',
      runner: 't',
      target: posthash.target,
    },
    run: 0,
    precondition: raw.precondition,
    outcome: raw.outcome,
    userFiles: raw.userFiles,
  })
  console.log(
    `${TAG} ${L} observed: status=${raw.outcome.status} class=${classifyRecord(rec)} phases=${JSON.stringify(raw.extra.phaseClasses)}`
  )
}
check('R3 the module scores 300 runs per cell, like A13-C4', posthash.target, 300)

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
