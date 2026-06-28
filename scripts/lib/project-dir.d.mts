/**
 * SMI-5419 W0.1 — type declarations for scripts/lib/project-dir.mjs.
 *
 * Mirrors the exports of the canonical TS resolver
 * (packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts) so that
 * TypeScript consumers (e.g. the cross-runtime parity test) can import
 * project-dir.mjs cleanly under NodeNext module resolution without
 * @ts-expect-error suppression. The .d.mts extension is the correct pairing
 * for a .mjs module under NodeNext.
 */

export type ReconcileState = 'exact' | 'reconciled' | 'anchored' | 'ambiguous' | 'miss'

export interface ResolvedProjectDir {
  encoded: string
  dir: string
  state: ReconcileState
  candidates?: string[]
}

export function findMainRepoRoot(start: string): string | null
export function encodeProjectSegment(abs: string): string
export function asciiFold(s: string): string
export function reconcileEncodedDir(computed: string): {
  encoded: string
  state: ReconcileState
  candidates?: string[]
}
export function resetProjectDirCache(): void
export function resolveTelemetryProjectDir(cwd?: string): ResolvedProjectDir
export function resolveClaudeProjectDir(cwd?: string): ResolvedProjectDir
