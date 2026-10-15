#!/usr/bin/env node
// SMI-7123 Wave 5 (Sol PR #3091 finding PR-17): the destructive walk is reachable
// only through the walker child's CLI entry. An in-process caller -- even one that
// sets SKILLSMITH_PRUNE_WALKER=1 itself -- must find no export that runs P4, and an
// importer that points process.argv[1] at the walker must not make it the entry
// (the entry test is import.meta.main, which in-process code cannot set).
//
// The jobs used here are REAL: prune() is run with a capture walker (node -e) that
// records the exact job it would have handed the walker child and deletes nothing.
//
// DECLARED FAILURES ON THE PRE-FIX CODE:
//  - prune.walk.mjs exports stageVerifyDelete; called in-process with the env flag
//    set it walks the captured job and the copy is gone ("A: the copy survives");
//  - the entry test was argv-based, so a child that sets process.argv[1] to the
//    walker's path plus the env flag and imports it walks the job on stdin and the
//    copy is gone ("B: the copy survives an importer that spoofs argv[1]...").

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { prune } from '../prune.mjs'
import { decodeJob } from '../prune.job.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { check, done } = makeCheck('[w5-walker-private]')
const yes = () => true
const CAPTURE =
  "const fs = require('fs'); fs.appendFileSync(process.env.W5_CAP, fs.readFileSync(0, 'utf8').trim() + '\\n'); " +
  "process.stdout.write(JSON.stringify({ status: 'kept', reason: 'captured' }) + '\\n')"

/** Runs fn with the walker env flag forced on and the cwd restored afterwards. */
function inProcess(fn) {
  const cwd = process.cwd()
  const saved = process.env.SKILLSMITH_PRUNE_WALKER
  process.env.SKILLSMITH_PRUNE_WALKER = '1'
  try {
    return { value: fn(), error: null }
  } catch (err) {
    return { value: null, error: err }
  } finally {
    if (saved === undefined) delete process.env.SKILLSMITH_PRUNE_WALKER
    else process.env.SKILLSMITH_PRUNE_WALKER = saved
    process.chdir(cwd)
  }
}

const f = makeParent('w5-private-')
try {
  park(f.parent, 'a', 'Q')
  park(f.parent, 'b', 'Q')
  const cap = path.join(f.root, 'jobs.jsonl')
  const r = prune({
    roots: [f.parent],
    apply: true,
    confirmBatch: yes,
    walker: { path: 'w5-capture', execArgv: ['-e', CAPTURE], env: { W5_CAP: cap } },
  })
  const jobs = fs.existsSync(cap)
    ? fs
        .readFileSync(cap, 'utf8')
        .trim()
        .split('\n')
        .map((l) => decodeJob(JSON.parse(l)))
    : []
  check('premise: prune handed the capture walker two real jobs', jobs.length, 2)
  check(
    'premise: the capture walker deleted nothing',
    r.items.map((i) => i.reason).join(','),
    'captured,captured'
  )
  const [ja, jb] = jobs

  // --- A: no export of prune.walk.mjs runs P4 in this process ----------------------
  const walk = await import('../prune.walk.mjs')
  const destructive = ['stageVerifyDelete', 'deleteVerified'].filter(
    (n) => typeof walk[n] === 'function'
  )
  check('A: prune.walk.mjs exports no destructive function', destructive.join(','), '')
  check('A: prune.walk.mjs exports nothing at all', Object.keys(walk).join(','), '')
  check('premise A: the copy exists before the attempt', fs.existsSync(ja.copyPath), true)
  const a = inProcess(() =>
    typeof walk.stageVerifyDelete === 'function' ? walk.stageVerifyDelete(ja) : null
  )
  check(
    `A: the copy survives an in-process call${a.value ? ` (got ${a.value.status})` : ''}`,
    fs.existsSync(ja.copyPath),
    true
  )

  // --- B: an importer cannot make this module the entry by setting argv[1] ----------
  // process.argv[1] is mutable, so it cannot be the entry test. A child sets argv[1]
  // to the walker's path AND the env flag, then imports the walker with the real job
  // on stdin. The walker's entry body reads stdin and walks only if it believes it
  // is the entry; the copy must survive and no ItemResult may be printed.
  const walkerPath = path.resolve(HERE, '..', 'prune.walk.mjs')
  const SPOOF =
    'process.argv[1] = process.env.W5_WALKER; ' +
    "await import(process.env.W5_WALKER_URL + '?spoof=' + Date.now())"
  const rawA = fs.readFileSync(cap, 'utf8').trim().split('\n')[0]
  const spoof = spawnSync(process.execPath, ['--input-type=module', '-e', SPOOF], {
    cwd: HERE,
    input: rawA,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKILLSMITH_PRUNE_WALKER: '1',
      W5_WALKER: walkerPath,
      W5_WALKER_URL: pathToFileURL(walkerPath).href,
    },
  })
  check(
    `B: the spoofing child exited cleanly (status ${spoof.status}, ${spoof.stderr.trim().slice(0, 120)})`,
    spoof.status,
    0
  )
  check('B: the spoofing child printed no ItemResult', spoof.stdout.trim(), '')
  check(
    'B: the copy survives an importer that spoofs argv[1] and the env flag',
    fs.existsSync(ja.copyPath),
    true
  )
  // Positive control: the same job, run as the real entry, walks and removes the copy.
  // Without this the survival above could be a walker that never runs for any reason.
  const real = spawnSync(process.execPath, [walkerPath], {
    cwd: HERE,
    input: fs.readFileSync(cap, 'utf8').trim().split('\n')[1],
    encoding: 'utf8',
    env: { ...process.env, SKILLSMITH_PRUNE_WALKER: '1' },
  })
  let realStatus = null
  try {
    realStatus = JSON.parse(real.stdout.trim()).status
  } catch {
    /* reported by the check below */
  }
  check(
    `control B: the walker run as the entry removes its copy (${real.stderr.trim().slice(0, 120)})`,
    realStatus,
    'removed'
  )
  check('control B: the entry run deleted the second copy', fs.existsSync(jb.copyPath), false)
} finally {
  rmFixture(f.root)
}
done()
