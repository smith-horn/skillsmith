/**
 * SMI-6975 — type declarations for scripts/lib/reserved-ranges.mjs.
 *
 * Lets scripts/lib/release-collision.ts (a .ts file) import this shared
 * reserved-version-range module cleanly under this gate's bundler module
 * resolution without @ts-expect-error suppression. The .d.mts extension is
 * the correct pairing for a .mjs module, mirroring the existing
 * scripts/lib/project-dir.d.mts / scripts/lib/linear-client.d.mts convention.
 *
 * Signatures transcribed from the .mjs source's own JSDoc, not invented --
 * that file is the single source of truth and this declaration must not
 * drift from it.
 */

/** Map of package name -> semver range permanently reserved on npm. */
export const RESERVED_RANGES: Readonly<Record<string, string>>

/** The minimal semver surface these functions take as an injected dependency. */
export interface InjectedSemver {
  satisfies(version: string, range: string): boolean
}

export function filterReservedVersions(
  pkg: string,
  versions: string[],
  semver: InjectedSemver
): string[]

export function isReserved(pkg: string, version: string, semver: InjectedSemver): boolean
