/**
 * File-walker helper extracted from audit-standards.mjs (SMI-6192).
 *
 * getFilesRecursive() was previously defined inline in audit-standards.mjs
 * and unexported — a test that wanted to exercise it had no choice but to
 * re-implement it verbatim (see the pre-existing anti-pattern this avoids
 * repeating: scripts/tests/audit-standards-apps-root.test.ts duplicates this
 * exact function rather than importing the real one, per its own header
 * comment explaining why). Following the established `audit-*-helpers.mjs`
 * convention already used throughout this file family (e.g.
 * audit-realpath-asymmetry-helpers.mjs, audit-cli-pin-drift-helpers.mjs —
 * both of which also do real filesystem I/O, unlike the deliberately
 * zero-I/O audit-standards-helpers.mjs), the walker now lives in its own
 * small companion module so both audit-standards.mjs (Checks 2, 3, 4, 41,
 * and any future caller) and its test suite
 * (scripts/tests/audit-standards-vercel-output-skip.test.ts) import and
 * exercise the SAME production function.
 *
 * Does real filesystem I/O (readdirSync/statSync) when called — but nothing
 * runs at import time, so importing this module has no side effects.
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Recursively collect files under `dir` whose name ends with one of
 * `extensions`. Skips `node_modules`, `dist`, `.git`, and `.vercel`.
 *
 * The `.vercel` skip (SMI-6192) matters independent of any bug: it is
 * git-ignored Vercel adapter build output (packages/website/.vercel/output)
 * and should never be scanned by a source-code standards check. It also
 * happens to route around a live Docker Desktop for Mac virtiofs bug where
 * a freshly-written file under that path could be listed by `readdirSync`
 * and then throw `ENOENT` on a subsequent `statSync` moments later — see
 * docs/internal/implementation/smi-6192-website-vercel-output-eacces.md.
 */
export function getFilesRecursive(dir, extensions) {
  const files = []
  if (!existsSync(dir)) return files

  const items = readdirSync(dir)
  for (const item of items) {
    const fullPath = join(dir, item)
    if (item === 'node_modules' || item === 'dist' || item === '.git' || item === '.vercel')
      continue

    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...getFilesRecursive(fullPath, extensions))
    } else if (extensions.some((ext) => item.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}
