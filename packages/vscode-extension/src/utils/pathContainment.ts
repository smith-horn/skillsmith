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
  const [resolvedTarget, resolvedRoot] = await Promise.all([fs.realpath(target), fs.realpath(root)])
  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathOutsideRoot(resolvedTarget, resolvedRoot)
  }
}
