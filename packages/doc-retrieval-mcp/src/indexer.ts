// SMI-4426: Wave 2 Step 1 shipped `@skillsmith/doc-retrieval-mcp` as a scaffold.
// The RuVector integration is blocked pending a runtime fix. Unit tests cover
// chunker/metadata-store/config (19/19 green) but the indexer and search code
// paths have NOT been runtime-validated against `@ruvector/core@0.1.30`.
//
// Key API mismatches discovered during Wave 2 Step 6 prep:
//   - Named export is `VectorDb` (lowercase b), not `VectorDB`
//   - `VectorDb.withDimensions(n)` static factory, not `new VectorDB({...})`
//   - No `storagePath` parameter — opaque built-in persistence
//   - All methods async (return Promises)
//   - Score is distance-like (~0 = best), not cosine similarity
//   - Native binding per platform (darwin-arm64 not auto-installed locally)
//
// The original scaffold implementation (chunker wiring, git-diff incremental
// mode, VectorDB insert/delete calls) lives in git history on this branch —
// see commits before the SMI-4426 runtime guard.
//
// SMI-4426 tracks the real integration + persistence design + integration test:
//   https://linear.app/smith-horn-group/issue/SMI-4426

export interface IndexResult {
  mode: 'full' | 'incremental'
  filesScanned: number
  chunksUpserted: number
  chunksDeleted: number
  durationMs: number
}

const RUVECTOR_BLOCKED =
  'doc-retrieval: runIndexer() is blocked on SMI-4426 Wave 2 Step 2. ' +
  'Wave 2 Step 1 (types + lock helper + score transform + storagePath rename) ' +
  'shipped in d804515a. See docs/internal/implementation/smi-4426-ruvector-runtime-fix.md.'

export async function runIndexer(
  _mode: 'full' | 'incremental',
  _opts: { quiet?: boolean; configPath?: string } = {}
): Promise<IndexResult> {
  throw new Error(RUVECTOR_BLOCKED)
}
