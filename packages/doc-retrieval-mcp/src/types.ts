export interface ChunkMetadata {
  id: string
  filePath: string
  lineStart: number
  lineEnd: number
  headingChain: string[]
  text: string
  tokens: number
  /**
   * Adapter-assigned classification (SMI-4450 Wave 1 Step 4). Legacy markdown
   * chunks omit this field; registry callers default to `'markdown-doc'`.
   */
  kind?: string
  /**
   * Adapter-assigned lifetime hint used by future ranking passes to weight
   * short-term memory against long-term canonical sources.
   */
  lifetime?: 'short-term' | 'long-term'
  /**
   * Free-form adapter-specific tags (e.g. `smi`, `pr`, `script_type`). Stored
   * verbatim inside the VectorDb metadata JSON blob (no schema change).
   */
  tags?: Record<string, string | number | null>
}

export interface ChunkWithVector extends ChunkMetadata {
  vector: Float32Array
}

/**
 * Shape of the JSON blob stored inside each `VectorDb` chunk's `metadata`
 * field (SMI-4450 plan-review C3). The indexer produces this via
 * `JSON.stringify(...)` and `search.ts` parses it back out; exporting the
 * shape here lets callers type-check `SearchHit.meta` without depending on
 * the indexer internals.
 *
 * Fields beyond the core five (`file_path`, `line_start`, `line_end`,
 * `heading_chain`, `text`) are optional adapter-sourced tags.
 */
export interface ChunkStoredMetadata {
  file_path: string
  line_start: number
  line_end: number
  heading_chain: string[]
  text: string
  kind?: string
  lifetime?: 'short-term' | 'long-term'
  tags?: Record<string, string | number | null>
  /**
   * Frontmatter-derived ranking signals (SMI-4450 Wave 1 Step 6 — plan-review C3).
   * Read by `rerank.ts` to apply absorption / supersession penalties. Optional
   * because Wave 1 adapters do not yet stamp them — Wave 2 absorption tracker
   * populates `absorbed_by`. Field shape matches the retro frontmatter schema
   * defined in `scripts/lib/retro-frontmatter.mjs`.
   */
  smi?: string
  class?: string[]
  absorbed_by?: string
  supersedes?: string
  source?: string
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
  /**
   * Full metadata blob returned by the adapter that produced this chunk
   * (SMI-4450 Wave 1 Step 4 — plan-review C3). Populated by `search()` for
   * downstream rankers/tooling that need adapter-sourced `kind`, `lifetime`,
   * or `tags` without a second DB round-trip.
   */
  meta?: ChunkStoredMetadata
}

/**
 * Opaque config entry for per-adapter options read from
 * `corpus.config.json.adapters[]`. The `kind` discriminator is the adapter
 * registry key; the rest of the fields are adapter-specific and validated
 * inside each adapter's `listFiles()`.
 */
export interface AdapterConfig {
  kind: string
  enabled?: boolean
  [opt: string]: unknown
}

/**
 * Normalised in-memory shape produced by `SourceAdapter.listFiles()`. The
 * adapter hands these off to its own `chunk()` method; the indexer never
 * reads `rawContent` directly.
 *
 * `logicalPath` is the string that lands in `ChunkMetadata.filePath` and is
 * used as the MetadataStore key. For out-of-repo adapters it is a virtual
 * namespace URI (e.g. `memory://<user>/<basename>`) per SPARC §S2.
 */
export interface AdapterFile {
  logicalPath: string
  rawContent: string
  /**
   * Absolute on-disk path when the adapter reads from the filesystem; `null`
   * when the source is synthetic (PR bodies, commit messages). Used only for
   * mtime checks inside the adapter.
   */
  absolutePath: string | null
  tags?: Record<string, string | number | null>
}

/**
 * Pluggable source interface (SMI-4450 Wave 1 Step 4). Adapters are iterated
 * sequentially by the indexer and feed the same embed → upsert pipeline.
 *
 * Each adapter handles its own incremental-filter logic internally (git-diff
 * for markdown/migrations, mtime for memory files, cache-cursor for PR
 * bodies, `git log --since` for commits). The indexer is deliberately
 * unaware of per-adapter change oracles.
 *
 * Return contract: `listFiles(ctx)` MUST return only files the indexer
 * should (re-)index this run. `rawContent` may be empty-string when the
 * adapter wants `chunk()` to read lazily from `absolutePath` (markdown
 * default); otherwise populated eagerly.
 *
 * `listDeletedPaths(ctx)` returns `logicalPath`s that no longer exist and
 * should be pruned from MetadataStore (covers the current `deletedFiles`
 * branch of the markdown path). Adapters without a delete oracle return
 * `[]` — the indexer never infers deletes.
 */
export interface SourceAdapter {
  readonly kind: string
  readonly lifetime: 'short-term' | 'long-term'
  listFiles(ctx: AdapterContext): Promise<AdapterFile[]>
  listDeletedPaths(ctx: AdapterContext): Promise<string[]>
  chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]>
}

export interface AdapterContext {
  repoRoot: string
  cfg: import('./config.js').CorpusConfig
  adapterCfg?: AdapterConfig
  mode: 'full' | 'incremental'
  lastSha: string | null
  lastRunAt: string | null
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
