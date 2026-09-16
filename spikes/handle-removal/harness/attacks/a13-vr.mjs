// A13 against VR: the same real concurrent racer as a13.mjs (see its header
// for the rendezvous mechanism and why it's needed), removeVR in place of
// removeC0. Runs per cell: 300.
//
// NOTE, and it is load-bearing for how this cell's numbers may be read:
// `removeVR` is called here with NO `guardHash` unless `guardMode:
// 'guardHash'` is passed, and the main A13 runner (run-a3-a13-attacks.mjs)
// does not pass it. That is defensible -- the plan's own control for this row
// is "C0 without UD24", i.e. the unguarded configuration -- but it means the
// A13 cells in results/SUMMARY.md measure a configuration the decision memo's
// own recommendation FORBIDS (a mandatory caller-supplied guard hash). An A13
// loss under guard=none is therefore not evidence about the recommended
// configuration. The guard=guardHash arm below is, and
// harness/measure-a13-race-timing.mjs runs it.
//
// TIMING INSTRUMENT (added when a review asked how a remaining V2 loss could
// be attributed to a mechanism rather than explained by one). The racer
// reports the absolute time its mutation LANDED; the two hooks below report
// when the guard pass started and ended, on the same clock. That places every
// landed mutation in one of three phases -- before the guard pass, during it,
// or after it -- which is the difference between "no earlier observation
// existed" (pre/during: the guard hashed the attacker's own content, and only
// a caller-supplied guardHash could have caught it) and "the re-verify V2
// exists to do did not fire" (post: a genuine V2 gap). See
// harness/measure-a13-race-timing.mjs for the runner that consumes it.
//
// THREE INSTRUMENTS LIVE HERE NOW, AND THEY DO NOT MEAN THE SAME THING.
// Every record carries all three; none replaces another.
//
//  1. `timing.phase`   -- classifyPhase(), the ORIGINAL per-pass label.
//     RETAINED UNCHANGED although it is known to be wrong (see
//     classifyPhase's own header), because records already written carry it
//     and a relabelled field cannot be compared against them. Do not quote it
//     without quoting `timing.passPhase` beside it. (An earlier version of
//     this comment justified the retention with a specific record count. It
//     was wrong -- it had reused the corpus TOTAL rather than the number
//     carrying this field -- and it began rotting the moment it was written,
//     since every run changes it. The reason to retain the field does not
//     depend on how many records carry it.)
//  2. `timing.passPhase` -- classifyPassPhase(), the CORRECTED per-pass label.
//     Same inputs, same clock, fixed branch order; it is a pure function of
//     fields the old records already carry, so it can be recomputed WITHOUT
//     re-running -- but only for records that actually carry `extra.timing`.
//     A large share of A13 records do not (notably the `a3-a13-attacks-*`
//     files, which are the ones behind results/SUMMARY.md's A13 cells), so
//     "recomputable over the whole corpus" is false: check for the field
//     rather than assuming it, and report the denominator you actually had.
//  3. `timing.entryPhase` -- classifyEntryPhase(), the PER-ENTRY label. Uses
//     per-entry guard timestamps that older records do NOT carry, so it
//     cannot be back-applied: it only exists for runs made after this change.
//     This is the only one of the three that can say whether the substituted
//     content was visible to the guard pass FOR THE ENTRY THE RACER ACTUALLY
//     TARGETED, which is what a "genuine post-guard V2 gap" claim needs.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSwapFixture, spawnConcurrentRacer } from './_shared.mjs'
import fs, { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const id = 'A13-VR'
export const target = 300

/**
 * Places a landed mutation relative to the guard pass, on one clock.
 *
 * KNOWN-DEFECTIVE, RETAINED FOR COMPARABILITY ONLY -- use classifyPassPhase()
 * for any new claim. The `straddles-guard-start` branch below tests
 * `mutationStartedAt` alone and never looks at where `landedAt` fell, so it
 * swallows during-guard, straddles-guard-end, post-guard AND post-call
 * landings whenever the racer's mutation began before the parent reached
 * afterBind -- which is most of the time. Measured over the 1,800 A13-TIMING
 * guard-none records that existed when this was found: of the 371 losses, 314
 * carried the `straddles-guard-start` label while their `landedAt` actually
 * fell in three different windows. Branch order alone decided the label, and
 * the most confident label came first.
 *
 * The mutation is an interval (`mutationStartedAt` .. `landedAt`), not an
 * instant, so a mutation that begins before the guard pass ends and completes
 * after it is reported as `straddles-guard-end` rather than forced into one
 * side -- an ambiguous case named is worth more than a confident wrong one.
 *
 * - `pre-guard`      -- landed before the guard pass began. The guard pass
 *                       hashed the attacker's own content; nothing short of a
 *                       caller-supplied guardHash could detect it.
 * - `during-guard`   -- landed while the guard pass was running. Whether the
 *                       guard saw the original or the substitute depends on
 *                       readdir order, so this is the same "no earlier
 *                       observation" class, not a distinct mechanism.
 * - `post-guard`     -- landed after the guard pass finished, i.e. inside the
 *                       window V2's per-entry re-verification exists to close.
 *                       A LOSS here is a genuine V2 gap, not a residual.
 * - `post-call`      -- landed after removeVR() returned; it raced nothing.
 */
export function classifyPhase({
  guardStartedAt,
  guardEndedAt,
  callEndedAt,
  mutationStartedAt,
  landedAt,
}) {
  if (landedAt == null || guardStartedAt == null || guardEndedAt == null) return 'unknown'
  if (landedAt <= guardStartedAt) return 'pre-guard'
  if (mutationStartedAt != null && mutationStartedAt < guardStartedAt)
    return 'straddles-guard-start'
  if (landedAt <= guardEndedAt) return 'during-guard'
  if (mutationStartedAt != null && mutationStartedAt <= guardEndedAt) return 'straddles-guard-end'
  if (callEndedAt != null && landedAt > callEndedAt) return 'post-call'
  return 'post-guard'
}

/**
 * The corrected per-pass classifier.
 *
 * BRANCH ORDER, stated because getting it wrong is what broke classifyPhase:
 * `landedAt` alone decides WHICH window the mutation finished in, first and
 * unconditionally. `mutationStartedAt` is consulted only afterwards, and only
 * ever to WIDEN the ambiguity of that window -- it can never move a landing
 * into a different window. That is the invariant classifyPhase violates.
 *
 * A mutation spanning BOTH guard boundaries is strictly more ambiguous than
 * one spanning only the end -- the guard pass was running for the whole of it,
 * so nothing about the pass-level timestamps constrains what it saw -- and so
 * it gets its own, more-ambiguous label rather than the less-ambiguous one the
 * old order handed it.
 *
 * - `pre-guard`             -- landed before the pass began.
 * - `during-guard`          -- began and landed inside the pass.
 * - `straddles-guard-start` -- began before the pass, landed inside it.
 * - `post-guard`            -- began AND landed after the pass, inside the
 *                              call. The only unambiguous per-pass evidence of
 *                              a post-guard landing; a LOSS here is a genuine
 *                              V2 gap.
 * - `straddles-guard-end`   -- began inside the pass, landed after it but
 *                              inside the call. Ambiguous.
 * - `straddles-guard-span`  -- began before the pass AND landed after it.
 *                              MOST ambiguous: the pass ran entirely inside
 *                              the mutation.
 * - `straddles-call-end`    -- landed after removeVR() returned, but some of
 *                              the mutation overlapped the call.
 * - `post-call`             -- began and landed after the call. Raced nothing.
 */
export function classifyPassPhase({
  guardStartedAt,
  guardEndedAt,
  callEndedAt,
  mutationStartedAt,
  landedAt,
}) {
  if (landedAt == null || guardStartedAt == null || guardEndedAt == null) return 'unknown'

  // Window first, from landedAt alone.
  if (landedAt <= guardStartedAt) return 'pre-guard'

  // Every label below this point distinguishes two cases by WHERE the mutation
  // began, so a null start cannot pick between them. The original code let
  // `mutationStartedAt != null && ...` collapse to false and then returned the
  // CONFIDENT side of each pair -- `during-guard`, `post-call`, `post-guard` --
  // which is the exact inversion of this function's stated invariant that an
  // unknown start may only ever WIDEN ambiguity. `pre-guard` above is kept
  // because it is decided by `landedAt` alone and needs no start.
  if (mutationStartedAt == null) return 'unknown'

  const startsBeforeGuard = mutationStartedAt < guardStartedAt

  if (landedAt <= guardEndedAt) {
    return startsBeforeGuard ? 'straddles-guard-start' : 'during-guard'
  }

  if (callEndedAt != null && landedAt > callEndedAt) {
    return mutationStartedAt <= callEndedAt ? 'straddles-call-end' : 'post-call'
  }

  // Without callEndedAt the landing cannot be placed inside or outside the
  // call, so the window below is not established. Saying `post-guard` here
  // would claim a genuine V2 gap on unmeasured data.
  if (callEndedAt == null) return 'unknown'

  // guardEndedAt < landedAt <= callEndedAt -- the window a post-guard V2 gap
  // would have to live in.
  if (startsBeforeGuard) return 'straddles-guard-span'
  if (mutationStartedAt <= guardEndedAt) return 'straddles-guard-end'
  return 'post-guard'
}

/**
 * The per-ENTRY classifier: was the racer's substituted content visible to the
 * guard pass for THE ENTRY THE RACER TARGETED?
 *
 * The pass-level pair (guardStartedAt, guardEndedAt) cannot answer this. The
 * pass observes entries one at a time; a mutation landing after `target` was
 * pinned but before `zzz-sibling/f1` was hashed is post-guard FOR `target`
 * while the pass as a whole is still running. hash.mjs's afterOpen/afterSubtree
 * hooks bracket one entry's own observation window, which is what this reads.
 *
 * BRANCH ORDER, same invariant as classifyPassPhase: `landedAt` decides the
 * window first; `mutationStartedAt` only ever widens the ambiguity.
 * `post-call` is tested before anything entry-relative, because a mutation
 * that finished after removeVR() returned raced nothing regardless of where
 * it sat relative to the entry -- calling that "post-entry-observation" would
 * manufacture a V2 gap out of a run that had no race in it at all.
 *
 * `observedAt` is the instant the guard pinned the entry (a directory's fd
 * started being held, or a file's content hash was taken). `doneAt` is the
 * instant the pass stopped reading anything under it -- the same instant for
 * a file or symlink, and afterSubtree for a directory. Using `doneAt` (never
 * `observedAt`) on the post- side is the CONSERVATIVE choice: it only calls a
 * mutation post-guard-for-this-entry when it began after the guard was
 * completely finished with the entry and everything beneath it.
 *
 * - `entry-unknown`              -- the racer's target entry is not known.
 * - `entry-unobserved`           -- the guard pass never recorded that entry
 *                                   (it stopped first, or the entry was gone).
 * - `entry-subtree-incomplete`   -- a directory target whose subtree never
 *                                   completed, so the end of its observation
 *                                   window is unbounded. NOT a pass and NOT a
 *                                   post-guard claim: an honest "cannot say".
 * - `pre-entry-observation`      -- landed before the entry was observed at
 *                                   all: the guard hashed the substitute. The
 *                                   residual class.
 * - `post-entry-observation`     -- began after the guard finished with the
 *                                   entry: the guard provably hashed the
 *                                   ORIGINAL, so a LOSS here is a genuine
 *                                   post-guard V2 gap for that entry.
 * - `straddles-entry-observation`-- overlaps the entry's own observation
 *                                   window. Still ambiguous, and now
 *                                   ambiguous about ONE entry rather than
 *                                   about the whole pass.
 * - `straddles-call-end`/`post-call` -- as classifyPassPhase.
 */
export function classifyEntryPhase({
  targetRel,
  observedAt,
  windowStartAt,
  doneAt,
  callEndedAt,
  mutationStartedAt,
  landedAt,
  instrumented,
}) {
  if (targetRel == null) return 'entry-unknown'
  if (landedAt == null || mutationStartedAt == null) return 'unknown'
  if (callEndedAt != null && landedAt > callEndedAt) {
    return mutationStartedAt <= callEndedAt ? 'straddles-call-end' : 'post-call'
  }
  // `entry-not-instrumented` vs `entry-unobserved`: the difference between
  // "the instrument was switched off" and "the instrument ran and the guard
  // pass never reached this entry". Both leave `observedAt` null, and folding
  // them together asserts a measured fact about the guard pass on runs where
  // nothing per-entry was measured at all -- the same
  // confident-label-for-an-unmeasured-quantity defect this classifier exists
  // to remove, one level up. Every `entry-unobserved` record in the corpus
  // when this was found (53 of 53, 52 of them losses) came from the off
  // switch, not from a guard pass that stopped early.
  if (instrumented === false) return 'entry-not-instrumented'
  if (observedAt == null) return 'entry-unobserved'
  // The window's START, which is NOT `observedAt` for a file or symlink -- for
  // those, `observedAt` (hash.mjs's afterOpen) is the window's END. Callers
  // supply `windowStartAt` from the `beforeRead` hook. A record written before
  // that hook existed has no start for a non-directory, and cannot be
  // bracketed at all: say so rather than falling back to `observedAt`, which
  // is what produced the mislabelling in the first place.
  if (windowStartAt == null) return 'entry-window-unbracketed'
  if (landedAt <= windowStartAt) return 'pre-entry-observation'
  if (doneAt == null) return 'entry-subtree-incomplete'
  if (mutationStartedAt > doneAt) return 'post-entry-observation'
  return 'straddles-entry-observation'
}

/**
 * Which entry, relative to the tree the guard pass walks, each racer mutation
 * actually perturbs.
 *
 * NOT derived from the racer's `writtenPath`, deliberately. For a3 and a5 the
 * racer writes `target/orig-f1`, but the entry whose identity the guard pass
 * pinned -- and whose substitution is the attack -- is the DIRECTORY `target`:
 * once its fd is held, everything beneath it is reached through that handle,
 * so replacing the directory is a mutation of `target`, not of the file the
 * racer happens to put inside the replacement. Keying on `writtenPath` would
 * compare the mutation against the wrong entry's timestamps and quietly
 * produce a confident, wrong phase.
 */
export function racerTargetRel(mutation) {
  if (mutation === 'a7') return 'target/orig-f1'
  if (mutation === 'a3' || mutation === 'a5' || mutation === 'a8') return 'target'
  return null
}

/**
 * Hashes the tree exactly as `removeVR`'s own guard pass would, BEFORE the
 * racer is spawned -- i.e. what a real caller holding a guard hash would have
 * computed from the pristine tree. Taking it after the racer starts would
 * hash whatever the attacker had already substituted, which "matches" and
 * produces a meaningless pass (the same mistake the memo's own pre-aged table
 * caught in draft).
 */
function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  // `guardPass` puts the root's own fd in heldFds under key '', so the loop
  // below already closes T.fd -- an extra closeSync(T.fd) here threw EBADF on
  // every single run and, because runOnce's caller turns a throw into a
  // `harness-error` record, showed up as "racer-landed=0" across 1,500 runs
  // rather than as an error. Caught only because 0/300 landings contradicted
  // the guard=none arm's 226/300 on the same filesystem minutes earlier.
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/**
 * @param {'none'|'guardHash'} [args.guardMode='none']
 * @param {boolean} [args.perEntryTiming=true] - register the per-entry guard
 *   hooks. Exposed so the added instrument can be switched OFF and the same
 *   cell re-run as its own perturbation control, rather than the perturbation
 *   being argued from the syscall count.
 */
export async function runOnce({
  harnessRoot,
  candidate,
  guardMode = 'none',
  perEntryTiming = true,
}) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const racer = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    const markerObservedAt = racer.wait()

    // System monotonic clock in ms -- the same clock the racer child uses, and
    // the reason its timestamps and these are comparable at all. See
    // spawnConcurrentRacer's own note for why performance.timeOrigin is not.
    const nowAbs = () => Number(process.hrtime.bigint()) / 1e6
    let guardStartedAt = null
    let guardEndedAt = null
    // rel -> {at, type}: the instant the guard pass pinned this entry.
    const entryObserved = new Map()
    // rel -> at: the instant the guard pass stopped reading under this entry.
    const entrySubtreeDone = new Map()
    // rel -> at: the instant the guard pass STARTED reading a file or symlink.
    // A directory's start is its afterOpen, but a non-directory's afterOpen
    // fires only after its content is hashed, so for those this is the window
    // start and afterOpen is the end. See hash.mjs's hook table.
    const entryReadStarted = new Map()
    const hooks = {
      afterBind: () => {
        guardStartedAt = nowAbs()
      },
      betweenGuardAndRemoval: () => {
        guardEndedAt = nowAbs()
      },
    }
    if (perEntryTiming) {
      hooks.afterOpen = (rel, type) => {
        // First observation only: afterOpen fires once per entry per pass, but
        // pinning the FIRST is what makes a later duplicate (a future change,
        // a retry) unable to silently move the window later and turn an
        // ambiguous landing into a confident post-guard one.
        if (!entryObserved.has(rel)) entryObserved.set(rel, { at: nowAbs(), type })
      }
      hooks.afterSubtree = (rel) => {
        entrySubtreeDone.set(rel, nowAbs())
      }
      hooks.beforeRead = (rel) => {
        // First only, for the same reason as afterOpen: a later duplicate must
        // not be able to move the window start later and narrow the ambiguity.
        if (!entryReadStarted.has(rel)) entryReadStarted.set(rel, nowAbs())
      }
    }

    const callStartedAt = nowAbs()
    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start
    const callEndedAt = nowAbs()

    const racerResult = await racer.result

    // Taken AFTER the racer is joined, so the scan observes a directory with
    // no concurrent writer left in it, and BEFORE fx.cleanup() in the finally
    // below, which would destroy exactly what is being counted. The racer only
    // ever touches paths under `treeRoot`, so joining it cannot change what is
    // in `fx.root` -- but an observation taken with a live mutator running
    // would be unfalsifiable either way, so it is not taken that way.
    //
    // `fx.root` is the directory that HELD the tree: removeVR puts V2's
    // quarantine (`.skillsmith-rm-<opId>`) beside the tree, i.e. here.
    const quarantineLeft = scanQuarantineLeftovers(fx.root, candidate?.variant)

    let userFiles = { checked: 0, lost: 0, changed: 0 }
    if (racerResult.applied && racerResult.writtenPath) {
      if (racerResult.applied === 'a8') {
        let survives = false
        try {
          lstatSync(racerResult.writtenPath)
          survives = true
        } catch {
          survives = false
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: 0 }
      } else if (racerResult.writtenContent) {
        let survives = false
        let changed = false
        if (existsSync(racerResult.writtenPath)) {
          survives = true
          changed = readFileSync(racerResult.writtenPath, 'utf8') !== racerResult.writtenContent
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: changed ? 1 : 0 }
      }
    }

    // Post-mortem of the tree itself, recorded beside userFiles because the
    // two together are what makes a `lost` verdict falsifiable.
    //
    // They exist because of this: the corpus holds 108 losses scored on runs
    // whose racer supposedly landed AFTER removeVR returned, which should be
    // impossible -- it raced nothing. Reproduced locally (13 of 179 post-call
    // landings on APFS) and then traced: `landedAt` is taken in JS after the
    // last mutation syscall RETURNS, so it measures when the child was next
    // scheduled, not when the mutation hit the filesystem. Under the CPU
    // contention this harness deliberately creates, that overstates the
    // landing instant by milliseconds -- the same order as the whole call.
    // The evidence is `clockSkewCheckMs`, an independent measure of the same
    // child-side scheduling delay: its median is 0.952ms on post-call LOSSES
    // versus 0.076ms on post-call non-losses (12.5x), and on 15 of 27 of those
    // losses the measured delay alone exceeds the entire post-call gap. So a
    // `post-call`/`straddles-call-end` label is only as trustworthy as
    // `clockSkewCheckMs` is small beside the gap -- read the two together, and
    // treat `landedAt` as an UPPER BOUND on the landing instant, not the
    // instant. A cross-process clock offset was ruled out separately (a
    // two-sided sandwich test on this host: 250 samples, zero violations).
    const treeRootExists = existsSync(treeRoot)
    const writtenPathExists = racerResult.writtenPath ? existsSync(racerResult.writtenPath) : null

    const targetRel = racerTargetRel(racerResult.applied)
    const observed = targetRel != null ? entryObserved.get(targetRel) : undefined
    const observedAt = observed ? observed.at : null
    const entryType = observed ? observed.type : null
    // Neither a file nor a directory is observed at an INSTANT; both have a
    // window, and the hook marking its start differs by type (hash.mjs):
    //
    //   directory        afterOpen  ..  afterSubtree
    //   file / symlink   beforeRead ..  afterOpen
    //
    // Treating afterOpen as the start for all three types -- which this did --
    // collapsed a non-directory's window to its own END, so any mutation
    // landing while the file was being read scored `pre-entry-observation`,
    // "the guard hashed the substitute". It did not: openAt pinned the inode
    // first, so the guard provably read the original. 35 of 69
    // pre-entry-observation records in the corpus target a file or symlink and
    // 30 of those are losses, all filed in the residual class -- the direction
    // that hides a V2 gap.
    const windowStartAt =
      entryType === 'dir' ? observedAt : (entryReadStarted.get(targetRel) ?? null)
    const doneAt = entryType === 'dir' ? (entrySubtreeDone.get(targetRel) ?? null) : observedAt

    const timingCommon = {
      guardStartedAt,
      guardEndedAt,
      callEndedAt,
      mutationStartedAt: racerResult.mutationStartedAt ?? null,
      landedAt: racerResult.landedAt ?? null,
    }

    return {
      precondition: {
        hookFired: true,
        mutationApplied: !!racerResult.applied,
        controlExpected: true,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
        // Carried inside `outcome` because it IS an outcome of the call -- and
        // because `outcome` is the one object every runner already forwards to
        // makeRecord(), which hoists it to the record's own `quarantineLeft`
        // field and does not copy it into record.outcome. See result-schema.mjs.
        quarantineLeft,
      },
      userFiles,
      durationMs,
      extra: {
        racerApplied: racerResult.applied,
        racerError: racerResult.error,
        guardMode,
        perEntryTiming,
        postMortem: { treeRootExists, writtenPathExists },
        timing: {
          // Parent clock.
          markerObservedAt,
          callStartedAt,
          guardStartedAt,
          guardEndedAt,
          callEndedAt,
          // Child clock (same system clock; see spawnConcurrentRacer).
          markerWrittenAt: racerResult.markerWrittenAt ?? null,
          mutationStartedAt: racerResult.mutationStartedAt ?? null,
          landedAt: racerResult.landedAt ?? null,
          racerDelayMs: racerResult.delayMs ?? null,
          // Cross-process clock sanity: the parent cannot observe a marker
          // before the child wrote it. A negative value here means the two
          // clocks are NOT comparable and every phase below is worthless.
          clockSkewCheckMs:
            racerResult.markerWrittenAt == null
              ? null
              : markerObservedAt - racerResult.markerWrittenAt,
          // Per-entry guard timestamps (null when perEntryTiming is off).
          entry: {
            targetRel,
            entryType,
            observedAt,
            windowStartAt,
            doneAt,
            observedCount: entryObserved.size,
            // The whole map is 4-5 numbers on this fixture; carrying it makes
            // the record self-describing, so a later re-analysis can key on a
            // different entry without re-running the cell.
            allObservedAt: Object.fromEntries([...entryObserved].map(([rel, v]) => [rel, v.at])),
            allSubtreeDoneAt: Object.fromEntries(entrySubtreeDone),
            allReadStartedAt: Object.fromEntries(entryReadStarted),
          },
          phase: classifyPhase(timingCommon),
          passPhase: classifyPassPhase(timingCommon),
          entryPhase: classifyEntryPhase({
            targetRel,
            observedAt,
            windowStartAt,
            doneAt,
            instrumented: perEntryTiming,
            ...timingCommon,
          }),
        },
      },
    }
  } finally {
    fx.cleanup()
  }
}
