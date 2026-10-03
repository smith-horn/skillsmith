/**
 * SMI-6771 — shared three-way filesystem probe: present / absent /
 * unreachable.
 *
 * `existsSync()` collapses two different states into `false`: a path that
 * genuinely does not exist, and a path that exists but could not be
 * `stat`-ed (EACCES on the path or a parent directory, ENOTDIR where a
 * directory segment is actually a file, etc). Per CLAUDE.md's "measure,
 * don't reason" rule, an unreadable path is evidence about *reachability*,
 * not about *existence* -- a gate that silently skips on "unreachable" the
 * same way it skips on "absent" is silently skipping on a state that might
 * mean the fixture (a submodule, `~/.claude`, a research doc) is broken, not
 * that the optional dependency is legitimately not there.
 *
 * POSIX `stat()` needs search permission on the path's PREFIX, not on the
 * target itself, so stat-ing the target directly is what separates the two
 * cases: `ENOENT` means absent; any other error (`EACCES` on the path or an
 * ancestor directory, `ENOTDIR`) means unreachable, and the target may well
 * exist.
 *
 * Extracted from the inline classifier in ruflo-bridge-verdict.test.ts's
 * predicate-drift guard (SMI-6744 Wave 0) so every existsSync-based
 * present/absent gate in this test tree gets the same answer instead of
 * re-deriving (and re-breaking) the ENOENT distinction per file. Import this
 * module directly (`./_lib/probe-path.js`) -- the barrel at `_lib/index.ts`
 * intentionally does not re-export it (see that file's own header).
 */
import { statSync } from 'node:fs'

export type Probe = 'present' | 'absent' | 'unreachable'

/**
 * @param p the path to probe
 * @param statImpl injectable in tests only, to exercise the ENOENT-vs-other
 *   split deterministically without needing a real permission-denied
 *   fixture; every real caller uses the default (`node:fs`'s `statSync`).
 */
export function probePath(p: string, statImpl: (path: string) => unknown = statSync): Probe {
  try {
    statImpl(p)
    return 'present'
  } catch (err) {
    return (err as { code?: string })?.code === 'ENOENT' ? 'absent' : 'unreachable'
  }
}

/**
 * Turns a Probe into a plain "is this present" boolean for a gate's own
 * skip decision -- but throws, rather than silently returning false, when
 * the probe is 'unreachable'. Collapsing 'unreachable' into the same
 * `false` a gate's existsSync-based skip used for 'absent' is exactly the
 * defect this helper exists to remove: a path that could not be checked is
 * not evidence the optional dependency behind it is missing, so a gate must
 * fail loudly there instead of rendering a legitimate-looking skip.
 *
 * `label` is included in the thrown message so a failure names which gate's
 * path went unreachable, not just that one did somewhere in the suite.
 */
export function requirePresence(probe: Probe, label: string): boolean {
  if (probe === 'unreachable') {
    throw new Error(
      `${label} unreachable (not absent) -- refusing to treat this as a legitimate skip`
    )
  }
  return probe === 'present'
}
