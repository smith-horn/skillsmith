// SMI-6676 C4: quarantine by rename, delete only by explicit prune (§4.4).
//
// Pure JS, no native shim dependency -- C4 is the FALLBACK for when native
// is unavailable, so it must work with nothing but `node:fs`. Where D1 asks
// for an extra Linux mnt_id check, that's attempted only if a native shim
// happens to already be loaded (best-effort precision), never required.
//
// D1 (owner, 2026-09-15), implemented exactly:
//   - path: <parent>/.skillsmith-trash/<opId>/<name>-<rnd>/, sidecar
//     <parent>/.skillsmith-trash/<opId>/<name>-<rnd>.json beside it.
//   - .skillsmith-trash is validated before use: must be a real directory
//     (not a symlink), same device (and mnt_id, when checkable) as the
//     parent. A .skillsmith-trash that fails this is never used.
//   - If the sibling rename fails for ANY reason (EXDEV, EACCES, EROFS,
//     EBUSY, ENOSPC, or anything else): nothing moves, nothing is deleted.
//     Stops `quarantine-failed`, reports path/entry/errno, and the tree is
//     left exactly where it was -- never a consolation delete, never a walk
//     up to a different parent.

import fs from 'node:fs'
import { shapeResult, resolveRemovalOptions, assertPathSegment } from './result-shape.mjs'
import path from 'node:path'
import crypto from 'node:crypto'
import { computeTreeHash } from './hash.mjs'

/**
 * Whether POSIX ownership/permission semantics apply to a directory mode here.
 * M-1: gated on `process.platform`, which is always defined, rather than on
 * `typeof process.getuid === 'function'` -- a writable property whose removal
 * silently disabled BOTH F12 checks and left no trace in the result.
 */
const POSIX_PERM_CHECKS = process.platform !== 'win32' && typeof process.getuid === 'function'
/**
 * Our own uid, captured once at load. Reading it per-call let a deleted
 * `process.getuid` throw INSIDE the checked block, which the enclosing catch
 * turned into `quarantine-failed` with `detail: null` -- fail-closed, which is
 * the right direction, but undiagnosable and for the wrong reason. Captured
 * here, the check cannot throw and cannot be switched off after load.
 */
const SELF_UID = POSIX_PERM_CHECKS ? BigInt(process.getuid()) : null

const SPIKE_VERSION = 'smi-6676-spike-c4-prototype'

function randSuffix() {
  return crypto.randomBytes(4).toString('hex')
}

/**
 * Builds a §3.4 tree-hash record from a PATH walk, in the same shape
 * `guardPass()` builds from held handles, so `computeTreeHash()` -- the same
 * function, imported, not reimplemented -- yields the identical digest for
 * the identical tree. That equality is what lets ONE `guardHash` value from a
 * caller be checked on either path; `harness/test-guard-hash-parity.mjs`
 * measures it rather than assuming it.
 *
 * This walk is path-based and therefore inherently TOCTOU-prone -- it is the
 * FALLBACK, which runs precisely when no native shim is available to hold
 * handles. It closes the pre-aged-substitute class (something that was already
 * sitting under the target's name before the call). It does NOT close the
 * concurrent-race class the way VR's held-fd guard pass does, and must not be
 * described as if it did.
 *
 * @returns {{ok:true, record:Map}|{ok:false, reason:string, path:string, errno:string|null}}
 */
function pathTreeRecord(absRoot) {
  const record = new Map()
  function visit(rel, abs) {
    let st
    try {
      st = fs.lstatSync(abs, { bigint: true })
    } catch (err) {
      return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
    }
    const mode = Number(st.mode)
    const size = st.size
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size })
      let names
      try {
        names = fs.readdirSync(abs).sort()
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      for (const name of names) {
        const r = visit(rel ? `${rel}/${name}` : name, path.join(abs, name))
        if (r && r.ok === false) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      try {
        record.set(rel, { type: 'symlink', mode, size, linkText: fs.readlinkSync(abs) })
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      return null
    }
    if (st.isFile()) {
      let buf
      try {
        buf = fs.readFileSync(abs)
      } catch (err) {
        return { ok: false, reason: 'guard-unreadable', path: abs, errno: err.code ?? null }
      }
      record.set(rel, {
        type: 'file',
        mode,
        size,
        contentHash: crypto.createHash('sha256').update(buf).digest('hex'),
      })
      return null
    }
    return { ok: false, reason: 'guard-unsupported-type', path: abs, errno: null }
  }
  const failure = visit('', absRoot)
  if (failure) return failure
  return { ok: true, record }
}

/**
 * The fallback path's verify-before-act step.
 *
 * Exported so `harness/test-guard-hash-parity.mjs` can measure that this and
 * `removeVR`'s guard pass agree, which is the whole premise of a caller
 * passing one `guardHash` to `removeTree()` without knowing which path will
 * run.
 */
export function computePathTreeHash(absRoot) {
  const r = pathTreeRecord(absRoot)
  if (!r.ok) return r
  return { ok: true, treeHash: computeTreeHash(r.record) }
}

function treeBytes(absPath) {
  let total = 0
  const st = fs.lstatSync(absPath)
  if (st.isSymbolicLink() || st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  for (const name of fs.readdirSync(absPath)) {
    total += treeBytes(path.join(absPath, name))
  }
  return total
}

/**
 * Validates (and if absent, creates) `<parentAbs>/.skillsmith-trash` per D1.
 * Never follows a symlink at that name, never uses a mount point there.
 *
 * @returns {{ok:true, trashRoot:string}|{ok:false, reason:string, errno:string|null}}
 */
function ensureTrashRoot(parentAbs, nativeShim) {
  const trashRoot = path.join(parentAbs, '.skillsmith-trash')
  let parentStat
  try {
    parentStat = fs.statSync(parentAbs)
  } catch (err) {
    return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
  }

  try {
    fs.mkdirSync(trashRoot, { mode: parentStat.mode & 0o777 })
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
    }
  }

  let trashLstat
  try {
    trashLstat = fs.lstatSync(trashRoot)
  } catch (err) {
    return { ok: false, reason: 'quarantine-failed', errno: err.code ?? null }
  }
  // D1's own words: "The caller stops with reason quarantine-failed" -- one
  // reason code covers every way the sibling rename can't be trusted,
  // including .skillsmith-trash itself being unusable (symlink or a
  // different mount) caught here, before rename is even attempted. `detail`
  // carries the specific diagnosis without diverging from the spec's single
  // outward reason string (caught during this checkpoint: an earlier draft
  // used its own reason codes here instead of D1's literal one).
  if (trashLstat.isSymbolicLink() || !trashLstat.isDirectory()) {
    return { ok: false, reason: 'quarantine-failed', detail: 'trash-unusable', errno: null }
  }
  if (trashLstat.dev !== parentStat.dev) {
    return { ok: false, reason: 'quarantine-failed', detail: 'trash-other-mount', errno: null }
  }
  if (nativeShim) {
    // EVERY openDir() HERE MUST BE CLOSED, INCLUDING ON THE RETURN PATH.
    //
    // This read `statAt(openDir(parentAbs).fd, '.')` on both lines and discarded
    // each handle, leaking two descriptors per call. Three things hid it: the
    // spike's dispatcher never passes `options.nativeShim`, so it does not fire
    // today; the `catch` below swallows any failure silently; and M2's held-fd
    // audit was scoped to walk.mjs. D1 asks for this mnt_id check, so wiring it
    // as specified is what activates the leak -- in the file Option C ships.
    //
    // The early `return` inside the comparison is the part worth noticing: a
    // try/finally is required, not just a close at the end, because the
    // mismatch branch leaves before any trailing cleanup would run.
    let pDir = null
    let tDir = null
    try {
      pDir = nativeShim.openDir(parentAbs)
      tDir = nativeShim.openDir(trashRoot)
      if (pDir.errno === 0 && tDir.errno === 0) {
        const pStat = nativeShim.statAt(pDir.fd, '.')
        const tStat = nativeShim.statAt(tDir.fd, '.')
        if (pStat.mntId !== undefined && tStat.mntId !== undefined && pStat.mntId !== tStat.mntId) {
          return {
            ok: false,
            reason: 'quarantine-failed',
            detail: 'trash-other-mount-mntid',
            errno: null,
          }
        }
      }
    } catch {
      // Best-effort only -- a native probe failure here does not block C4,
      // since C4 must work with no native shim at all.
    } finally {
      // Closed inline rather than via a shared helper: walk.mjs's closeQuiet()
      // is local to that module and takes a bare fd, while these are shim
      // handles. Importing it would couple C4 to the native walk, which is the
      // opposite of what C4 is for -- it must work with no shim at all.
      for (const d of [pDir, tDir]) {
        if (d && d.errno === 0) {
          try {
            nativeShim.closeFd(d.fd)
          } catch {
            // A close failure cannot be acted on and must not mask the result.
          }
        }
      }
    }
  }

  // FINDING 3: return the trash root's IDENTITY, not just its path. Everything
  // below trusts this value across mkdirSync(opDir), randSuffix(), an lstat and
  // renameSync without rebinding it -- so the source got a bound identity
  // re-checked immediately before the destructive step and the DESTINATION got
  // none, under the identical threat model ("anything that can write to the
  // parent"). Returning it here is what lets the caller close that asymmetry.
  let trashIdentity = null
  try {
    const ts = fs.lstatSync(trashRoot, { bigint: true })
    trashIdentity = { dev: ts.dev, ino: ts.ino, birthtimeNs: ts.birthtimeNs }
  } catch {
    return { ok: false, reason: 'quarantine-failed', detail: 'trash-unusable', errno: null }
  }
  // parentStat comes from statSync() WITHOUT bigint, so its `dev` is a Number
  // while every lstat below uses { bigint: true } and yields a BigInt. `!==`
  // across those two types is ALWAYS true, so an unconverted comparison rejects
  // every legitimate call -- which is exactly what it did: 2a, 3d and 5g all
  // flipped to `stopped` the first time this shipped. Normalize here, once.
  return { ok: true, trashRoot, trashIdentity, parentDev: BigInt(parentStat.dev) }
}

/**
 * @param {string} parentAbs - the directory that held the tree
 * @param {string} name - the tree's own basename (never a path)
 * @param {object} [options]
 * @param {string} [options.opId]
 * @param {string} [options.kind]
 * @param {string} [options.client]
 * @param {string} [options.rootKey]
 * @param {string} [options.guardHash] - if given, the tree's own hash,
 *   recomputed here, must equal this or nothing is moved and the call returns
 *   `kept`. SAME OPTION NAME as `removeVR`'s, deliberately: `removeTree()`
 *   forwards its options verbatim to whichever path runs, and while this one
 *   read `options.treeHash` instead, a caller doing exactly what the decision
 *   memo's condition (1) requires -- pass a guardHash to removeTree() -- was
 *   silently UNGUARDED on the fallback path, and the hash was dropped into the
 *   sidecar as `null`. Reproduced before the fix: `removeTree(target, {
 *   guardHash: 'DELIBERATELY-WRONG-HASH' })` with SKILLSMITH_REMOVAL_NATIVE_
 *   DISABLE=1 returned `{"status":"quarantined"}`, the original path was gone,
 *   and `sidecar.treeHash` was `null`. `harness/test-guard-hash-parity.mjs`
 *   is the behavioural acceptance test that now pins it on BOTH paths.
 * @param {string} [options.treeHash] - deprecated alias for `guardHash`,
 *   accepted only so an older caller is not silently ignored; it is treated
 *   as a guard hash, not as inert sidecar metadata.
 * @param {object} [options.nativeShim] - optional, for the extra mnt_id check only
 * @returns {{status:'quarantined', path:string, sidecarPath:string, opId:string}
 *          |{status:'kept', reason:string, path:string, treeHash:string}
 *          |{status:'stopped', reason:string, path:string, entry:string, errno:string|null}}
 */
function quarantineTreeInner(parentAbs, name, options = {}) {
  const opId = options.opId ?? randSuffix()
  const originPath = path.join(parentAbs, name)

  // Verify BEFORE anything moves. `rename(2)` is the destructive step here --
  // once the tree is in the trash directory under a random name, a caller
  // that expected `kept` has already lost the thing it was protecting.
  // Already resolved and validated by `quarantineTree` and passed in; the `??`
  // that used to be here was the second read F14 exploited.
  const guardHash = options.guardHash
  let observedTreeHash = null
  // B2: THIS FUNCTION VERIFIED ONE TREE AND MOVED ANOTHER.
  //
  // `computePathTreeHash(originPath)` walks by path; `renameSync(originPath, ...)`
  // resolves that path again, independently. Between them, anything that can
  // write to `parentAbs` can swap what the name refers to -- so the caller's
  // guard hash certified tree X while `rename(2)` moved tree Y into quarantine,
  // and the guard bought nothing. That is the spike's own subject, in the
  // spike's own fallback.
  //
  // FIXED BY APPLYING THE A1 PLAN'S MECHANISM RATHER THAN INVENTING A SECOND ONE.
  // UD24 (owner decision 2026-09-15) binds a directory's identity as
  // (dev, ino, birthtimeNs) from a bigint lstat and re-compares it immediately
  // before each destructive step. UD25 adds the clock gate that makes the
  // comparison sound: E47 measured overlayfs handing back the SAME inode AND
  // birthtime in 1703 of 2000 immediate delete-recreate pairs, so identity alone
  // is forgeable on a same-tick replacement (E53: 224 of 300 emptied).
  //
  // `expectIdentity` lets a caller bind the identity EARLIER than this function
  // can -- UD24 requires the walked directory to match the identity its caller
  // bound, not one this function invents after the fact. `maxBirthtimeNs` is
  // probe 2's birthtime from UD25's gate; the gate itself belongs to the caller
  // (§3.8), because it must run before the caller's own guard.
  const bindIdentity = (p) => {
    try {
      const st = fs.lstatSync(p, { bigint: true })
      return { ok: true, dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
    } catch (err) {
      return { ok: false, errno: err.code ?? null }
    }
  }
  const sameIdentity = (a, b) =>
    a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs

  let boundIdentity = options.expectIdentity ?? null

  // IDENTITY AND THE CLOCK GATE RUN INDEPENDENTLY OF THE HASH.
  //
  // They used to sit INSIDE `if (guardHash != null)`, which made both silently
  // inert for a caller that supplied `expectIdentity` and `maxBirthtimeNs` but
  // no hash. That caller is not hypothetical — it is the shape this function's
  // own comment describes, since `expectIdentity` exists precisely so a caller
  // can bind identity independently of the hash. Measured, one process, same
  // fixture, only `guardHash` differing:
  //
  //   WITH guardHash      kept / identity-not-older-than-probe, tree preserved
  //   WITHOUT guardHash   quarantined, tree moved
  //
  // No error, no field, no difference in the result shape — a silent-success
  // defect inside the fix written to remove a silent-success defect, which is
  // exactly what CLAUDE.md predicts of any race-shaped fix. The existing suite
  // could not see it because every case passed a guardHash.
  //
  // PRECISELY WHICH HALF WAS INERT, because the distinction matters and an
  // earlier draft of this comment got it wrong. Measured by reverting the hoist
  // and re-running each half separately:
  //
  //   the CLOCK GATE       genuinely inert — a same-tick replacement passed
  //   `expectIdentity`     NOT inert — the pre-rename re-check still caught it
  //                        (`kept / identity-changed`), because boundIdentity is
  //                        assigned outside this block and that check reads it
  //
  // So the exposure was narrower than "both are dead" and is still real: UD25's
  // gate is the only thing standing between a forged same-inode, same-birthtime
  // replacement and the rename, and it was the half that did not run.
  const needIdentity =
    boundIdentity !== null ||
    (options.maxBirthtimeNs !== undefined && options.maxBirthtimeNs !== null) ||
    (guardHash !== undefined && guardHash !== null)

  if (needIdentity) {
    const before = bindIdentity(originPath)
    if (!before.ok) {
      return {
        status: 'stopped',
        reason: 'quarantine-failed',
        path: originPath,
        entry: name,
        errno: before.errno,
      }
    }
    // A caller-bound identity wins; otherwise bind it here, before the walk.
    if (boundIdentity && !sameIdentity(boundIdentity, before)) {
      return { status: 'kept', reason: 'identity-changed', path: originPath, treeHash: null }
    }
    boundIdentity = boundIdentity ?? before

    // UD25's gate: a directory that existed before the gate ran is strictly
    // older than probe 2. A same-tick replacement is not.
    if (
      options.maxBirthtimeNs !== undefined &&
      options.maxBirthtimeNs !== null &&
      !(boundIdentity.birthtimeNs < options.maxBirthtimeNs)
    ) {
      return {
        status: 'kept',
        reason: 'identity-not-older-than-probe',
        path: originPath,
        treeHash: null,
      }
    }
  }

  // The hash comparison stays conditional on a hash being supplied — that part
  // was always correct, and is the only half that genuinely needs one.
  if (guardHash !== undefined && guardHash !== null) {
    const h = computePathTreeHash(originPath)
    if (!h.ok) {
      return { status: 'stopped', reason: h.reason, path: h.path, entry: name, errno: h.errno }
    }
    observedTreeHash = h.treeHash
    if (h.treeHash !== guardHash) {
      return { status: 'kept', reason: 'identity-changed', path: originPath, treeHash: h.treeHash }
    }
  }

  const trash = ensureTrashRoot(parentAbs, options.nativeShim)
  if (!trash.ok) {
    return {
      status: 'stopped',
      reason: trash.reason,
      path: parentAbs,
      entry: name,
      errno: trash.errno,
      // F13: this rebuilt the result and dropped `detail`, so a trash-unusable
      // stop reached the caller with the diagnosis missing while the comment
      // above claimed `detail` carried it.
      detail: trash.detail ?? null,
    }
  }

  const opDir = path.join(trash.trashRoot, opId)
  try {
    fs.mkdirSync(opDir, { mode: 0o700, recursive: false })
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return {
        status: 'stopped',
        reason: 'quarantine-failed',
        path: opDir,
        entry: name,
        errno: err.code ?? null,
      }
    }
  }

  // FINDING 3, part 2: the op directory was created and then trusted. lstat it
  // and require the parent's device -- a destination on another device would
  // make the rename either fail with EXDEV or, worse, land somewhere the
  // returned path does not describe.
  //
  // FINDING 9 (governance review of ADR-166, 2026-09-17): THE DEVICE CHECK WAS
  // THE ONLY CHECK, AND A SYMLINK PASSES IT.
  //
  // `mkdirSync` above accepts EEXIST, so a process that can write to the parent
  // -- this mechanism's own stated threat model -- pre-creates
  // `<trash>/<opId>` as a SYMLINK to a directory it controls on the same
  // device. `lstat` then reports the symlink's own dev, which matches, and the
  // check passes. `renameSync` resolves the symlink at syscall time. Measured
  // before this fix, with a VALID guardHash in place:
  //
  //   status: 'quarantined'   (success)
  //   origin: gone
  //   reported path: <trash>/op-abc123/tree-c61e2beb
  //   ACTUAL bytes: <attacker-storage>/tree-c61e2beb/sub/f.txt
  //   ...and the sidecar, carrying originPath and treeHash, landed there too.
  //
  // The guard hash does not help: it binds the SOURCE identity, and this
  // substitutes the DESTINATION. That is `0abee8e93` -- "hardened the source of
  // the rename and left the destination trusted under the identical threat
  // model" -- reproduced exactly one directory level down, because that fix
  // rebound the trash root and never rebound the op directory inside it.
  //
  // `assertPathSegment` cannot catch this: `op-abc123` is a legal single
  // segment. The defect is the directory's TYPE, not the name's shape.
  //
  // F13: these refusals are `kept`, not `stopped`. Nothing moved and nothing was
  // deleted -- a check declined to proceed, which is exactly D-8's definition of
  // `kept`, and it is what the trash-root rebind below already returns for the
  // same class of problem. The first version of this fix returned `stopped`,
  // giving ONE reason string TWO statuses depending on which end changed.
  //
  // F12: the type check is not enough either. `mkdirSync`'s `mode: 0o700` above
  // is a REQUEST, discarded when EEXIST is accepted, so a pre-created 0777 op
  // directory passes. Measured: origin gone, tree and sidecar -- which carry
  // `originPath` and `treeHash` -- sitting in a directory any local user can
  // read or rename away. Ownership and mode are now required.
  let opIdentity = null
  try {
    const od = fs.lstatSync(opDir, { bigint: true })
    if (od.isSymbolicLink() || !od.isDirectory()) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        entry: name,
        treeHash: observedTreeHash,
        errno: null,
        detail: od.isSymbolicLink()
          ? 'op directory is a symlink; rename(2) would resolve it and land the tree elsewhere'
          : 'op directory exists but is not a directory',
      }
    }
    if (trash.parentDev !== undefined && od.dev !== trash.parentDev) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        entry: name,
        treeHash: observedTreeHash,
        errno: null,
        detail: 'op directory is on a different device than the parent',
      }
    }
    // F12: ours, and not writable by anyone else.
    // M-1: this guarded on `typeof process.getuid === 'function'`, and
    // `process.getuid` is a WRITABLE property -- this suite's own case 7p stubs
    // it. Measured: deleting it made a 0777 op directory ACCEPTED, with no field
    // saying a check had been skipped. Gating on `process.platform` instead is
    // not spoof-proof either, but it is always defined, so absence cannot
    // silently disable the check; and the skip is now recorded rather than
    // indistinguishable from a pass.
    if (POSIX_PERM_CHECKS && od.uid !== SELF_UID) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        entry: name,
        treeHash: observedTreeHash,
        errno: null,
        detail: 'op directory is owned by another user',
      }
    }
    // R5-9: the uid check above is guarded by `typeof process.getuid === 'function'`
    // and this one was not. `process.getuid` is POSIX-only, and Windows reports
    // directory modes that do not carry POSIX permission semantics -- measured
    // against the three plausible shapes (0o40777, 0o40666, 0o40555), ALL of
    // them fail this mask, which would make every call on Windows return
    // `kept` and render the fallback path inert. One guard, both checks.
    if (POSIX_PERM_CHECKS && (od.mode & 0o077n) !== 0n) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        entry: name,
        treeHash: observedTreeHash,
        errno: null,
        detail: `op directory is group- or world-accessible (mode ${(od.mode & 0o777n).toString(8)})`,
      }
    }
    // F11: BIND IT. Validating once and trusting it across randSuffix() and two
    // further lstats is precisely the mistake the source rebind below exists to
    // correct, and a real concurrent race won it 6 times in 65,211 trials.
    opIdentity = { ok: true, dev: od.dev, ino: od.ino, birthtimeNs: od.birthtimeNs }
  } catch (err) {
    return {
      status: 'stopped',
      reason: 'quarantine-failed',
      path: opDir,
      entry: name,
      errno: err.code ?? null,
    }
  }

  const rnd = randSuffix()
  const destName = `${name}-${rnd}`
  const destPath = path.join(opDir, destName)

  // R5-4: THE DESTINATION RE-CHECKS RUN BEFORE THE SOURCE ONE, DELIBERATELY.
  // They used to run after it, which put two extra lstats between the source
  // re-check and rename(2) and measurably widened the window that check exists
  // to narrow: source-rebind-to-rename median 2,125 ns before the op rebind was
  // added, 3,833 ns after (n=300 each). Ordering the destination checks first
  // restores the source window. It is a TRADE, not a free win, and the previous
  // wording ("costs nothing") was an unmeasured harm claim of exactly the shape
  // retracted two blocks below. Both numbers, n=400 each:
  //
  //   source-compare -> rename   3,542 ns  ->  125 ns   (28x shorter)
  //   op-rebind      -> rename      42 ns  ->  1,916 ns (45x longer)
  //
  // Whether that is net-better depends on which end is cheaper to attack, and
  // nobody has measured that. The source end is the one carrying the documented
  // residual and the one whose substitution is unrecoverable, so it gets the
  // shorter window -- a reasoned choice, stated as one rather than as a result.

  // FINDING 3, part 3: THE DESTINATION GETS THE SAME RE-CHECK AS THE SOURCE.
  // Symmetry is the whole point -- the earlier fix hardened one end of a
  // rename(2) and left the other end validated once, far upstream, and trusted
  // across four intervening operations.
  if (trash.trashIdentity) {
    const trashNow = bindIdentity(trash.trashRoot)
    if (!trashNow.ok || !sameIdentity(trash.trashIdentity, trashNow)) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        treeHash: observedTreeHash,
        // R5-8: this was the one destination refusal of six with no `detail`,
        // so a caller could not tell a trash-root swap from the five diagnosed
        // cases. That is the exact defect the `detail` work was meant to remove,
        // reduced from three-of-five to one-of-six rather than closed.
        detail: 'trash root was substituted between validation and rename',
      }
    }
  }

  // F11: AND THE OP DIRECTORY, which is the rename's actual destination parent.
  // The rebind above covers `.skillsmith-trash` and stops one level short of the
  // directory the tree actually lands in. Replacing an ENTRY inside a directory
  // leaves that directory's own (dev, ino, birthtimeNs) byte-identical, so the
  // trash rebind provably cannot see an op-directory swap; it needs its own.
  //
  // WHAT THIS DOES NOT DO, MEASURED. The commit that added it said "now rebound
  // immediately before rename(2), like the source", which reads as closure. It
  // is not. A/B against a continuing racer, same harness, same machine, back to
  // back: bytes reached attacker storage in 205/71,416 trials WITH this rebind
  // and 221/73,635 WITHOUT (z=0.46, p~0.65 -- indistinguishable). What it
  // changes is the REPORTED OUTCOME, converting a noisy ENOENT from rename(2)
  // into a clean `kept` with a reason: 37,703 -> 22,278 `kept`, 33,437 ->
  // 51,075 `stopped`.
  //
  // The reason it cannot close the race is the same one the source residual
  // below gives: a gap remains between this lstat and rename(2), and anything
  // that can hit it could hit the pre-fix gap too.
  //
  // M-2: THE FIGURE THAT USED TO SIT HERE WAS 167 ns, AND R5-4's OWN REORDER
  // INVALIDATED IT. That number was measured when this rebind ran LAST; the
  // reorder moved it above the source re-check, so an entire lstat-and-compare
  // now separates it from rename(2). Re-measured in the shipped order, n=400:
  // op-rebind -> rename is 1,916 ns median (p95 3,625), source-compare ->
  // rename is 125 ns median (p95 209). A stale measured claim, inside the
  // comment block rewritten to be honest about measurement -- which is why
  // every remaining nanosecond figure in this file should be treated as
  // unverified until re-run. Closing it needs renameat(2) against a held handle, which Node 22 does
  // not expose -- the reason this spike exists.
  //
  // It is kept because a diagnosable refusal beats an opaque ENOENT and it costs
  // one lstat, NOT because it makes the operation safe against a live attacker.
  if (opIdentity) {
    const opNow = bindIdentity(opDir)
    if (!opNow.ok || !sameIdentity(opIdentity, opNow)) {
      return {
        status: 'kept',
        reason: 'quarantine-destination-changed',
        path: originPath,
        treeHash: observedTreeHash,
        detail: 'op directory was substituted between validation and rename',
      }
    }
  }

  // THE RE-CHECK THAT ACTUALLY CLOSES B2, IMMEDIATELY BEFORE THE DESTRUCTIVE
  // STEP. Everything above verified the tree; between that verification and
  // this line the function created a trash root and an op directory, both of
  // which touch the filesystem and take time. Re-comparing here is UD24's rule:
  // the identity is checked immediately before each destructive step, not once
  // at the top.
  //
  // RESIDUAL, STATED RATHER THAN IMPLIED: a window remains between this lstat
  // and the rename(2) below, and it cannot be closed in this design, because
  // closing it needs renameat(2) against a held directory handle and Node 22's
  // fs has no renameat -- which is the reason this spike exists at all. UD25's
  // WHAT THE CLOCK GATE ACTUALLY BUYS, corrected 2026-09-17. An earlier version
  // of this comment — written the same day, by me — said the gate means the
  // same-tick forge E47 measured on overlayfs "is rejected even when
  // dev/ino/birthtime all match."
  //
  // THAT IS FALSE, and it is false by the gate's own predicate. The gate tests
  // `boundIdentity.birthtimeNs < maxBirthtimeNs`, evaluated ONCE, against the
  // identity bound before the walk. If a substitute matches all three fields
  // then its birthtime equals the original's BY STIPULATION, so the predicate
  // returns whatever it returned for the original — which was "pass". A
  // predicate over a field that is stipulated equal cannot discriminate. The
  // gate never sees the substitute's birthtime at all.
  //
  // What it does buy: it rejects a substitute planted BEFORE this call whose
  // birthtime is fresh — the pre-aged-substitute class, where the thing sitting
  // under the target's name was created after the caller's probe ran. That is
  // real and it is why UD25 exists. It adds nothing in the one case UD24's
  // identity check also fails, which is overlayfs recycling inode and birthtime
  // together — exactly the case E47 was run to measure.
  //
  // So the honest residual is larger than the old comment implied: against a
  // filesystem that recycles both fields, neither the identity check nor the
  // gate discriminates, and the window below is open. Recorded here rather than
  // softened, because a comment asserting an invariant the code beneath it does
  // not deliver is the precise defect this spike exists to document — and this
  // one was mine, found by the gate review reasoning from the predicate rather
  // than from the prose.
  if (boundIdentity) {
    const atRename = bindIdentity(originPath)
    if (!atRename.ok) {
      return {
        status: 'stopped',
        reason: 'quarantine-failed',
        path: originPath,
        entry: name,
        errno: atRename.errno,
      }
    }
    if (!sameIdentity(boundIdentity, atRename)) {
      return {
        status: 'kept',
        reason: 'identity-changed',
        // M-5: the `detail` audit was scoped to one reason code and stopped
        // there. Measured: a caller passing a wrong `expectIdentity` (a benign
        // programming error) and a successfully-detected live attack on the
        // rename window returned BYTE-IDENTICAL objects. That is this spike's
        // central threat detection, indistinguishable from a typo.
        detail: 'bound identity does not match the tree now at this path',
        path: originPath,
        treeHash: observedTreeHash,
      }
    }
  }

  try {
    fs.renameSync(originPath, destPath)
  } catch (err) {
    // rename(2) is atomic: on any failure here, nothing moved. originPath
    // is untouched. Never fall back to a delete, never retarget elsewhere.
    return {
      status: 'stopped',
      reason: 'quarantine-failed',
      path: originPath,
      entry: name,
      errno: err.code ?? null,
    }
  }

  // The tree is already safely quarantined at this point -- rename(2)
  // succeeded, nothing was lost. A failure computing bytes or writing the
  // sidecar (e.g. ENOSPC, found during this checkpoint's own ENOSPC test:
  // the tmpfs had just enough room for the rename but not the sidecar) must
  // never escape as an uncaught exception or attempt anything destructive
  // in response -- it's reported as a quarantined result with the sidecar
  // problem named, not retried, not treated as though nothing happened.
  const sidecarPath = `${destPath}.json`
  try {
    const bytes = treeBytes(destPath)
    const sidecar = {
      opId,
      kind: options.kind ?? 'unspecified',
      client: options.client ?? 'spike',
      rootKey: options.rootKey ?? null,
      originPath,
      // The hash this call actually VERIFIED, not one handed in and never
      // checked. `null` now means "no guard hash was supplied", which is a
      // different and honest claim from the old `null`, which meant "a hash
      // may have been supplied under a name nothing read".
      treeHash: observedTreeHash,
      bytes,
      createdAt: new Date().toISOString(),
      skillsmithVersion: SPIKE_VERSION,
    }
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2))
  } catch (err) {
    // THE SECOND SUCCESS RETURN, AND IT HAD THE SAME GAP AS THE FIRST.
    // A sidecar write can fail (ENOSPC, found during this checkpoint's own
    // ENOSPC test) after the tree is already safely quarantined. That is still
    // a success -- nothing was lost -- so it must carry the same fields as the
    // success below. It did not: no `treeHash`, no `entry`. `shapeResult` would
    // fill both with null, which is worse than absent, because null here means
    // "nothing was verified" and a hash HAD just been verified.
    return {
      status: 'quarantined',
      path: destPath,
      entry: name,
      treeHash: observedTreeHash,
      sidecarPath,
      opId,
      sidecarError: err.code ?? err.message,
    }
  }

  // `treeHash` is the hash this call VERIFIED, or null when the caller supplied
  // no guard hash and nothing was verified. It is not "the hash of whatever is
  // now in quarantine" -- reporting that would be a confident label for a
  // quantity nobody checked. Null here means unverified, and the A1 plan's
  // UD14/UD15/UD17 require a non-null value before a removal is authorized.
  return {
    status: 'quarantined',
    path: destPath,
    entry: name,
    treeHash: observedTreeHash,
    sidecarPath,
    opId,
  }
}

// m-7: the local `assertPathSegment` was superseded by the shared one in
// result-shape.mjs and left behind, renamed but not deleted -- zero references,
// carrying a 12-line comment that read as live policy. Deleted.

export function quarantineTree(parentAbs, name, options = {}) {
  // FINDING 8 (governance review of ADR-166, 2026-09-17): THE FIX FOR
  // `guardHash: null` VALIDATED ONE SPELLING AND THE FUNCTION READ TWO.
  //
  // This line used to be `normalizeGuardHash(options.guardHash)`, while
  // `quarantineTreeInner` resolved `options.guardHash ?? options.treeHash`. So
  // the alias was never validated, and the entire `87dc4038d` fix was reachable
  // around. Measured before this fix, same fixture:
  //
  //   quarantineTree(p, n, { guardHash: null })  -> TypeError, origin PRESERVED
  //   quarantineTree(p, n, { treeHash:  null })  -> quarantined, origin MOVED
  //
  // `treeHash` is the OLD parameter name, kept as a compatibility alias when the
  // rename landed. Keeping an unvalidated second spelling of a guarded input is
  // the same defect the rename was fixing, one identifier over -- and my own
  // test suite missed it because I wrote the tests and I tested the spelling I
  // had just fixed. That is SMI-6497's rule exactly: the author picks the
  // mutation, so the author's blind spot picks it too.
  //
  // Both spellings are now normalized. Supplying BOTH with different values is
  // refused rather than silently resolved by `??` precedence: a caller that
  // passed two different hashes has not said which it meant, and guessing at
  // missing evidence is the defect class this whole spike documents.
  // F10/F14: this logic now lives in ONE place that BOTH removal paths call
  // (`walk.mjs` did not call the previous in-file version at all), and the
  // resolved value is passed DOWN rather than re-read from `options` -- a
  // second read is a second chance for a getter to answer differently.
  // R5-1: the previous version resolved `guardHash` once and left `opId`
  // validated on reads 1-2 while the SPREAD below supplied read 3 -- the value
  // actually used. `resolveRemovalOptions` materialises every property once and
  // validates the snapshot, so "validated equals used" holds for every option,
  // not just the one a reviewer happened to name.
  assertPathSegment('name', name)
  const resolved = resolveRemovalOptions(options)
  const r = quarantineTreeInner(parentAbs, name, resolved)
  return shapeResult({ entry: name, ...r })
}
