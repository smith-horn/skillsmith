/**
 * SMI-7012 — type declarations for scripts/lib/release-bump-subject.mjs.
 *
 * The `.d.mts` extension is the correct pairing for a `.mjs` module under
 * NodeNext module resolution, so TypeScript consumers (`release-changelog.ts`)
 * can import it without `@ts-expect-error` suppression. Same convention as
 * `project-dir.d.mts` and `linear-client.d.mts`.
 */

export function isReleaseBumpSubject(subject: unknown): boolean
