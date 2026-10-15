#!/usr/bin/env node
// SMI-7123 Wave 5 (Sol PR #3091 finding PR-17): the destructive walk is reachable
// only through the walker child's CLI entry. An in-process caller -- even one that
// sets SKILLSMITH_PRUNE_WALKER=1 itself -- must find no export that runs P4, and
// the deletion walk (prune.walk.delete.mjs) must refuse to run outside that entry.
//
// The jobs used here are REAL: prune() is run with a capture walker (node -e) that
// records the exact job it would have handed the walker child and deletes nothing.
//
// DECLARED FAILURES ON THE PRE-FIX CODE:
//  - prune.walk.mjs exports stageVerifyDelete; called in-process with the env flag
//    set it walks the captured job and the copy is gone ("A: the copy survives");
//  - prune.walk.delete.mjs's deleteVerified, called in-process on a staged and
//    verified copy, deletes it ("B: the staged copy survives").

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { prune } from '../prune.mjs'
import { decodeJob } from '../prune.job.mjs'

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
  check('premise A: the copy exists before the attempt', fs.existsSync(ja.copyPath), true)
  const a = inProcess(() =>
    typeof walk.stageVerifyDelete === 'function' ? walk.stageVerifyDelete(ja) : null
  )
  check(
    `A: the copy survives an in-process call${a.value ? ` (got ${a.value.status})` : ''}`,
    fs.existsSync(ja.copyPath),
    true
  )

  // --- B: the deletion walk refuses outside the walker child entry -----------------
  const { verifyAtStaging } = await import('../prune.walk.verify.mjs')
  const { deleteVerified } = await import('../prune.walk.delete.mjs')
  const S = path.join(jb.trashRoot, '.prune-private-test')
  fs.mkdirSync(S, { mode: 0o700 })
  fs.renameSync(jb.copyPath, path.join(S, jb.leaf))
  let sidecar = null
  if (jb.sidecarRead !== null) {
    fs.renameSync(jb.sidecarPath, path.join(S, 'sidecar.json'))
    sidecar = { ino: jb.sidecarRead.ino, bytes: jb.sidecarRead.bytes }
  }
  const v = verifyAtStaging(S, jb.leaf, {
    approvedHash: jb.approvedHash,
    rootIdentity: jb.rootIdentity,
    sidecar,
  })
  check(`premise B: the staged copy verifies${v.ok ? '' : ` (${v.reason})`}`, v.ok, true)
  const sd = fs.lstatSync(S, { bigint: true })
  const sIdentity = { type: 'dir', dev: sd.dev, ino: sd.ino, birthtimeNs: sd.birthtimeNs }
  const b = inProcess(() =>
    deleteVerified(S, jb.leaf, v.inventory, sIdentity, { pruneId: 'x', wrote: {} })
  )
  check('B: the staged copy survives', fs.existsSync(path.join(S, jb.leaf)), true)
  check(
    `B: deleteVerified refused${b.error ? '' : ' (it returned instead)'}`,
    /only in the dedicated prune walker child/.test(b.error?.message ?? ''),
    true
  )
} finally {
  rmFixture(f.root)
}
done()
