/**
 * SMI-6975 — type declarations for scripts/audit-readme-whats-new-helpers.mjs.
 *
 * Lets scripts/lib/release-readme.ts (a .ts file) import these Check-60
 * helpers cleanly under this gate's bundler module resolution without
 * @ts-expect-error suppression. The .d.mts extension is the correct pairing
 * for a .mjs module, mirroring the existing scripts/lib/project-dir.d.mts /
 * scripts/lib/linear-client.d.mts convention.
 *
 * Signatures transcribed from the .mjs source's own JSDoc, not invented.
 */

export function extractWhatsNewVersion(readmeContent: string): string | null

export function hasWhatsNewHeading(readmeContent: string): boolean

export function githubHeadingSlug(headingText: string): string

/** Throws if the heading is missing entirely, or matches more than once. */
export function updateWhatsNewVersion(readmeContent: string, newVersion: string): string
