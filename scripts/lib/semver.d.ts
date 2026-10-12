/**
 * SMI-6975 — minimal type declaration for the `semver` npm package.
 *
 * `semver` is an undeclared transitive dependency here (hoisted via other
 * packages' own deps -- `node_modules/semver` exists at the repo root but no
 * package.json in this repo declares it directly, and `@types/semver` is not
 * installed). Adding either is a package.json change, out of this gate's
 * scope (SMI-6975 owns tsconfig.scripts.json + scripts/ci/typecheck-scripts.sh
 * + fixing the 37 errors the new gate surfaces, not dependency wiring).
 *
 * So: a narrow, accurate ambient declaration covering exactly the functions
 * actually reached from the .ts side of this gate's program -- `valid`,
 * `rsort`, `gt` called directly by scripts/lib/release-collision.ts, plus
 * `satisfies` because that same file passes the whole `semver` object through
 * to `filterReservedVersions`'s `InjectedSemver` parameter (declared in
 * scripts/lib/reserved-ranges.d.mts), which requires it even though
 * release-collision.ts never calls `.satisfies` itself. Verified against the
 * real installed semver 7.8.5 source
 * (node_modules/semver/functions/{valid,rsort,gt,satisfies}.js) rather than
 * guessed -- NOT a blanket `any` for the module.
 */
declare module 'semver' {
  /** Returns the parsed, normalized version string, or null if invalid. */
  function valid(version: string | null | undefined, loose?: boolean): string | null
  /** Sorts a list of version strings in DESCENDING order, in place, and returns it. */
  function rsort(list: string[], loose?: boolean): string[]
  /** True if `a` is greater than `b`. */
  function gt(a: string, b: string, loose?: boolean): boolean
  /** True if `version` satisfies the range expression. */
  function satisfies(version: string, range: string, loose?: boolean): boolean

  const semver: {
    valid: typeof valid
    rsort: typeof rsort
    gt: typeof gt
    satisfies: typeof satisfies
  }
  export default semver
  export { valid, rsort, gt, satisfies }
}
