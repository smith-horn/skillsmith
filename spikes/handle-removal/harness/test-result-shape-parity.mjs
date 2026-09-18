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
import { removeTree } from '../hybrid.mjs'
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
// R5-7: this compared `keys(shapeResult(...))` against `RESULT_FIELDS` -- BOTH
// SIDES DERIVED FROM THE SAME ARRAY, so deleting a field from `RESULT_FIELDS`
// changed both sides together and the case could never fail. Measured: removing
// `'detail'` left this suite green. A tautology shaped like an assertion, in the
// file whose subject is tests that look like coverage and give none.
//
// The contract is now written out literally. If a field is added, this fails and
// someone decides deliberately whether it belongs in the contract -- which is the
// point of having one.
const CONTRACT_FIELDS = [
  'status',
  'reason',
  'path',
  'entry',
  'treeHash',
  'errno',
  'opId',
  'sidecarPath',
  'detail',
  'fallbackTrigger',
]
check(
  '1a every declared field is present after shaping',
  keys(shapeResult({ status: 'kept' })),
  [...CONTRACT_FIELDS].sort().join(',')
)
check(
  '1a2 and RESULT_FIELDS itself still matches the written contract',
  [...RESULT_FIELDS].sort().join(','),
  [...CONTRACT_FIELDS].sort().join(',')
)
check('1b absent fields are null, never undefined', shapeResult({ status: 'kept' }).reason, null)
// m-6: the pass-through loop used `!(k in out)`, and `in` walks the prototype
// chain -- so an extra key colliding with `Object.prototype` read as already
// present and was SILENTLY DROPPED. Measured: `toString`, `constructor`,
// `valueOf`, `hasOwnProperty`, `isPrototypeOf` all dropped; a control key
// survived. The loop exists to stop silent dropping, and dropped silently.
for (const k of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
  check(
    `1e an extra key named ${k} survives shaping`,
    shapeResult({ status: 'kept', [k]: 'carried' })[k],
    'carried'
  )
}
check(
  '1f and a non-colliding extra still survives (control)',
  shapeResult({ status: 'kept', sidecarError: 'carried' }).sidecarError,
  'carried'
)
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
    // m-5: this still compared against RESULT_FIELDS two cases below the one
    // rewritten to remove that tautology -- so removing a field from the array
    // changed both sides here and 2a stayed green while 1a/1a2 went red. The
    // de-tautologising was applied to the case a reviewer named, not to the
    // pattern. Same per-instance-instead-of-mechanism shape as C-1's own cause.
    check('2a native success key set', keys(nativeOk), [...CONTRACT_FIELDS].sort().join(','))
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

// --- 7. THE ALIAS, ON BOTH PATHS (Finding 10) ----------------------------
//
// Section 6 fixed the alias and tested it. Every one of its six cases called
// `quarantineTree` -- in this file, which imports `removeVR` on line 23. So the
// fix landed in `quarantine.mjs` only, `walk.mjs` neither validated nor read
// `treeHash`, and the commit message claimed "both spellings now normalize"
// while measuring one file. Measured before the fix:
//
//            removeVR (native)        quarantineTree (fallback)
//   WRONG    removed, origin GONE     kept, origin intact
//   null     removed, origin GONE     TypeError
//   both     removed, origin GONE     TypeError
//
// That is the ORIGINAL parameter-name defect with the paths swapped, recreated
// by its own fix. These cases assert the two paths AGREE, which is the only
// formulation that could have caught it -- testing either path alone passes.
{
  const threw = (fn) => {
    try {
      return `ret:${fn().status}`
    } catch (e) {
      return e.constructor.name
    }
  }
  const both = (label, opts, expected) => {
    const a = fixture()
    const nat = (() => {
      try {
        return threw(() => removeVR(a.target, { variant: 'V2', ...opts }))
      } catch {
        return 'SHIM-ABSENT'
      }
    })()
    const natAlive = fs.existsSync(a.target)
    fs.rmSync(a.root, { recursive: true, force: true })

    const b = fixture()
    const fb = threw(() => quarantineTree(b.parent, 'tree', opts))
    const fbAlive = fs.existsSync(b.target)
    fs.rmSync(b.root, { recursive: true, force: true })

    if (nat === 'SHIM-ABSENT') {
      console.log(`[result-parity] ${label} SKIP -- the native shim did not load here`)
      return
    }
    check(`${label} native`, nat, expected)
    check(`${label} fallback`, fb, expected)
    check(`${label} both origins survive`, natAlive && fbAlive, true)
  }

  both('7a treeHash: null refused on', { treeHash: null }, 'TypeError')
  both('7b both spellings differing refused on', { guardHash: 'a', treeHash: 'b' }, 'TypeError')
  // A wrong-but-well-formed alias must REFUSE, not remove. Before the fix the
  // native path removed the tree here.
  both('7c a wrong treeHash keeps the tree on', { treeHash: 'WRONG' }, 'ret:kept')
}

// --- 8. ONE READ, NOT TWO (Finding 14) -----------------------------------
//
// The alias fix validated `options.guardHash` at the entry point and let the
// inner function RE-READ the same property. That is an assertion about a value
// the function does not own. Measured with a getter answering a valid hash on
// read 1 and `null` afterwards: validation passed, the second read resolved to
// no guard, and the tree was moved UNGUARDED.
//
// The property under test is "the value validated is the value used", so the
// case is a getter that changes its answer -- exactly what a hostile or merely
// lazy caller object does.
{
  const a = fixture()
  const realHash = computePathTreeHash(a.target).treeHash
  let reads = 0
  const opts = {
    get guardHash() {
      reads += 1
      return reads === 1 ? realHash : null
    },
  }
  let outcome
  try {
    outcome = `ret:${quarantineTree(a.parent, 'tree', opts).status}`
  } catch (e) {
    outcome = e.constructor.name
  }
  // Whichever way it resolves, it must NOT be "moved with no guard": either the
  // single read saw the real hash and quarantined it under that guard, or it
  // refused. What must never happen is a second read downgrading to no-guard.
  check('8a a value-changing getter cannot downgrade the guard', outcome, 'ret:quarantined')
  fs.rmSync(a.root, { recursive: true, force: true })

  // 8b originally asserted `reads === 1`. It measured 2 -- the object spread
  // that forwards options to the inner function invokes the getter again -- and
  // that assertion was testing the IMPLEMENTATION, not the property. The spread's
  // read is immediately overwritten by the explicit `guardHash:` that follows it,
  // so the value used is still the validated one.
  //
  // The property that actually matters is "the value VALIDATED is the value
  // USED", and the sharp way to test it is a getter whose later reads return a
  // DIFFERENT WELL-FORMED HASH. A wrong-but-valid string cannot be caught by
  // `normalizeGuardHash`; only using the first-read value gives a match. If any
  // later read won, the guard would mismatch and the tree would be kept.
  const b = fixture()
  const bHash = computePathTreeHash(b.target).treeHash
  const decoy = 'f'.repeat(bHash.length)
  let n = 0
  const shifty = {
    get guardHash() {
      n += 1
      return n === 1 ? bHash : decoy
    },
  }
  let r2
  try {
    r2 = `ret:${quarantineTree(b.parent, 'tree', shifty).status}`
  } catch (e) {
    r2 = e.constructor.name
  }
  check('8b the FIRST read is the value enforced, not a later one', r2, 'ret:quarantined')
  // 8c asserted `n > 1` -- "the getter did change its answer, so the case is
  // live" -- and that became FALSE when the fix landed, because a single read is
  // exactly what the fix establishes. An earlier version of this file asserted
  // `reads === 1` and was told off for testing the implementation; the
  // difference is that back then the code legitimately read twice (spread, then
  // an overwriting key) so the count was incidental. Now one read IS the
  // contract: `resolveRemovalOptions` materialises the whole options object once
  // and nothing downstream consults it again, which is what makes
  // "validated equals used" hold for every option rather than for whichever one
  // a reviewer last named. So the count is the property, and a second read
  // reappearing is the regression.
  check('8c the guard property is read exactly once', n, 1)
  fs.rmSync(b.root, { recursive: true, force: true })
}

// --- 9. EVERY option, not just the one that was named (R5-1, R5-2) -------
//
// Sections 7 and 8 fixed `guardHash` on both paths and pinned it. `opId` was
// still validated on reads 1 and 2 and USED from read 3 -- the object spread
// that forwarded options onward. Measured before this fix, with a valid
// `guardHash` and a 0700 landing directory:
//
//   opId getter: 'op-benign', 'op-benign', '../../loot'
//     -> status 'quarantined', origin GONE,
//        user bytes AND the sidecar in <root>/loot/
//
// That is the traversal case 5f already covers for a plain string, reached by a
// value that passes 5f's own check twice on the way in. And `walk.mjs` never
// validated `opId` at all while interpolating it into a directory name -- the
// one-file shape from section 7, inside the commit that fixed the one-file
// shape.
//
// Both were one defect: the fix had been applied per-option instead of to the
// mechanism. These cases assert the mechanism.
{
  const threw = (fn) => {
    try {
      return `ret:${fn().status}`
    } catch (e) {
      return e.constructor.name
    }
  }
  // 9a: a getter cannot smuggle a traversal past validation.
  const a = fixture()
  const aHash = computePathTreeHash(a.target).treeHash
  const loot = path.join(a.root, 'loot')
  fs.mkdirSync(loot)
  fs.chmodSync(loot, 0o700)
  let reads = 0
  const sneaky = {
    guardHash: aHash,
    get opId() {
      reads += 1
      return reads <= 2 ? 'op-benign' : '../../loot'
    },
  }
  const out = threw(() => quarantineTree(a.parent, 'tree', sneaky))
  check('9a a late-changing opId cannot redirect the landing', fs.readdirSync(loot).length, 0)
  check('9b opId is read exactly once', reads, 1)
  check('9c and the call still succeeds on the benign value', out, 'ret:quarantined')
  fs.rmSync(a.root, { recursive: true, force: true })

  // 9d-9f: opId validation is on BOTH paths, not one. Before the fix the native
  // path accepted every one of these.
  for (const [label, bad] of [
    ['traversal', '../../loot'],
    ['dotdot', '..'],
    ['separator', 'a/b'],
  ]) {
    const n = fixture()
    const nat = (() => {
      try {
        return threw(() => removeVR(n.target, { variant: 'V2', opId: bad }))
      } catch {
        return 'SHIM-ABSENT'
      }
    })()
    fs.rmSync(n.root, { recursive: true, force: true })
    const f = fixture()
    const fb = threw(() => quarantineTree(f.parent, 'tree', { opId: bad }))
    fs.rmSync(f.root, { recursive: true, force: true })
    if (nat === 'SHIM-ABSENT') {
      console.log(`[result-parity] 9* ${label} SKIP -- the native shim did not load here`)
      continue
    }
    check(`9 opId ${label}: native refuses`, nat, 'TypeError')
    check(`9 opId ${label}: fallback refuses`, fb, 'TypeError')
  }
}

// --- 10. THE DISPATCHER ITSELF (R5-10) ----------------------------------
//
// This file's header is about `removeTree` -- "hybrid.mjs's removeTree()
// returns whichever path ran, verbatim" -- and every case in it tested
// `removeVR` against `quarantineTree` DIRECTLY. The shipped entry point was
// never compared against itself. Measured: `fallbackTrigger` was added on the
// fallback branch only, so `removeTree` returned 10 keys one way and 9 the
// other. The N-1 defect, on the exact surface N-1 named, surviving the fix
// because the test aimed one layer below it.
//
// `SKILLSMITH_REMOVAL_NATIVE_DISABLE=1` is the only lever that forces the
// branch deterministically, and it is a real shipped lever rather than a stub.
{
  const runBranch = (nativeDisabled) => {
    const f = fixture()
    const prev = process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE
    if (nativeDisabled) process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE = '1'
    else delete process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE
    let out
    try {
      out = removeTree(f.target, {})
    } catch {
      out = null
    } finally {
      if (prev === undefined) delete process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE
      else process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE = prev
      fs.rmSync(f.root, { recursive: true, force: true })
    }
    return out
  }
  const fb = runBranch(true)
  const nat = runBranch(false)
  if (fb === null || nat === null) {
    console.log('[result-parity] 10* SKIP -- a dispatcher branch did not run here')
  } else {
    check(
      '10a fallback branch matches the contract',
      keys(fb),
      [...CONTRACT_FIELDS].sort().join(',')
    )
    check(
      '10b native branch matches the contract',
      keys(nat),
      [...CONTRACT_FIELDS].sort().join(',')
    )
    check('10c and the two branches agree with each other', keys(nat), keys(fb))
    // The trigger must still be reported -- shaping must not erase the thing
    // the field exists for.
    check('10d the fallback still names its trigger', typeof fb.fallbackTrigger, 'string')
    check('10e the native branch reports null, not undefined', nat.fallbackTrigger, null)
  }
}

// --- 11. THE SHAPE OF THE OPTIONS OBJECT, NOT ITS VALUES (C-1) -----------
//
// THE GAP THIS CLOSES IS THE ONE THAT LET A CRITICAL REGRESSION LAND. Every
// case above this one passes an object LITERAL. `grep -rn "Object.create|
// defineProperty|setPrototypeOf" harness/` returned nothing. So when a fix
// replaced direct property reads with `{ ...options }` -- own-enumerable-only --
// nothing noticed that an inherited or non-enumerable `guardHash` had stopped
// being readable, and the drop resolved to `undefined`, which this module
// defines as "no guard, proceed".
//
// Measured before the fix, parent commit vs that commit:
//
//   class R { get guardHash() { return 'WRONG' } }
//     before: kept, origin SURVIVES     after: quarantined, origin GONE
//     native: before kept               after REMOVED, unrecoverable
//   Object.create({ guardHash: null })
//     before: TypeError                 after: quarantined, origin GONE
//
// A fail-closed guard turned fail-open, on both paths, in a commit carrying
// eight suites and an explicit red-test discipline. Neither shape is hostile:
// a class instance with a getter and `Object.create(defaults)` are ordinary.
//
// The author and the reviewer both instinctively write `{ guardHash: x }`, which
// is why this dimension needs its own cases rather than more value cases.
{
  const threw = (fn) => {
    try {
      return `ret:${fn().status}`
    } catch (e) {
      return e.constructor.name
    }
  }
  class WithGetter {
    get guardHash() {
      return 'DELIBERATELY-WRONG'
    }
  }
  const nonEnumerable = () => {
    const o = {}
    Object.defineProperty(o, 'guardHash', { value: 'DELIBERATELY-WRONG', enumerable: false })
    return o
  }
  const shapes = [
    ['class instance, prototype getter', () => new WithGetter(), 'ret:kept'],
    [
      'Object.create with a wrong hash',
      () => Object.create({ guardHash: 'DELIBERATELY-WRONG' }),
      'ret:kept',
    ],
    ['Object.create with null', () => Object.create({ guardHash: null }), 'TypeError'],
    ['non-enumerable own property', nonEnumerable, 'ret:kept'],
    ['plain literal (control)', () => ({ guardHash: 'DELIBERATELY-WRONG' }), 'ret:kept'],
  ]
  for (const [label, make, expected] of shapes) {
    const a = fixture()
    const fb = threw(() => quarantineTree(a.parent, 'tree', make()))
    const fbAlive = fs.existsSync(a.target)
    fs.rmSync(a.root, { recursive: true, force: true })

    const b = fixture()
    const opts = make()
    opts.variant = 'V2'
    const nat = (() => {
      try {
        return threw(() => removeVR(b.target, opts))
      } catch {
        return 'SHIM-ABSENT'
      }
    })()
    const natAlive = fs.existsSync(b.target)
    fs.rmSync(b.root, { recursive: true, force: true })

    check(`11 ${label}: fallback`, fb, expected)
    check(`11 ${label}: fallback preserved the tree`, fbAlive, true)
    if (nat === 'SHIM-ABSENT') continue
    check(`11 ${label}: native`, nat, expected)
    check(`11 ${label}: native preserved the tree`, natAlive, true)
  }

  // And a guard supplied through a prototype must still WORK when correct --
  // otherwise this section passes by refusing every non-literal, which is the
  // refuse-everything failure mode each negative control here exists to catch.
  const good = fixture()
  const goodHash = computePathTreeHash(good.target).treeHash
  const viaProto = Object.create({ guardHash: goodHash })
  check(
    '11 a CORRECT hash via the prototype still quarantines',
    quarantineTree(good.parent, 'tree', viaProto).status,
    'quarantined'
  )
  fs.rmSync(good.root, { recursive: true, force: true })
}

if (!allOk) {
  console.error('[result-parity] FAIL')
  process.exit(1)
}
console.log('[result-parity] all cases passed')
process.exit(0)
