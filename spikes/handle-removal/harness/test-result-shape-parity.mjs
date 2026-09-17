#!/usr/bin/env node
// SMI-6676 N-1: the two removal paths must return ONE shape.
//
// `hybrid.mjs`'s removeTree() returns whichever path ran, verbatim. Which path
// runs depends on an env var, a child-process probe and the platform -- none of
// which the caller can see. So before this test the contract varied by runtime
// condition:
//
//   kept     native {status, treeHash}            fallback {status, reason, path, treeHash}
//   success  native {status:'removed', treeHash}  fallback {status:'quarantined', path, sidecarPath, opId}
//
// A caller switching on `result.reason` got `undefined` from the native path,
// and the fallback's SUCCESS carried no `treeHash` at all -- the field the A1
// plan's UD14/UD15/UD17 require before authorizing a removal. The owner's
// 2026-09-17 decision ships the fallback, so that was the missing field on the
// path that ships.
//
// These cases compare KEY SETS, not values: the paths legitimately report
// different statuses ('removed' vs 'quarantined') and different hashes. What
// must not differ is which fields exist, because that is what a caller writes
// its branching against.

import { removeVR } from '../walk.mjs'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { RESULT_FIELDS, shapeResult, isSuccess } from '../result-shape.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[result-parity] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const keys = (o) => Object.keys(o).sort().join(',')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6676-parity-'))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(path.join(parent, 'tree', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(parent, 'tree', 'sub', 'f.txt'), 'bytes')
  return { root, parent, target: path.join(parent, 'tree') }
}

// --- 1. the contract itself ----------------------------------------------
check(
  '1a every declared field is present after shaping',
  keys(shapeResult({ status: 'kept' })),
  [...RESULT_FIELDS].sort().join(',')
)
check('1b absent fields are null, never undefined', shapeResult({ status: 'kept' }).reason, null)
check(
  '1c an unknown status is refused',
  (() => {
    try {
      shapeResult({ status: 'vanished' })
      return 'accepted'
    } catch {
      return 'threw'
    }
  })(),
  'threw'
)
check(
  '1d both successes are recognised as success',
  isSuccess({ status: 'removed' }) && isSuccess({ status: 'quarantined' }),
  true
)

// --- 2. SUCCESS: same fields from both paths ------------------------------
// Revert (unwrap either entry point): the key sets diverge and this fails.
{
  const a = fixture()
  const nativeOk = (() => {
    try {
      return removeVR(a.target, { variant: 'V2' })
    } catch {
      return null
    }
  })()
  fs.rmSync(a.root, { recursive: true, force: true })

  const b = fixture()
  const guardHash = computePathTreeHash(b.target).treeHash
  const fallback = quarantineTree(b.parent, 'tree', { guardHash })
  fs.rmSync(b.root, { recursive: true, force: true })

  if (nativeOk === null) {
    console.log('[result-parity] 2* SKIP -- the native shim did not load here')
  } else {
    check('2a native success key set', keys(nativeOk), [...RESULT_FIELDS].sort().join(','))
    check('2b fallback success key set matches native', keys(fallback), keys(nativeOk))
    check('2c both report success', isSuccess(nativeOk) && isSuccess(fallback), true)
    // The field the A1 plan needs, on the path that ships.
    check('2d fallback success carries a treeHash', typeof fallback.treeHash, 'string')
    check('2e native success carries a treeHash', typeof nativeOk.treeHash, 'string')
  }
}

// --- 3. KEPT: same fields from both paths ---------------------------------
{
  const a = fixture()
  const nativeKept = (() => {
    try {
      return removeVR(a.target, { variant: 'V2', guardHash: 'deliberately-wrong' })
    } catch {
      return null
    }
  })()
  const nativeSurvived = fs.existsSync(a.target)
  fs.rmSync(a.root, { recursive: true, force: true })

  const b = fixture()
  const fbKept = quarantineTree(b.parent, 'tree', { guardHash: 'deliberately-wrong' })
  const fbSurvived = fs.existsSync(b.target)
  fs.rmSync(b.root, { recursive: true, force: true })

  check('3a fallback kept', fbKept.status, 'kept')
  check('3b fallback kept left the tree alone', fbSurvived, true)
  if (nativeKept === null) {
    console.log('[result-parity] 3* SKIP -- the native shim did not load here')
  } else {
    check('3c native kept', nativeKept.status, 'kept')
    check('3d native kept left the tree alone', nativeSurvived, true)
    check('3e kept key sets match', keys(fbKept), keys(nativeKept))
    // The specific divergence N-1 reported: native `kept` had no `reason`.
    check('3f native kept exposes reason', 'reason' in nativeKept, true)
    check('3g native kept exposes path', 'path' in nativeKept, true)
  }
}

// --- 3b. the SECOND success return: sidecar write failed -----------------
// A sidecar failure after the rename is still a success -- nothing was lost --
// so it must carry the same fields. It did not: the catch branch returned
// without `treeHash` or `entry`, and shapeResult filled both with null, which
// is worse than absent because null means "nothing was verified" and a hash had
// just been verified. Found only because a mis-aimed revert exposed that there
// were TWO quarantined returns, not one. Forced by making the sidecar path
// unwritable after the op directory exists.
{
  const b = fixture()
  const guardHash = computePathTreeHash(b.target).treeHash
  // Forced by stubbing fs.writeFileSync for the sidecar's `.json` path only, so
  // the rename(2) that quarantines the tree still really happens and only the
  // sidecar write fails -- which is the actual ENOSPC shape this branch exists
  // for. A chmod on the trash root would have been the obvious lever and is
  // wrong here: it would also block the op-directory mkdir, so the function
  // would fail before reaching the branch under test, and the case would pass
  // for the wrong reason. The stub is restored in a finally.
  const r = (() => {
    const orig = fs.writeFileSync
    fs.writeFileSync = (p, ...rest) => {
      if (String(p).endsWith('.json')) {
        const e = new Error('forced')
        e.code = 'ENOSPC'
        throw e
      }
      return orig(p, ...rest)
    }
    try {
      return quarantineTree(b.parent, 'tree', { guardHash })
    } finally {
      fs.writeFileSync = orig
    }
  })()
  check('3h sidecar-failure is still a success', r.status, 'quarantined')
  check('3i and it reports the sidecar problem', typeof r.sidecarError, 'string')
  check('3j and it STILL carries the verified treeHash', r.treeHash, guardHash)
  check('3k and it still names the entry', r.entry, 'tree')
  fs.rmSync(b.root, { recursive: true, force: true })
}

// --- 4. a caller can branch without knowing which path answered -----------
// This is the property the whole issue is about, stated as one assertion.
{
  const b = fixture()
  const guardHash = computePathTreeHash(b.target).treeHash
  const r = quarantineTree(b.parent, 'tree', { guardHash })
  const canBranch = 'status' in r && 'reason' in r && 'path' in r && 'treeHash' in r && 'errno' in r
  check('4a every field a caller branches on is present', canBranch, true)
  fs.rmSync(b.root, { recursive: true, force: true })
}

// --- 5. THE INPUT SIDE OF THE CONTRACT (Findings 4 and 6) ----------------
//
// N-1 made the RETURN shapes agree and the parameter-rename fix made the input
// NAME agree. The input SEMANTICS were still divergent, which is the third
// instance of one class. Measured before the fix, same call, same fixture:
//
//   native   removeVR(t, { guardHash: null })   -> kept,        origin PRESERVED
//   fallback quarantineTree(...{ guardHash: null }) -> quarantined, origin MOVED
//
// A caller writing `guardHash: maybeHash() ?? null` got a destructive removal
// on one path and a refusal on the other, decided by an env var and a probe it
// cannot see. Neither reading was adopted: `null` is now a loud error, because
// a caller passing it has not said which they meant, and guessing at missing
// evidence is the defect this spike documents.
//
// `grep -rn 'guardHash: null' harness/` returned NOTHING before these cases --
// the one input value that meant different things on the two paths was the one
// value neither suite passed.
{
  const threw = (fn) => {
    try {
      fn()
      return 'returned'
    } catch (e) {
      return e.constructor.name
    }
  }
  const a = fixture()
  check(
    '5a native refuses guardHash: null',
    threw(() => removeVR(a.target, { guardHash: null })),
    'TypeError'
  )
  check('5b and the origin survives', fs.existsSync(a.target), true)
  fs.rmSync(a.root, { recursive: true, force: true })

  const b = fixture()
  check(
    '5c fallback refuses guardHash: null',
    threw(() => quarantineTree(b.parent, 'tree', { guardHash: null })),
    'TypeError'
  )
  check('5d and the origin survives', fs.existsSync(b.target), true)
  fs.rmSync(b.root, { recursive: true, force: true })

  // Omission still means "no guard" -- the fix must not make the guard
  // mandatory, or it passes by refusing everything.
  const c = fixture()
  check(
    '5e omitting guardHash still quarantines',
    quarantineTree(c.parent, 'tree', {}).status,
    'quarantined'
  )
  fs.rmSync(c.root, { recursive: true, force: true })

  // Finding 6: opId and name are joined into a path and must be single
  // segments. Measured before the fix: opId '../../OUTSIDE/pwned' quarantined
  // OUTSIDE .skillsmith-trash entirely and reported success.
  // THE LANDING DIRECTORY IS PRE-CREATED, and that detail is the whole case.
  // A traversal to a NON-existent path ('../../OUTSIDE/pwned') is blocked
  // anyway by mkdirSync(opDir, { recursive: false }) failing ENOENT -- so a
  // test using it passes even with the validation removed, for a reason
  // unrelated to the fix. Measured with validation removed and the directory
  // pre-created, which is what a concurrent process can trivially arrange:
  //
  //   opId '../../loot' -> status quarantined, origin GONE,
  //                        user bytes at loot/tree-<rnd>/sub/f.txt
  const d = fixture()
  const loot = path.join(d.root, 'loot')
  fs.mkdirSync(loot, { recursive: true })
  check(
    '5f opId traversal is refused',
    threw(() => quarantineTree(d.parent, 'tree', { opId: '../../loot' })),
    'TypeError'
  )
  check('5g nothing landed in the attacker directory', fs.readdirSync(loot).length, 0)
  check('5h and the origin survives', fs.existsSync(d.target), true)
  fs.rmSync(d.root, { recursive: true, force: true })

  const e = fixture()
  check(
    '5i name traversal is refused',
    threw(() => quarantineTree(e.parent, '../escape', {})),
    'TypeError'
  )
  fs.rmSync(e.root, { recursive: true, force: true })
}

// --- 6. THE ALIAS (Finding 8) -------------------------------------------
//
// Case 5 above pinned `guardHash: null`. It pinned ONE SPELLING, and the
// function read two: `quarantineTreeInner` resolved
// `options.guardHash ?? options.treeHash`, while the entry point validated only
// `options.guardHash`. So the whole of case 5 was reachable around by using the
// deprecated alias. Measured before the fix, same fixture:
//
//   quarantineTree(p, n, { guardHash: null })  -> TypeError, origin PRESERVED
//   quarantineTree(p, n, { treeHash:  null })  -> quarantined, origin MOVED
//
// I wrote case 5 and I wrote the fix it pins, and I tested the spelling I had
// just fixed. That is SMI-6497's rule landing on its author: the author picks
// the mutation, so the author's blind spot picks it too. A cross-family
// reviewer named the alias within minutes of reading the same file.
{
  const threw = (fn) => {
    try {
      fn()
      return 'returned'
    } catch (e) {
      return e.constructor.name
    }
  }
  const a = fixture()
  check(
    '6a the deprecated treeHash alias refuses null too',
    threw(() => quarantineTree(a.parent, 'tree', { treeHash: null })),
    'TypeError'
  )
  check('6b and the origin survives', fs.existsSync(a.target), true)
  fs.rmSync(a.root, { recursive: true, force: true })

  // The fix must not make the alias unusable -- that would pass by refusing
  // everything, the failure mode case 5e exists to catch on the other spelling.
  const b = fixture()
  const bHash = computePathTreeHash(b.target).treeHash
  check(
    '6c a VALID treeHash still quarantines',
    quarantineTree(b.parent, 'tree', { treeHash: bHash }).status,
    'quarantined'
  )
  fs.rmSync(b.root, { recursive: true, force: true })

  // Both spellings with DIFFERENT values is ambiguous, and `??` precedence
  // would silently resolve it on the destructive path.
  const c = fixture()
  const cHash = computePathTreeHash(c.target).treeHash
  check(
    '6d both spellings, same value, accepted',
    quarantineTree(c.parent, 'tree', { guardHash: cHash, treeHash: cHash }).status,
    'quarantined'
  )
  fs.rmSync(c.root, { recursive: true, force: true })

  const d = fixture()
  const dHash = computePathTreeHash(d.target).treeHash
  check(
    '6e both spellings, different values, refused rather than resolved',
    threw(() => quarantineTree(d.parent, 'tree', { guardHash: dHash, treeHash: 'other' })),
    'TypeError'
  )
  check('6f and the origin survives', fs.existsSync(d.target), true)
  fs.rmSync(d.root, { recursive: true, force: true })
}

if (!allOk) {
  console.error('[result-parity] FAIL')
  process.exit(1)
}
console.log('[result-parity] all cases passed')
process.exit(0)
