#!/usr/bin/env node
// SMI-6715 Step 1b, C4 repair: what happens at the ORIGIN after the rename, and
// the hold sidecar's write rules (design §1 S9/S11, §3 windows 1-3, §5, §8 R7,
// R-a, R12, C-fd).
//
// Owner decision A: never move back. Nothing in C4 may rename onto, create, or
// write at originPath after the root rename. R-a is the case that motivated it
// (Sol round 1, finding 1): a writer re-creates the origin and holds it as its
// cwd; replacing that directory would orphan the writer's later writes.
//
// DECLARED FAILURES ON TODAY'S CODE:
//  - R7, R-a, sidecar-error: status 'quarantined' where 'held' is expected (the
//    post-hash append is not detected). R-a's own property assertions (writer
//    inode, writer bytes, no origin-side call after the rename) PASS today --
//    today never moves back either; R-a's required check is the mutation that
//    re-introduces a move-back.
//  - wx: today's sidecar write uses the default 'w' flag, so a file already at
//    the sidecar path is OVERWRITTEN and no sidecarError is reported.
//  - R12: passes today (no guard, no verification); its check is the mutation
//    that drops S9's guardHash gate.
//  - C-fd: no postMoveTreeHash in today's sidecar.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import {
  buildFixture,
  cleanup,
  readJson,
  readText,
  runWithHooks,
  waitUntil,
  sleepMs,
} from './postmove-seam.mjs'

const TAG = '[quarantine-postmove-origin]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const HEX64 = /^[0-9a-f]{64}$/
let opSeq = 0
const nextOp = () => `pm-op-${process.pid}-${++opSeq}`
const append = (f) => fs.appendFileSync(path.join(f.target, 'orig-f1'), '-late')
const guardOf = (f) => computePathTreeHash(f.origin).treeHash

/** Origin-side calls (path or second path at/inside origin) after the root rename. */
function originCallsAfterRename(run) {
  if (run.renameIdx === -1) return ['NO-ROOT-RENAME-IN-TRACE']
  return run.trace
    .slice(run.renameIdx + 1)
    .filter(
      (e) =>
        e.scope === 'origin' || e.scope === 'desc' || e.scope2 === 'origin' || e.scope2 === 'desc'
    )
    .map((e) => `${e.fn}(${e.p0}${e.p1 ? ` -> ${e.p1}` : ''})`)
}
/** Paired presence proof: recording continued past the rename (a dest call was seen). */
const destCallsAfterRename = (run) =>
  run.renameIdx === -1
    ? 0
    : run.trace.slice(run.renameIdx + 1).filter((e) => e.scope === 'dest').length

// --- R7: the origin is re-created before S9 -> held, writer's dir untouched --
for (const variant of ['empty', 'non-empty']) {
  const f = buildFixture()
  const opId = nextOp()
  let writerIno = null
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: f.name,
    options: { guardHash: guardOf(f), opId },
    onRecheck: () => append(f),
    onAfterRename: () => {
      fs.mkdirSync(f.origin)
      if (variant === 'non-empty')
        fs.writeFileSync(path.join(f.origin, 'writer.txt'), 'writer-bytes')
      writerIno = fs.lstatSync(f.origin).ino
    },
  })
  const L = `R7 ${variant}`
  check(
    `${L} hooks fired`,
    run.fired.recheck && run.fired.afterRename && run.hookErrors.length === 0,
    true
  )
  check(`${L} status`, run.result.status, 'held')
  check(`${L} the writer's directory is the one at origin`, fs.lstatSync(f.origin).ino, writerIno)
  check(
    `${L} its content is unchanged`,
    fs.readdirSync(f.origin).sort().join(','),
    variant === 'empty' ? '' : 'writer.txt'
  )
  if (variant === 'non-empty')
    check(`${L} writer bytes`, readText(path.join(f.origin, 'writer.txt')), 'writer-bytes')
  check(`${L} no origin-side call after the rename`, originCallsAfterRename(run).join(' | '), '')
  check(
    `${L} recording continued past the rename (presence control)`,
    destCallsAfterRename(run) > 0,
    true
  )
  cleanup(f.root)
}

// --- R-a: a writer HOLDS the re-created origin as its cwd and writes later ---
// The child re-creates the origin, cd's into it, signals, and writes `new-file`
// relative to its cwd only after C4 has returned. If C4 replaced that directory
// (a move-back), the write would land in an unlinked directory and vanish.
{
  const f = buildFixture()
  const sig = path.join(f.root, 'sig')
  fs.mkdirSync(sig)
  const opId = nextOp()
  let child = null
  const script =
    'mkdir "$1" && cd "$1" && ls -di . | awk \'{print $1}\' > "$2/ino" && : > "$2/ready" && ' +
    'while [ ! -e "$2/go" ]; do sleep 0.02; done; printf %s writer-held-bytes > new-file && : > "$2/done"'
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: f.name,
    options: { guardHash: guardOf(f), opId },
    onRecheck: () => append(f),
    onAfterRename: () => {
      child = spawn('/bin/sh', ['-c', script, 'ra', f.origin, sig], { stdio: 'ignore' })
      if (!waitUntil(() => fs.existsSync(path.join(sig, 'ready')), 10000)) {
        throw new Error('R-a writer never signalled ready')
      }
    },
  })
  fs.writeFileSync(path.join(sig, 'go'), '')
  const doneOk = waitUntil(() => fs.existsSync(path.join(sig, 'done')), 10000)
  const childIno = readText(path.join(sig, 'ino')).trim()
  check('R-a hooks fired, writer ready', run.fired.afterRename && run.hookErrors.length === 0, true)
  check('R-a writer finished', doneOk, true)
  check('R-a status', run.result.status, 'held')
  check(
    "R-a origin is the writer's directory (inode)",
    String(fs.lstatSync(f.origin).ino),
    childIno
  )
  check(
    "R-a the writer's later write is reachable at origin",
    readText(path.join(f.origin, 'new-file')),
    'writer-held-bytes'
  )
  check('R-a no origin-side call after the rename', originCallsAfterRename(run).join(' | '), '')
  check(
    'R-a recording continued past the rename (presence control)',
    destCallsAfterRename(run) > 0,
    true
  )
  if (child && child.exitCode === null) child.kill()
  sleepMs(20)
  cleanup(f.root)
}

// --- R12: no guardHash -> no verification at all ----------------------------
// With no guard there is no re-check lstat, so the mutation lands at the rename.
{
  const f = buildFixture()
  const opId = nextOp()
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: f.name,
    options: { opId },
    onRename: () => append(f),
  })
  check('R12 mutation fired at the rename', run.fired.rename && run.hookErrors.length === 0, true)
  check('R12 an unguarded call is quarantined', run.result.status, 'quarantined')
  const sidecar = readJson(run.result.sidecarPath)
  check('R12 its sidecar has no hold', sidecar?.hold, undefined)
  check('R12 and claims no post-move verification', sidecar?.postMoveVerified, undefined)
  cleanup(f.root)
}

// --- §5 wx: a file already at the sidecar path is never overwritten ---------
for (const mode of ['held', 'quarantined']) {
  const f = buildFixture()
  const opId = nextOp()
  let planted = null
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: f.name,
    options: { guardHash: guardOf(f), opId },
    onRecheck: mode === 'held' ? () => append(f) : undefined,
    onAfterRename: ({ destPath }) => {
      planted = `${destPath}.json`
      fs.writeFileSync(planted, 'PRE-EXISTING')
    },
  })
  const L = `S11-wx ${mode}`
  check(
    `${L} planted before the sidecar write`,
    planted !== null && run.hookErrors.length === 0,
    true
  )
  check(`${L} status is unchanged by the failed write`, run.result.status, mode)
  check(`${L} the planted file is not overwritten`, readText(planted), 'PRE-EXISTING')
  check(`${L} sidecarError names EEXIST`, run.result.sidecarError, 'EEXIST')
  cleanup(f.root)
}

// --- S11: a sidecar write failure is recorded and does not change `held` -----
{
  const f = buildFixture()
  const opId = nextOp()
  let opDir = null
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: f.name,
    options: { guardHash: guardOf(f), opId },
    onRecheck: () => append(f),
    onAfterRename: ({ destPath }) => {
      opDir = path.dirname(destPath)
      fs.chmodSync(opDir, 0o500)
    },
  })
  check('S11-err status stays held', run.result.status, 'held')
  check('S11-err sidecarError names EACCES', run.result.sidecarError, 'EACCES')
  check(
    'S11-err the held copy is still there',
    readText(path.join(String(run.result.path), 'target', 'orig-f1')),
    'original-content-f1-late'
  )
  if (opDir) fs.chmodSync(opDir, 0o700)
  cleanup(f.root)
}

// --- C-fd (characterization, residual 1): a write through an fd opened before
// the call, landing after `quarantined`, makes the trash copy differ from the
// recorded postMoveTreeHash. Prune must classify it `changed` (SMI-7118).
{
  const f = buildFixture()
  const guardHash = guardOf(f)
  const fd = fs.openSync(path.join(f.target, 'orig-f1'), 'a')
  const r = quarantineTree(f.parent, f.name, { guardHash, opId: nextOp() })
  fs.writeSync(fd, '-written-through-fd')
  fs.closeSync(fd)
  const sidecar = readJson(r.sidecarPath)
  check('C-fd the call itself was clean', r.status, 'quarantined')
  check('C-fd postMoveTreeHash recorded', HEX64.test(String(sidecar?.postMoveTreeHash)), true)
  check('C-fd and it equals the guard (clean when verified)', sidecar?.postMoveTreeHash, guardHash)
  const now = computePathTreeHash(String(r.path))
  check(
    'C-fd the trash copy now differs from it (the residual)',
    now.ok && now.treeHash !== sidecar?.postMoveTreeHash,
    true
  )
  check(
    'C-fd the fd write landed in the trash copy',
    readText(path.join(String(r.path), 'target', 'orig-f1')),
    'original-content-f1-written-through-fd'
  )
  cleanup(f.root)
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
