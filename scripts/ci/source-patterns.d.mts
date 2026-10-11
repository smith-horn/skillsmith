/**
 * SMI-6975 — type declarations for scripts/ci/source-patterns.mjs.
 *
 * Lets scripts/ci/verify-implementation.ts (a .ts file) import the shared
 * file-classification pattern lists cleanly under this gate's bundler module
 * resolution without @ts-expect-error suppression. The .d.mts extension is
 * the correct pairing for a .mjs module under this config, mirroring the
 * existing scripts/lib/project-dir.d.mts / scripts/lib/linear-client.d.mts
 * convention for the same situation.
 *
 * Each export is a plain array of RegExp literals in the .mjs source --
 * RegExp[] is the real, exact type, not a declared-for-convenience widening.
 */

export const SOURCE_PATTERNS: RegExp[]
export const TEST_PATTERNS: RegExp[]
export const DOCS_PATTERNS: RegExp[]
