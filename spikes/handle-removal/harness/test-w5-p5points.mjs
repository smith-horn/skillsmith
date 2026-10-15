#!/usr/bin/env node
// SMI-7123 Wave 5: every P5 crash point must actually crash the walker where the
// design's §4 table says, or row P5 silently reads NEVER-RAN for that point.
//
// DECLARED FAILURE ON THE PRE-FIX ROW: `after-P4f` keyed on "before unlinkSync of
// S/deleting", a call P4g no longer makes since the c2 metadata fix (it renames
// `deleting` to a random `.m-*` name and unlinks THAT -- measured), so its hook
// never fires: hookFired false, nothing checked. The APFS timing run on 9073ceffa
// recorded exactly that in all 10 after-P4f candidate records.
import { makeCheck } from './w5-test-util.mjs'
import { R_ROWS } from './w5-rows-r.mjs'

const { check, done } = makeCheck('[w5-p5points]')
const p5 = R_ROWS.P5
for (const point of p5.variants) {
  const rec = p5.arms.candidate(point)
  check(`P5 ${point}: the crash hook fired`, rec.precondition.hookFired, true)
  check(
    `P5 ${point}: no failure recorded (§4 state, nothing changed unasked, removed after a yes)${rec.fsCheck.failures.length ? ` -- ${rec.fsCheck.failures[0]}` : ''}`,
    rec.fsCheck.ok,
    true
  )
}
// The control must fail wherever it deletes something unasked: the staged copy
// (after-P4d), and the metadata-only leftover after the walk (after-P4f), which it
// deletes at LISTING -- c1's rule is that nothing is deleted without confirmation.
// DECLARED FAILURE ON THE PRE-FIX ROW: at after-P4f the control records no failure
// (the row only checked the copy, and after P4f there is none) -- the 9073ceffa run
// shows it `kept`.
for (const point of ['after-P4d', 'after-P4f']) {
  const ctl = p5.arms['prune-resume-blind'](point)
  check(
    `P5 control prune-resume-blind at ${point}: premise, the crash hook fired`,
    ctl.precondition.hookFired,
    true
  )
  check(`P5 control prune-resume-blind at ${point} fails`, ctl.fsCheck.ok, false)
}
done()
