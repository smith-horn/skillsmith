#!/usr/bin/env node
// SMI-6715 Step 1b, C4 repair (design §1 S9/S11/S12, §8 R1-R6, D-8 plumbing).
//
// A guarded C4 call re-checks only the ROOT's identity before rename(2). Every
// A4 / A7-late mutation lands after C4's own hash and before the rename, so
// today's code MOVES the mutated tree and reports `quarantined` (Probe 2). The
// repair verifies the tree again at its destination (S9) and, on any mismatch,
// returns `held` and writes a `hold:true` sidecar -- never moving anything back.
//
// Each case fires through runC4Candidate (the harness's own seam) so it also
// pins the trace matcher's acceptance of a `held` result (design §9).
//
// DECLARED FAILURE ON TODAY'S CODE, per case: status 'quarantined' where 'held'
// is expected, reason null, and no `hold` in the sidecar. D-8: shapeResult
// throws "unknown status" for 'held'. S12: the quarantined sidecar has no
// postMoveVerified/postMoveTreeHash. Every read below is defensive so a red run
// reports every case rather than dying at the first missing file.

import fs from 'node:fs'
import path from 'node:path'
import { runC4Candidate } from './attacks/c4-shared.mjs'
import { computePathTreeHash } from '../quarantine.mjs'
import { RESULT_FIELDS, shapeResult, isSuccess } from '../result-shape.mjs'
import { buildFixture, cleanup, populate, readJson, readText } from './postmove-seam.mjs'

const TAG = '[quarantine-postmove]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const HEX64 = /^[0-9a-f]{64}$/
const insideTrash = (p, parent) =>
  typeof p === 'string' && p.startsWith(path.join(parent, '.skillsmith-trash') + path.sep)

/**
 * Runs C4 with `mutate(f)` at `window`, then checks the held contract common to
 * every post-move detection. `heldCheck(f, heldPath)` asserts the case's own
 * mutation is present byte-exact in the held copy. Returns {f, r, sidecar} with
 * the fixture still on disk; the caller cleans up.
 */
function heldCase(
  label,
  { window = 'post-hash', mutate, heldCheck, reason = 'changed-during-move', assertTrace = true }
) {
  const f = buildFixture()
  const r = runC4Candidate({
    candidate: 'C4',
    parentAbs: f.parent,
    name: f.name,
    window,
    onFire: () => mutate(f),
  })
  const res = r.result
  check(`${label} mutation fired without error`, r.onFireInvoked && r.mutationError === null, true)
  check(`${label} status`, res.status, 'held')
  check(`${label} reason`, res.reason, reason)
  if (assertTrace)
    check(`${label} trace matched (held is a valid C4 outcome)`, r.traceMatched, true)
  else
    console.log(
      `${TAG} ${label} trace matched: ${r.traceMatched} (NOT ASSERTED -- see the case's comment)`
    )
  check(`${label} path is inside this run's trash`, insideTrash(res.path, f.parent), true)
  check(`${label} heldPath equals path`, res.heldPath === res.path && res.path !== null, true)
  check(`${label} originPath is the origin`, res.originPath, f.origin)
  check(`${label} the origin is absent (nothing moved back)`, fs.existsSync(f.origin), false)
  if (heldCheck) heldCheck(f, typeof res.path === 'string' ? res.path : '/nonexistent')
  const sidecar = readJson(res.sidecarPath)
  check(`${label} sidecar hold`, sidecar?.hold, true)
  check(`${label} sidecar reason`, sidecar?.reason, reason)
  check(`${label} sidecar originPath`, sidecar?.originPath, f.origin)
  check(`${label} sidecar heldPath`, sidecar?.heldPath, res.path)
  check(`${label} sidecar guardHash is the caller's`, sidecar?.guardHash, r.guardHash)
  check(
    `${label} sidecar postMoveTreeHash is hex or null`,
    sidecar?.postMoveTreeHash === null || HEX64.test(String(sidecar?.postMoveTreeHash)),
    true
  )
  check(`${label} sidecar createdAt`, typeof sidecar?.createdAt, 'string')
  check(`${label} isSuccess(held) is false`, isSuccess(res), false)
  return { f, r, sidecar }
}

// --- R1-R3: post-hash append, chmod, create --------------------------------
{
  const { f, r } = heldCase('R1 append', {
    mutate: (fx) => fs.appendFileSync(path.join(fx.target, 'orig-f1'), '-late'),
    heldCheck: (fx, h) =>
      check(
        'R1 held copy carries the append',
        readText(path.join(h, 'target', 'orig-f1')),
        'original-content-f1-late'
      ),
  })
  // D-8 detail and shape, read off the same held result.
  const res = r.result
  const d = String(res.detail)
  check(
    'D8 detail names the restore command for this op',
    d.includes(`skillsmith restore ${r.opId}`),
    true
  )
  check('D8 detail names where the tree is', d.includes(String(res.path)), true)
  check('D8 detail names the origin', d.includes(f.origin), true)
  check('D8 sidecarPath is beside the held copy', res.sidecarPath, `${res.path}.json`)
  check('D8 opId', res.opId, r.opId)
  check('D8 entry', res.entry, 'tree')
  check('D8 errno is null', res.errno, null)
  check(
    'D8 treeHash is the post-move hash',
    res.treeHash !== null && res.treeHash !== r.guardHash,
    true
  )
  cleanup(f.root)
}
{
  const { f } = heldCase('R2 chmod', {
    mutate: (fx) => fs.chmodSync(path.join(fx.target, 'orig-f1'), 0o600),
    heldCheck: (fx, h) => {
      let mode = 'UNREADABLE'
      try {
        mode = (fs.lstatSync(path.join(h, 'target', 'orig-f1')).mode & 0o777).toString(8)
      } catch {
        /* reported as UNREADABLE */
      }
      check('R2 held copy carries the mode change', mode, '600')
    },
  })
  cleanup(f.root)
}
{
  const { f } = heldCase('R3 create', {
    mutate: (fx) => fs.writeFileSync(path.join(fx.target, 'new-user-file.txt'), 'created-late'),
    heldCheck: (fx, h) =>
      check(
        'R3 held copy carries the new file',
        readText(path.join(h, 'target', 'new-user-file.txt')),
        'created-late'
      ),
  })
  cleanup(f.root)
}

// --- R4: rename-over, symlink retarget, rm+rewrite, A4 directory swap -------
{
  const { f } = heldCase('R4a rename-over', {
    mutate: (fx) => {
      fs.writeFileSync(path.join(fx.target, '.orig-f1.tmp'), 'atomic-save')
      fs.renameSync(path.join(fx.target, '.orig-f1.tmp'), path.join(fx.target, 'orig-f1'))
    },
    heldCheck: (fx, h) =>
      check(
        'R4a held copy carries the save',
        readText(path.join(h, 'target', 'orig-f1')),
        'atomic-save'
      ),
  })
  cleanup(f.root)
}
{
  const { f } = heldCase('R4b symlink retarget', {
    mutate: (fx) => {
      fs.unlinkSync(path.join(fx.origin, 'link'))
      fs.symlinkSync('substituted-link-target', path.join(fx.origin, 'link'))
    },
    heldCheck: (fx, h) => {
      let t = 'UNREADABLE'
      try {
        t = fs.readlinkSync(path.join(h, 'link'))
      } catch {
        /* reported */
      }
      check('R4b held copy carries the retargeted link', t, 'substituted-link-target')
    },
  })
  cleanup(f.root)
}
{
  const { f } = heldCase('R4c rm+rewrite', {
    mutate: (fx) => {
      fs.rmSync(path.join(fx.target, 'orig-f1'))
      fs.writeFileSync(path.join(fx.target, 'orig-f1'), 'rewritten')
    },
    heldCheck: (fx, h) =>
      check(
        'R4c held copy carries the rewrite',
        readText(path.join(h, 'target', 'orig-f1')),
        'rewritten'
      ),
  })
  cleanup(f.root)
}
{
  const { f } = heldCase('R4d A4 directory swap', {
    mutate: (fx) => {
      fs.renameSync(fx.target, `${fx.target}.aside`)
      fs.mkdirSync(fx.target)
      fs.writeFileSync(path.join(fx.target, 'orig-f1'), 'replacement-dir-bytes')
    },
    heldCheck: (fx, h) => {
      check(
        'R4d held copy carries the replacement',
        readText(path.join(h, 'target', 'orig-f1')),
        'replacement-dir-bytes'
      )
      check(
        'R4d and the renamed-aside original',
        readText(path.join(h, 'target.aside', 'orig-f1')),
        'original-content-f1'
      )
    },
  })
  cleanup(f.root)
}

// --- R5: the re-hash cannot read a file -> held, diagnosis kept -------------
{
  // S9's readFileSync inside the destination throws EACCES and the sidecar calls
  // follow it. Coordinator decision (Step 1b part 2): matchC4Trace accepts a
  // thrown READ strictly inside destPath, before the sidecar write, for a
  // held/changed-during-move result only (c4-trace-match.threw.selftest.mjs
  // pins the negatives). So the trace IS asserted here.
  const { f, r } = heldCase('R5 unreadable', {
    mutate: (fx) => fs.chmodSync(path.join(fx.target, 'orig-f1'), 0o000),
  })
  check(
    'R5 detail carries guard-unreadable',
    String(r.result.detail).includes('guard-unreadable'),
    true
  )
  check('R5 treeHash is null (no post-move hash computed)', r.result.treeHash, null)
  cleanup(f.root)
}

// --- R6: whole-tree substitute at the rename -> held, original untouched ----
// The substitute is hash-IDENTICAL, so only S9a's identity check can see it.
{
  let aside = null
  let asideIno = null
  let substituteHash = null
  const { f, r } = heldCase('R6 substitute at rename', {
    window: 'at-rename',
    mutate: (fx) => {
      aside = path.join(fx.root, 'user-original-aside')
      asideIno = fs.lstatSync(fx.origin).ino
      fs.renameSync(fx.origin, aside)
      populate(fx.origin)
      substituteHash = computePathTreeHash(fx.origin).treeHash
    },
  })
  // Premise: if this fails, the case is testing the re-hash (S9d), not identity.
  check('R6 premise: the substitute is hash-identical to the guard', substituteHash, r.guardHash)
  check('R6 detail names identity', String(r.result.detail).includes('identity'), true)
  check(
    'R6 the user original is untouched at its aside path',
    readText(path.join(aside, 'target', 'orig-f1')),
    'original-content-f1'
  )
  check('R6 and it is the same directory object', fs.lstatSync(aside).ino, asideIno)
  cleanup(f.root)
}

// --- S12: a clean guarded move is verified at the destination --------------
{
  const f = buildFixture()
  const r = runC4Candidate({
    candidate: 'C4',
    parentAbs: f.parent,
    name: f.name,
    window: 'pre-call',
    onFire: () => {},
  })
  const res = r.result
  check('S12 a clean guarded call is quarantined', res.status, 'quarantined')
  check('S12 trace matched', r.traceMatched, true)
  const sidecar = readJson(res.sidecarPath)
  check('S12 sidecar postMoveVerified', sidecar?.postMoveVerified, true)
  const now = computePathTreeHash(typeof res.path === 'string' ? res.path : '/nonexistent')
  check(
    'S12 postMoveTreeHash is the hash of the tree now at path',
    sidecar?.postMoveTreeHash,
    now.treeHash
  )
  check(
    'S12 and that equals the guard hash (moved unchanged)',
    sidecar?.postMoveTreeHash,
    r.guardHash
  )
  check('S12 a quarantined sidecar has no hold', sidecar?.hold, undefined)
  check('S12 quarantined result shape carries no heldPath', res.heldPath, null)
  cleanup(f.root)
}

// --- D-8: status and field plumbing -----------------------------------------
check(
  'D8 shapeResult accepts held',
  (() => {
    try {
      return shapeResult({ status: 'held' }).status
    } catch (err) {
      return `threw: ${err.message}`
    }
  })(),
  'held'
)
check('D8 RESULT_FIELDS declares originPath', RESULT_FIELDS.includes('originPath'), true)
check('D8 RESULT_FIELDS declares heldPath', RESULT_FIELDS.includes('heldPath'), true)
check('D8 isSuccess(held) is false', isSuccess({ status: 'held' }), false)
check('D8 isSuccess(quarantined) stays true (control)', isSuccess({ status: 'quarantined' }), true)

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
