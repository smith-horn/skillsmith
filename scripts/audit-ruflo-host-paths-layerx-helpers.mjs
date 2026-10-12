#!/usr/bin/env node
/**
 * Layer-X detection helpers for audit-ruflo-host-paths-helpers.mjs's Check 74
 * (SMI-6744 Wave 4 M-6 governance finding).
 *
 * Split into its own file so audit-ruflo-host-paths-helpers.mjs stays under
 * the 500-line policy (scripts/file-length-policy.mjs) -- this is a pure
 * extension of that file's own Layer-X tree assertion, not a separate
 * concern, and is imported by it rather than by audit-standards.mjs
 * directly.
 *
 * Check 74's original Layer-X arm asserted only `<root>/node_modules/ruflo`'s
 * absence. That misses two things a real `npm install` after the
 * devDependency removal can still leave behind:
 *
 *   1. `<root>/node_modules/@claude-flow/cli` -- the package `ruflo` itself
 *      re-exports; a partial or manually-patched node_modules tree can carry
 *      this without the top-level `ruflo` directory existing at all.
 *   2. A stale `node_modules/.bin/{ruflo,claude-flow,claude-flow-mcp,cli}`
 *      symlink -- npm normally removes these on an uninstall, but a manually
 *      edited tree, an interrupted install, or a leftover from before Layer
 *      X landed can leave one behind. `existsSync()` on a dangling symlink
 *      follows the link and reports the PATH absent (Node resolves the
 *      link's target, not the link itself), which would silently hide
 *      exactly the broken-reinstall case this check exists to catch -- so
 *      this uses `lstatSync()` (does not follow the link) plus
 *      `readlinkSync()` (reads the link's own target text) instead.
 *      `.bin/cli` is judged by where it POINTS, never by its own name --
 *      `cli` is a generic bin name several unrelated packages also ship, so
 *      naming alone would over-match.
 */

import { lstatSync as defaultLstatSync, readlinkSync as defaultReadlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** The four `.bin` names this arm checks (design doc § 6 row 6 / M-6). */
export const LAYER_X_BIN_NAMES = Object.freeze(['ruflo', 'claude-flow', 'claude-flow-mcp', 'cli'])

/**
 * Does a readlink target resolve into a `ruflo/` or `@claude-flow/`
 * directory? Judged by PATH SEGMENT, not substring -- `not-ruflo/bin/x`
 * must not match `ruflo`, which a bare `.includes('ruflo')` would get wrong.
 */
function targetIsRufloRelated(target) {
  const segments = target.split('/')
  return segments.includes('ruflo') || segments.includes('@claude-flow')
}

/**
 * Evaluates one `node_modules/.bin/<name>` entry.
 *
 * A RESOLVABLE symlink is judged by its TARGET — `finding` is true only
 * when the target names `ruflo`/`@claude-flow` (see `targetIsRufloRelated`
 * below). A DANGLING symlink is judged by its NAME alone, deliberately
 * (L-G fix, SMI-6744 Wave 4 governance round) — `finding` is true
 * regardless of what the broken target text says, because a dangling link
 * at one of these four reserved bin names is itself evidence of a broken
 * reinstall this arm exists to catch, and a dangling target's text cannot
 * be trusted to describe what used to be there.
 *
 * @returns {{
 *   binPath: string,
 *   present: boolean,
 *   isSymlink: boolean,
 *   dangling: boolean,
 *   target: string | null,
 *   finding: boolean,
 * }}
 */
export function evaluateLayerXBinEntry(root, name, options = {}) {
  const { lstatSync = defaultLstatSync, readlinkSync = defaultReadlinkSync } = options
  const binPath = join(root, 'node_modules', '.bin', name)

  let stat
  try {
    stat = lstatSync(binPath)
  } catch {
    return {
      binPath,
      present: false,
      isSymlink: false,
      dangling: false,
      target: null,
      finding: false,
    }
  }

  if (!stat.isSymbolicLink()) {
    // A real file occupying this reserved bin name is outside this arm's
    // scope (npm's own mechanism for these four names is a symlink) --
    // Layer R's Bash denies and the top-level tree assertions cover the
    // executable-content case regardless of what sits at this path.
    return {
      binPath,
      present: true,
      isSymlink: false,
      dangling: false,
      target: null,
      finding: false,
    }
  }

  let target = null
  try {
    target = readlinkSync(binPath)
  } catch {
    // Symlink exists but its target text couldn't be read -- fail closed:
    // treat as a finding rather than silently passing on an unreadable link.
    return { binPath, present: true, isSymlink: true, dangling: false, target: null, finding: true }
  }

  // A relative target is resolved against the symlink's OWN containing
  // directory (POSIX symlink semantics), never against `root` or cwd.
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(binPath), target)
  let dangling = false
  try {
    lstatSync(resolvedTarget)
  } catch {
    dangling = true
  }

  return {
    binPath,
    present: true,
    isSymlink: true,
    dangling,
    target,
    // A dangling link is a finding on its own (this file's header note on
    // why existsSync() would wrongly call it absent); a resolvable link is
    // a finding only when its target actually names ruflo/@claude-flow.
    finding: dangling || targetIsRufloRelated(target),
  }
}

/**
 * Evaluates all four LAYER_X_BIN_NAMES entries under `root`.
 * @returns {ReturnType<typeof evaluateLayerXBinEntry>[]}
 */
export function evaluateLayerXBinSymlinks(root, options = {}) {
  return LAYER_X_BIN_NAMES.map((name) => evaluateLayerXBinEntry(root, name, options))
}
