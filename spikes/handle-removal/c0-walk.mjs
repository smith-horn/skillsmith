// SMI-6676 C0: the control candidate -- "the A1 design as of UD25" (plan §4.6).
//
// PROVENANCE (corrected, checkpoint 1 follow-up): checkpoint 1 searched only
// `git log --all --full-history` and concluded exp8/e53.mjs and e54.mjs "do
// not exist"; that search covered git history, not the session scratchpad
// they actually lived in, and the conclusion was wrong. The coordinator
// committed them to this branch at `spikes/handle-removal/reference-
// experiments/` (c27b4abc3). This module is a direct, structural port of
// their walk()/gate() logic -- not a from-spec reconstruction, and not just
// their formulas grafted onto a different shape. See
// `reference-experiments/e53.mjs` and `e54.mjs`, and their README.
//
// Two structural corrections versus checkpoint 1's own rebuild:
//
// 1. No full-tree pre-bind. e53/e54 bind only the TOP directory's identity
//    before descending; every other directory's "known identity" is
//    discovered LAZILY, the moment its parent lists it -- not from an
//    upfront recursive stat of the whole tree. This matters: a full pre-bind
//    would give C0 more protection than the ported source actually has (it
//    would catch some of A6's "before-the-walk, inner directory" cases that
//    the real mechanism does not), and the plan is explicit that C0 is the
//    baseline the other candidates must beat, not itself hardened further.
//
// 2. The gate is a THRESHOLD, not a per-entry birthtime comparison, and it
//    is established using the filesystem's OWN clock, never `Date.now()`.
//    Checkpoint 1's "watermark" variant compared a V8 Date.now() sample
//    against filesystem-reported birthtimeMs and measured the two
//    disagreeing by about 1ms in this environment -- mixing clock sources is
//    wrong by construction, not merely a worse option, and that measurement
//    is why.
//
// The ported mechanism, precisely:
//
//   Identity is the combined tuple (dev, ino, birthtimeNs) -- ONE value, via
//   `fs.lstatSync(p, {bigint:true})` for nanosecond precision.
//
//   The threshold is established once, via two filesystem probes taken
//   back-to-back in the tree's own parent directory (mkdir immediately
//   followed by rmdir, each timed against the same clock): probe 1, then
//   probe 2, retried (1ms sleeps, up to 100ms) until probe 2's birthtimeNs is
//   OBSERVABLY later than probe 1's -- this adapts to whatever timestamp
//   granularity the filesystem actually has, rather than assuming one. The
//   threshold is probe 2's birthtimeNs. Every directory the walk visits must
//   have birthtimeNs STRICTLY LESS than the threshold, checked before its
//   identity is even compared; failing this stops `identity-unverifiable`.
//
//   `gateTiming` controls when the threshold is established, and the plan's
//   two phrases about the gate ("before bind" in §4.6, "at walk start" in
//   the attack table) turn out to name two different, directly-measured
//   configurations, not one ambiguous mechanism:
//     - 'before-bind': fixed before the top directory's own identity is even
//       bound. Measured (e54.mjs, this session, overlayfs, n=300): 0/300
//       loss, for both the walked directory itself and an inner directory,
//       regardless of same-tick inode/birthtime reuse (`sharedInoAndBirth: 0`
//       in both cases) -- anything created during the operation necessarily
//       has a birthtimeNs at or after a threshold fixed before the operation
//       started. This is what "C0 as of UD25" means, and this module's
//       default.
//     - 'walk-start': established after bind, right before the removal pass.
//       Measured: WORSE than no gate at all for a before-the-walk swap
//       (203/300 and 300/300 loss vs 178/300 and 300/300 for no gate) -- a
//       threshold fixed after the corruption already happened cannot
//       retroactively prove the corrupted state is new. This is the plan's
//       own attack-table control for A6, kept here so that residual stays
//       reproducible, not as a candidate.
//     - 'none': no threshold; UD24 identity checking only. Measured: fails
//       whenever the race achieves real inode+birthtime reuse (93-188/300
//       across repeated runs on overlayfs).
//
//   UD21's rmdir-first probe (distinguishing empty / non-empty / mount
//   before anything destructive) and a mount-stop-by-device check are kept
//   from checkpoint 1's build -- e53/e54 don't test mounts (that's a
//   separate e42* experiment set, and A1/A2 are a later checkpoint), but the
//   plan's §3 semantics table requires UD21 of every candidate regardless.

import fs from 'node:fs'
import path from 'node:path'

function L(p) {
  return fs.lstatSync(p, { bigint: true })
}

function idOf(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The two-probe threshold technique from e53.mjs/e54.mjs's `gate()`/inline
 * equivalent. Returns { threshold, unverifiable, waited }.
 */
export function establishThreshold(probeParentDir) {
  const mk = (n) => {
    const p = path.join(probeParentDir, `.skillsmith-probe-op1-${n}`)
    fs.mkdirSync(p)
    const b = L(p).birthtimeNs
    fs.rmdirSync(p)
    return b
  }
  const p1 = mk(1)
  if (p1 === 0n) return { threshold: null, unverifiable: true, waited: 0 }
  let p2 = mk(2)
  const deadline = Date.now() + 100
  let waited = 0
  while (p2 <= p1 && Date.now() < deadline) {
    sleep(1)
    waited += 1
    p2 = mk(2)
  }
  if (p2 <= p1) return { threshold: null, unverifiable: true, waited }
  return { threshold: p2, unverifiable: false, waited }
}

/**
 * Removes `targetRoot` per the ported C0 algorithm.
 *
 * @param {string} targetRoot - absolute path to the top of the tree
 * @param {object} [options]
 * @param {boolean} [options.identityCheck=true] - UD24. false reproduces the
 *   pre-UD24 baseline (only the UD21 rmdir-probe/mount-stop applies) --
 *   still used for A3/A4, which are about UD24 itself, not the gate.
 * @param {'none'|'before-bind'|'walk-start'} [options.gateTiming='before-bind']
 *   - see the module comment. 'before-bind' is the ported, measured-0/300
 *   candidate; 'walk-start' and 'none' are kept to reproduce the plan's own
 *   attack-table controls.
 * @param {Record<string, Function>} [options.hooks] - beforeBind(),
 *   betweenBindAndWalk(), afterProbe(relPath, probeResult),
 *   afterListing(relPath, entries), beforeUnlink(relPath) [fired right
 *   before a FILE's fs.unlinkSync -- directories go through afterProbe/
 *   check() instead, which already have their own hook points].
 * @returns {{status:'removed'}|{status:'stopped', reason:string, path:string, errno:string|null}}
 */
export function removeC0(targetRoot, options = {}) {
  const { identityCheck = true, gateTiming = 'before-bind', hooks = {} } = options
  const callHook = (name, ...args) => {
    if (typeof hooks[name] === 'function') hooks[name](...args)
  }

  let threshold = null
  if (gateTiming === 'before-bind') {
    const g = establishThreshold(path.dirname(targetRoot))
    if (g.unverifiable) {
      return { status: 'stopped', reason: 'identity-unverifiable', path: '', errno: null }
    }
    threshold = g.threshold
  }

  callHook('beforeBind')

  // The only upfront "bind" is the top directory's own identity -- matching
  // e53/e54 exactly. Everything else is discovered lazily, in walkDir(),
  // the moment a parent lists it.
  let boundId
  try {
    boundId = identityCheck ? idOf(L(targetRoot)) : null
  } catch (err) {
    return { status: 'stopped', reason: 'entry-removed', path: '', errno: err.code ?? null }
  }

  // betweenBindAndWalk fires BEFORE a 'walk-start' threshold is established,
  // matching e54.mjs's own order for that variant: the attack's mutation
  // lands first, and the gate is (too late) established after it -- which is
  // exactly why 'walk-start' measures worse than no gate at all for a
  // before-the-walk swap (see the module comment).
  callHook('betweenBindAndWalk')

  if (gateTiming === 'walk-start') {
    const g = establishThreshold(path.dirname(targetRoot))
    if (g.unverifiable) {
      return { status: 'stopped', reason: 'identity-unverifiable', path: '', errno: null }
    }
    threshold = g.threshold
  }

  const rootDev = (() => {
    try {
      return L(targetRoot).dev
    } catch {
      return null
    }
  })()

  /** @type {{reason:string, path:string, errno:string|null}|null} */
  let stopped = null

  function walkDir(relPath, absPath, knownId) {
    if (stopped) return

    let st
    try {
      st = L(absPath)
    } catch (err) {
      stopped = { reason: 'entry-removed', path: relPath, errno: err.code ?? null }
      return
    }

    // Threshold, then identity -- the ported source's own order.
    if (threshold !== null && !(st.birthtimeNs < threshold)) {
      stopped = { reason: 'identity-unverifiable', path: relPath, errno: null }
      return
    }
    if (identityCheck && knownId && knownId !== idOf(st)) {
      stopped = { reason: 'identity-changed', path: relPath, errno: null }
      return
    }
    if (rootDev !== null && st.dev !== rootDev) {
      stopped = { reason: 'mount-inside', path: relPath, errno: null }
      return
    }

    const id = idOf(st)
    let probeResult
    try {
      fs.rmdirSync(absPath)
      probeResult = 'removed-empty'
    } catch (err) {
      probeResult = err.code ?? 'unknown'
    }
    callHook('afterProbe', relPath, probeResult)

    if (probeResult === 'removed-empty') {
      return // already empty; nothing more to do here
    }
    if (probeResult === 'EBUSY') {
      stopped = { reason: 'mount-inside', path: relPath, errno: 'EBUSY' }
      return
    }
    if (probeResult !== 'ENOTEMPTY' && probeResult !== 'EEXIST') {
      stopped = { reason: 'entry-removed', path: relPath, errno: probeResult }
      return
    }

    // check(): re-verifies the PARENT directory's own identity before every
    // descendant action, matching e53/e54's `check()` exactly (identity
    // only -- no threshold re-check here; the threshold applies once, at
    // walkDir()'s own entry, the same placement as the ported source).
    const check = () => {
      if (stopped) return false
      let cur
      try {
        cur = L(absPath)
      } catch (err) {
        stopped = { reason: 'entry-removed', path: relPath, errno: err.code ?? null }
        return false
      }
      if (identityCheck && idOf(cur) !== id) {
        stopped = { reason: 'identity-changed', path: relPath, errno: null }
        return false
      }
      return true
    }

    let entries
    try {
      entries = fs.readdirSync(absPath).sort()
    } catch (err) {
      stopped = { reason: 'entry-removed', path: relPath, errno: err.code ?? null }
      return
    }
    callHook('afterListing', relPath, entries)
    if (!check()) return

    for (const name of entries) {
      if (stopped) return
      if (!check()) return
      const childRel = relPath ? path.posix.join(relPath, name) : name
      const childAbs = path.join(absPath, name)
      let childSt
      try {
        childSt = L(childAbs)
      } catch (err) {
        stopped = { reason: 'entry-removed', path: childRel, errno: err.code ?? null }
        return
      }
      if (childSt.isDirectory()) {
        // The child's "known identity" is discovered right here, lazily --
        // not from an earlier full-tree bind. See the module's provenance
        // note: this is the structural fix, not just the formula.
        walkDir(childRel, childAbs, identityCheck ? idOf(childSt) : null)
        if (stopped) return
      } else {
        if (!check()) return
        callHook('beforeUnlink', childRel)
        try {
          fs.unlinkSync(childAbs)
        } catch (err) {
          stopped = { reason: 'removal-failed', path: childRel, errno: err.code ?? null }
          return
        }
      }
    }
    if (!check()) return

    try {
      fs.rmdirSync(absPath)
    } catch (err) {
      stopped = { reason: 'removal-failed', path: relPath, errno: err.code ?? null }
    }
  }

  walkDir('', targetRoot, boundId)

  if (stopped) {
    return { status: 'stopped', ...stopped }
  }
  return { status: 'removed' }
}
