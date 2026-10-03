/**
 * @fileoverview Decide whether a real-filesystem path lies inside a root.
 * @module @skillsmith/cli/utils/sandbox-path
 * @see SMI-6358
 *
 * Extracted from an inline helper in `telemetry.test.ts` after it took four
 * review findings in four rounds — a denylist that permitted every tree but
 * one, a textual compare that ignored symlinks, and a bare `catch` (twice,
 * because the first fix narrowed the helper and left its caller). Each patch
 * was locally correct, which is the shape `pr-reviewer`'s stop-patching rule
 * exists to catch: the question nobody asks between rounds is whether the
 * thing being patched should be a tested unit instead of an inline helper.
 *
 * It lives here rather than in a test file so its own behaviour is pinned by
 * `sandbox-path.test.ts`, where each of those four findings is a named case.
 *
 * Scope, stated precisely because overclaiming it was one of the findings:
 * this answers a question about ONE path. It is not an interception layer and
 * it cannot make a blanket guarantee about a module graph — a caller that does
 * not consult it writes wherever it likes.
 */
import { realpathSync } from 'node:fs'
import { resolve, dirname, basename, join, sep } from 'node:path'

/**
 * The only errno values meaning "nothing is there yet", and therefore the only
 * ones for which falling back to a textual path is sound.
 *
 * Everything else — `ELOOP` for a symlink cycle, `EACCES` for a directory this
 * process cannot resolve through — describes a path this module exists to
 * resolve. Swallowing those would return a textual answer for exactly the
 * inputs that need a resolved one, so they propagate.
 */
const ABSENT: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/** Resolved path, or `null` when nothing exists at `p`. Other errors throw. */
function realpathIfPresent(p: string): string | null {
  try {
    return realpathSync(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== undefined && ABSENT.has(code)) return null
    throw err
  }
}

/**
 * Resolve `p` through symlinks as far as the filesystem allows.
 *
 * The target is often about to be created, so when it is absent its parent is
 * resolved and the final segment re-appended — that still defeats a symlinked
 * ancestor, which is the case worth defeating. When the parent is absent too,
 * the textual path is returned; any write there fails with ENOENT regardless,
 * so nothing is being waved through.
 */
export function resolveRealPath(p: string): string {
  const abs = resolve(p)
  const direct = realpathIfPresent(abs)
  if (direct !== null) return direct
  const parent = realpathIfPresent(dirname(abs))
  return parent === null ? abs : join(parent, basename(abs))
}

/**
 * True when `child` resolves to a location strictly beneath `root`.
 *
 * Both sides are resolved, which is what makes `/tmp` and `/private/tmp`
 * compare equal on macOS — `/tmp` is itself a symlink there, so comparing the
 * two spellings textually is wrong in whichever direction they disagree.
 *
 * `root` itself is not "inside" root: the separator is required, so a sibling
 * whose name merely extends the root's (`/box-other` against `/box`) does not
 * match.
 */
export function isInside(child: string, root: string): boolean {
  return resolveRealPath(child).startsWith(resolveRealPath(root) + sep)
}

/**
 * Throw unless `child` resolves beneath `root`. `label` names the caller, so
 * the message says which operation was refused rather than only where.
 */
export function assertInside(child: string, root: string, label: string): void {
  if (isInside(child, root)) return
  throw new Error(
    `[sandbox-path] ${label} would touch a path outside the permitted root:\n` +
      `  path:     ${child}\n` +
      `  resolved: ${resolveRealPath(child)}\n` +
      `  root:     ${resolveRealPath(root)}`
  )
}
