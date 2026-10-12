// A2 against C4 (quarantineTree): the same mount fixture as A1-C4, but the
// mount is made INSIDE the call, in onFire at window 'after-bind' (C4: right
// after the first lstat of the tree root returns, before the hash begins; the
// caller's guard hash was computed on the unmounted tree). C4 is expected to
// see the mount in its own hash and return `kept`. C4-naive has no bind, so
// runC4Candidate maps 'after-bind' to 'at-rename' for it and reports that in
// extra.firedAt. Scoring, displaced/deleted accounting and cleanup are the
// shared body in a1-c4.mjs (runMountCase).

import { runMountCase } from './a1-c4.mjs'

export const id = 'A2-C4'
export const target = 10

export function runOnce({ harnessRoot, candidate, subcase }) {
  return runMountCase({ harnessRoot, candidate, subcase, window: 'after-bind' })
}
