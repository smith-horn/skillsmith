// SMI-6676 harness fixture roots and path-safety refusals (plan §9).
//
// Every attack builds its tree under a throwaway root created here. Nothing
// in this harness ever touches the real ~/.claude, ~/.agents, ~/.skillsmith
// or a repo dev container -- see plan §9 "Fixtures and safety" and the task's
// own "never write to the real harness root" instruction.

import { mkdtempSync, mkdirSync, realpathSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const DISALLOWED_SEGMENTS = new Set(['.claude', '.skillsmith', '.agents', '.cursor'])

/**
 * Resolves the nearest existing ancestor of `p` and returns its real
 * (symlink-resolved) path joined with the non-existent suffix, so refusal
 * checks can't be defeated by a symlinked ancestor even before the leaf
 * directory exists.
 */
function realish(p) {
  let cur = path.resolve(p)
  const suffix = []
  while (!existsSync(cur)) {
    suffix.unshift(path.basename(cur))
    const parent = path.dirname(cur)
    if (parent === cur) break // reached filesystem root without finding an existing ancestor
    cur = parent
  }
  const real = existsSync(cur) ? realpathSync(cur) : cur
  return suffix.length > 0 ? path.join(real, ...suffix) : real
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Throws if `targetPath` is unsafe to create or write fixtures into.
 *
 * Refused:
 *  - any path under the real $HOME, unless it is also under one of
 *    `allowedRoots` (TMPDIR and, when set, the session scratchpad);
 *  - any path containing a .claude / .skillsmith / .agents / .cursor segment;
 *  - any path outside `harnessRoot`.
 *
 * @param {string} targetPath
 * @param {string} harnessRoot - the one root every fixture must live under
 * @param {string[]} [allowedRoots] - roots under $HOME that are still OK
 *   (TMPDIR, the Claude scratchpad). Defaults to [os.tmpdir()].
 */
export function refusePath(targetPath, harnessRoot, allowedRoots = [tmpdir()]) {
  const resolved = realish(targetPath)
  const home = realish(homedir())
  const resolvedHarnessRoot = realish(harnessRoot)
  const resolvedAllowedRoots = allowedRoots.map((r) => realish(r))

  const segments = resolved.split(path.sep)
  for (const seg of segments) {
    if (DISALLOWED_SEGMENTS.has(seg)) {
      throw new Error(
        `[fixture-root] refused: "${targetPath}" contains disallowed segment "${seg}"`
      )
    }
  }

  if (isUnder(resolved, home) && !resolvedAllowedRoots.some((r) => isUnder(resolved, r))) {
    throw new Error(
      `[fixture-root] refused: "${targetPath}" is under the real HOME (${home}) and not under an allowed root`
    )
  }

  if (!isUnder(resolved, resolvedHarnessRoot)) {
    throw new Error(
      `[fixture-root] refused: "${targetPath}" is outside the harness root (${resolvedHarnessRoot})`
    )
  }
}

/**
 * Picks the harness root for this environment. Override with
 * SMI6676_HARNESS_ROOT (set by the container/host entrypoint that mounted
 * the target filesystem -- /work, /tmpfsroot, /ext4vol, /virtiofs, or a
 * mkdtemp'd macOS TMPDIR base).
 */
export function resolveHarnessRoot() {
  if (process.env.SMI6676_HARNESS_ROOT) {
    return path.resolve(process.env.SMI6676_HARNESS_ROOT)
  }
  if (process.platform === 'darwin') {
    const base = path.join(tmpdir(), 's6676-session')
    mkdirSync(base, { recursive: true })
    return base
  }
  // Linux default inside a throwaway container with no explicit mount.
  const base = '/work'
  mkdirSync(base, { recursive: true })
  return base
}

function runId() {
  return crypto.randomBytes(4).toString('hex')
}

/**
 * Creates one throwaway fixture root under the harness root, refusing it
 * first for safety, and returns handles to build a tree and clean it up.
 *
 * @param {object} [options]
 * @param {string} [options.harnessRoot] - defaults to resolveHarnessRoot()
 * @param {string[]} [options.allowedRoots]
 * @returns {{root:string, runId:string, home:string, cleanup: () => void}}
 */
export function makeFixtureRoot(options = {}) {
  const harnessRoot = options.harnessRoot ?? resolveHarnessRoot()
  mkdirSync(harnessRoot, { recursive: true })
  refusePath(harnessRoot, harnessRoot, options.allowedRoots)

  const id = runId()
  const prefix = path.join(harnessRoot, `s6676-${id}-`)
  const root = mkdtempSync(prefix)
  refusePath(root, harnessRoot, options.allowedRoots)

  // A sandboxed HOME for any candidate process this run launches (§9: "HOME:
  // candidates run with HOME set to a temp dir").
  const home = path.join(root, '.home')
  mkdirSync(home, { recursive: true })

  return {
    root,
    runId: id,
    home,
    cleanup() {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Verifies a fixture root's own scratch state (its quarantine/trash
 * directories, if any) is empty before the harness moves on -- §9's
 * "the runner's own quarantine and trash directories are listed and must be
 * empty."
 *
 * @param {string} root
 * @param {string[]} relDirs - directories relative to `root` to check, e.g.
 *   ['.skillsmith-trash']
 * @returns {{clean:boolean, nonEmpty:string[]}}
 */
export function assertScratchEmpty(root, relDirs) {
  const nonEmpty = []
  for (const rel of relDirs) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) continue
    const entries = readdirSync(abs)
    if (entries.length > 0) {
      nonEmpty.push(`${rel} (${entries.length} entries: ${entries.slice(0, 5).join(', ')})`)
    }
  }
  return { clean: nonEmpty.length === 0, nonEmpty }
}
