// SMI-6715: helpers for selftests that spawn the C4 runners, so a mis-parsed
// command line can never write into the evidence corpus (results/raw/).
//
//  - runner(): every spawn gets --out inside a scratch temp dir and --target 1
//    unless the case names its own, and C4_RESULTS_RAW_DIR points the short-target
//    guard at a scratch directory instead of the real corpus.
//  - snapshotDir(): names + sizes of everything under a directory, so a selftest
//    can fail if the corpus changed at all while it ran.

import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeRecord } from './result-schema.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'

/** Sorted "relpath:size" listing (recursive); 'MISSING' if the directory is absent. */
export function snapshotDir(dir) {
  const out = []
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const p = path.join(abs, name)
      const st = lstatSync(p)
      const r = rel === '' ? name : `${rel}/${name}`
      if (st.isDirectory()) {
        out.push(`${r}/`)
        walk(p, r)
      } else out.push(`${r}:${st.size}`)
    }
  }
  try {
    walk(dir, '')
  } catch (err) {
    if (err.code === 'ENOENT') return 'MISSING'
    throw err
  }
  return JSON.stringify(out)
}

/**
 * @param {string} harnessDir - the harness/ directory
 * @returns {{run:(script:string, args:string[], opts?:{noOut?:boolean}) => object,
 *            scratch:string, simRaw:string, cleanup:() => void}}
 */
export function makeRunner(harnessDir) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'c4-selftest-'))
  const simRaw = path.join(scratch, 'results-raw')
  mkdirSync(simRaw)
  const run = (script, args, opts = {}) => {
    const full = [...args]
    if (!opts.noOut && !full.includes('--out')) full.push('--out', path.join(scratch, 'o.jsonl'))
    if (!full.includes('--target')) full.push('--target', '1')
    return spawnSync(process.execPath, [path.resolve(harnessDir, script), ...full], {
      encoding: 'utf8',
      env: { ...process.env, C4_RESULTS_RAW_DIR: simRaw },
    })
  }
  return { run, scratch, simRaw, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
}

/** A synthetic single-run record for a given A13 label; cell.target is what a summary compares `ran` with. */
export const oomRecordFor = (attack, lost = 0, target = 1) => {
  const rec = makeRecord({
    cell: {
      attack,
      variant: 'racer/by-timestamp',
      candidate: 'C4',
      fs: 'selftest',
      runner: 'c4-selftest-util.mjs',
    },
    run: 0,
    precondition: {
      hookFired: true,
      mutationApplied: true,
      traceMatched: true,
      controlExpected: true,
    },
    outcome: { status: 'quarantined' },
    userFiles: { checked: 1, lost, changed: 0, displaced: lost, deleted: 0 },
    durationMs: 1,
  })
  rec.cell.target = target
  return rec
}
export const oomRecord = (lost, target = 1) => oomRecordFor('A13-C4-OOM', lost, target)

/**
 * Shared scaffolding for the runner selftests: PASS/FAIL reporting, a sandboxed
 * runner (see makeRunner), and a final check that results/raw did not change.
 * Sync cases run where they are registered; async cases share module state and
 * are queued, then run one at a time by finish().
 */
export function makeSelftest(metaUrl) {
  const here = path.dirname(fileURLToPath(metaUrl))
  const harnessRoot = resolveHarnessRoot()
  let failures = 0
  const report = (name, why) => {
    if (why === true || why === undefined) console.log(`PASS  ${name}`)
    else {
      failures += 1
      console.log(`FAIL  ${name}: ${why}`)
    }
  }
  const queued = []
  const check = (name, fn) => {
    if (fn.constructor.name === 'AsyncFunction') {
      queued.push({ name, fn })
      return
    }
    try {
      report(name, fn())
    } catch (err) {
      report(name, `threw ${err?.message ?? err}`)
    }
  }
  const realRaw = path.join(here, '..', 'results', 'raw')
  const rawBefore = snapshotDir(realRaw)
  const R = makeRunner(here)
  const exits2With = (r, re) =>
    r.status === 2 && re.test(r.stderr)
      ? true
      : `status=${r.status} stderr=${r.stderr.slice(0, 240)}`
  const finish = async () => {
    for (const { name, fn } of queued) {
      try {
        report(name, await fn())
      } catch (err) {
        report(name, `threw ${err?.message ?? err}`)
      }
    }
    check('results/raw is byte-for-byte unchanged by this selftest (names + sizes)', () => {
      const after = snapshotDir(realRaw)
      return after === rawBefore ? true : `changed:\n before=${rawBefore}\n after=${after}`
    })
    R.cleanup()
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  }
  return { here, harnessRoot, check, R, run: R.run, exits2With, finish }
}
