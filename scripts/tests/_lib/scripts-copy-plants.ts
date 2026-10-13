/**
 * SMI-7071: the one contract shared by typecheck-scripts-gate.test.ts (which plants and deletes
 * zz-smi6975-* files in the live scripts/ tree) and dependency-registry-expiry.test.ts (whose
 * runFromBareCopy copies that same tree). The copy lists a directory, then lstats each entry; a
 * planted file deleted in between fails it with ENOENT. The copy's filter drops any path whose
 * basename is `tests` BEFORE it is stat'ed, so every plant lives below such a directory while
 * staying inside the typecheck gate's scope (the gate excludes only scripts/tests/**).
 *
 * Both halves of the contract live here, so changing one without the other is a type or test error
 * rather than a silent return of the race. Not a test file: it matches no vitest include pattern,
 * and scripts/tests/** is outside tsconfig.scripts.json.
 */

import { basename, dirname } from 'node:path'

/** Directories (relative to the repo root) the gate test plants below. */
export const PLANT_BASE = 'scripts/ci'
export const SCOPE_DIRS = ['scripts/e2e', 'scripts/ci', 'scripts/lib', 'scripts/indexer/_shared']

/**
 * Base for the gate test's other writes into scripts/: the `.backstop-*.sh` gate copies and the
 * swapped-root file. plantRel(name, BACKSTOP_BASE) is scripts/tests/<name>: outside the gate's
 * scope (the gate excludes scripts/tests/**, which these writes rely on) and dropped by the copy.
 */
export const BACKSTOP_BASE = 'scripts'

/** Every base the gate test writes below; the invariant test covers all of them. */
export const ALL_WRITE_BASES = [PLANT_BASE, BACKSTOP_BASE, ...SCOPE_DIRS]

/** Repo-relative path of a plant named `name` below `base`. */
export function plantRel(name: string, base: string = PLANT_BASE): string {
  return `${base}/tests/${name}`
}

/** cpSync filter for the bare scripts/ copy: false drops the path before it is stat'ed. */
export function scriptsCopyFilter(src: string): boolean {
  return !/[\\/](node_modules|tests|package-lock\.json)$/.test(src)
}

/**
 * True when the bare copy never stats `abs`: some path from `abs` up to (not including) a
 * directory named `scripts` is dropped by the filter, so the copy never descends to it. Checks the
 * property on the actual path a test is about to write, whatever name it carries.
 */
export function copyDropsPath(abs: string): boolean {
  let p = abs
  while (basename(p) !== 'scripts' && p !== dirname(p)) {
    if (!scriptsCopyFilter(p)) return true
    p = dirname(p)
  }
  return false
}
