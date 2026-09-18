/**
 * is-main-module.mjs -- one answer to "is this module the process entry point?"
 *
 * Three spellings of this check already lived under scripts/ before this
 * file: `import.meta.url === pathToFileURL(argv[1]).href` (breaks through a
 * symlink -- npm bin links, ~/bin shims -- because import.meta.url is the
 * resolved path and argv[1] the invoked one), a realpath comparison whose
 * catch returned false (an unlinked or unreadable path then means "not main",
 * which for a CLI whose exit code is the product is exit 0 with no output --
 * the silent-success class SMI-6744 exists to remove), and the shape below,
 * from scripts/check-file-length.mjs: resolve, then realpath, and on a throw
 * fall back to the RESOLVED path rather than deny. Two paths that both fail
 * to realpath still compare equal when they name the same file.
 *
 * A module whose URL is not `file:` (a bundle, a `data:` import) is never the
 * entry point in the filesystem sense argv[1] describes; it returns false, and
 * a bundler must call its main explicitly. That is the one remaining case, and
 * it is a design limit of every import.meta.url guard, stated here on purpose.
 *
 * Usage:  if (isMainModule(import.meta.url)) process.exit(main(process.argv))
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute, symlink-free when possible; absolute-but-unresolved when not. */
export function canonicalize(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/**
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @param {string | undefined} [argv1] defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  let self
  try {
    self = fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
  return canonicalize(self) === canonicalize(argv1)
}
