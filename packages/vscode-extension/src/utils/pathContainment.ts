import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export class PathOutsideRoot extends Error {
  constructor(
    public readonly target: string,
    public readonly root: string
  ) {
    super(`Refusing operation: resolved path "${target}" is outside allowed root "${root}"`)
    this.name = 'PathOutsideRoot'
  }
}

/**
 * Assert that `target` resolves inside `root` after symlink resolution.
 *
 * Both paths are realpath-resolved before comparison so symlinks inside the
 * root pointing outside cannot escape the check. Throws `PathOutsideRoot`
 * when containment is violated.
 *
 * Shared by install and uninstall flows — any command that touches a user-
 * selected skill directory must call this before `fs.rm` / `fs.writeFile`.
 */
export async function assertInsideRoot(target: string, root: string): Promise<void> {
  // Resolve root first — a bad root is always a caller error and should surface as-is.
  const resolvedRoot = await fs.realpath(root)

  // Resolve target. If it does not exist yet (e.g. an install destination that will be
  // created shortly after this check), realpath throws ENOENT. We treat that as a failed
  // containment check: we cannot verify the path is safe, so we refuse. Callers that need
  // to install into a new directory must resolve the parent and append the leaf segment
  // themselves rather than calling assertInsideRoot on a not-yet-created path.
  //
  // Other errors (e.g. EACCES, ELOOP) are re-thrown as-is so callers can distinguish a
  // permission failure on a valid path from an actual containment violation.
  let resolvedTarget: string
  try {
    resolvedTarget = await fs.realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PathOutsideRoot(target, resolvedRoot)
    }
    throw err
  }

  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathOutsideRoot(resolvedTarget, resolvedRoot)
  }
}
