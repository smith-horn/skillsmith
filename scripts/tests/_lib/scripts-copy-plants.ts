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

/** Directories (relative to the repo root) the gate test plants below. */
export const PLANT_BASE = 'scripts/ci'
export const SCOPE_DIRS = ['scripts/e2e', 'scripts/ci', 'scripts/lib', 'scripts/indexer/_shared']

/** Repo-relative path of a plant named `name` below `base`. */
export function plantRel(name: string, base: string = PLANT_BASE): string {
  return `${base}/tests/${name}`
}

/** cpSync filter for the bare scripts/ copy: false drops the path before it is stat'ed. */
export function scriptsCopyFilter(src: string): boolean {
  return !/[\\/](node_modules|tests|package-lock\.json)$/.test(src)
}
