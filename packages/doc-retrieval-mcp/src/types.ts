export interface ChunkMetadata {
  id: string
  filePath: string
  lineStart: number
  lineEnd: number
  headingChain: string[]
  text: string
  tokens: number
}

export interface ChunkWithVector extends ChunkMetadata {
  vector: Float32Array
}

export interface IndexState {
  lastIndexedSha: string | null
  chunkCountByFile: Record<string, number>
  lastRunAt: string
  corpusVersion: number
}

export interface SearchHit {
  id: string
  filePath: string
  lineStart: number
  lineEnd: number
  headingChain: string[]
  text: string
  /**
   * Cosine similarity in [0, 1], 1 = best match. Computed from the native
   * binding's raw distance via `distanceToSimilarity` (SMI-4426).
   */
  similarity: number
  /**
   * @deprecated Alias for `similarity`. Removal tracked in the follow-up SMI
   * filed under SMI-4426 Wave 1 Step 3 (plan-review amendment E). Equals
   * `similarity` by construction — PR #722 emitted raw distance here and the
   * alias corrects it rather than preserving the mistake.
   */
  score: number
}

export interface StatusInfo {
  chunkCount: number
  fileCount: number
  lastIndexedSha: string | null
  lastRunAt: string | null
  /** Absolute path to the RuVector storage directory (SMI-4426 rename from `rvfPath`). */
  storagePath: string
  corpusVersion: number
}
