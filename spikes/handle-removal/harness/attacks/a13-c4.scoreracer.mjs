// A13-C4 racer scoring against the filesystem (split out of a13-c4.mjs for the
// file-length limit, SMI-6715 Step 1b part 2). probeAt reads what is on disk;
// scoreRacer turns the racer's completed steps into expectations
// (a13-c4.score.mjs) and scores them; userFilesOf shapes the record's counts.

import fs from 'node:fs'
import path from 'node:path'
import { expectationsFromSteps, scoreExpectations } from './a13-c4.score.mjs'

/**
 * A probe for scoreExpectations rooted at `base`: what is at base/rel, never
 * following the final component. Absent (ENOENT, or ENOTDIR because a parent
 * is no longer a directory) is null; any other error throws, which makes the
 * run unscorable rather than silently "absent".
 */
function probeAt(base) {
  return (rel) => {
    const abs = path.join(base, ...rel.split('/'))
    let st
    try {
      st = fs.lstatSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
    if (st.isSymbolicLink()) return { kind: 'symlink', linkText: fs.readlinkSync(abs) }
    if (st.isFile()) return { kind: 'file', content: fs.readFileSync(abs, 'utf8') }
    if (st.isDirectory()) return { kind: 'dir' }
    return { kind: 'other' }
  }
}

/**
 * Scores the racer's completed steps; returns {scored} or {unscorable: reason}.
 * SMI-6715 Step 1b part 2: for a HELD run (`held: true`) the held copy at
 * `destPath` is the location of record, so the expectations are probed there
 * and nowhere else; otherwise at the origin, with `destPath` (a moved tree) as
 * the displaced-lookup.
 */
export function scoreRacer(racer, treeRoot, destPath, { held = false } = {}) {
  try {
    if (!Array.isArray(racer.steps))
      return { unscorable: `racer-report-unknown:${racer.error ?? 'no-steps'}` }
    if (held && typeof destPath !== 'string') return { unscorable: 'held-without-path' }
    const expectations = expectationsFromSteps(racer.steps, treeRoot)
    const scored = scoreExpectations({
      expectations,
      probeOrigin: probeAt(held ? destPath : treeRoot),
      probeDest: !held && destPath ? probeAt(destPath) : null,
    })
    if (scored.displaced + scored.deleted !== scored.lost) {
      return { unscorable: 'displaced+deleted!=lost' }
    }
    return { scored, expectations }
  } catch (err) {
    return { unscorable: `scoring-threw:${err instanceof Error ? err.message : String(err)}` }
  }
}

export const NO_FILES = { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 }
export const userFilesOf = (s) =>
  s
    ? {
        checked: s.checked,
        lost: s.lost,
        changed: s.changed,
        displaced: s.displaced,
        deleted: s.deleted,
      }
    : NO_FILES
