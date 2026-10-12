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
