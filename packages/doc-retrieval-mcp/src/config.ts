import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Default similarity threshold for skill_docs_search results.
 *
 * ADR-117 band table (post-distance→similarity transform, [0, 1], 1 = best):
 *   <0.20        noise
 *   0.20 - 0.35  weak
 *   0.35 - 0.55  loose
 *   0.55 - 0.75  strong
 *   >0.75        near-duplicate
 *
 * 0.35 mirrors the ADR recommendation. Wave 2 Step 6 token-delta harness
 * will empirically validate before lock-in; tuning changes land here in
 * one place (plan-review amendment I).
 */
export const DEFAULT_MIN_SIMILARITY = 0.35

export interface ChunkConfig {
  targetTokens: number
  overlapTokens: number
  minTokens: number
}

export interface CorpusConfig {
  /**
   * Directory where @ruvector/core writes `collections/`, `vectors.db`
   * (redb KV), `metadata.json`, `aliases.json`, and `<basename>.hnsw.*` dumps.
   * Renamed from `rvfPath` under SMI-4426 — the binding persists a directory
   * tree, not a single `.rvf` file.
   */
  storagePath: string
  metadataPath: string
  stateFile: string
  embeddingDim: number
  chunk: ChunkConfig
  globs: string[]
  requireSubmodule?: string
}

let cached: CorpusConfig | null = null

export async function loadConfig(configPath?: string): Promise<CorpusConfig> {
  if (cached && !configPath) return cached
  const path = configPath ?? defaultConfigPath()
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as CorpusConfig
  validate(parsed)
  cached = parsed
  return parsed
}

export function resetConfigCache(): void {
  cached = null
}

function defaultConfigPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return resolve(here, 'corpus.config.json')
}

function validate(c: CorpusConfig): void {
  if (!c.storagePath || !c.metadataPath || !c.stateFile) {
    throw new Error('corpus.config.json: storagePath, metadataPath, stateFile are required')
  }
  if (c.embeddingDim !== 384) {
    throw new Error(
      `corpus.config.json: embeddingDim must be 384 (Xenova/all-MiniLM-L6-v2 fixed dim); got ${c.embeddingDim}`
    )
  }
  if (c.chunk.targetTokens < c.chunk.minTokens) {
    throw new Error('corpus.config.json: chunk.targetTokens must be >= chunk.minTokens')
  }
  if (!Array.isArray(c.globs) || c.globs.length === 0) {
    throw new Error('corpus.config.json: globs must be a non-empty array')
  }
}

export function repoRoot(): string {
  const env = process.env.SKILLSMITH_REPO_ROOT
  if (env) return resolve(env)
  return process.cwd()
}

export function resolveRepoPath(rel: string): string {
  return join(repoRoot(), rel)
}

export function assertSafeIndexTarget(absolutePath: string): void {
  const root = repoRoot()
  const resolved = resolve(absolutePath)
  if (!resolved.startsWith(join(root, '.ruvector'))) {
    throw new Error(
      `Refusing to write outside $REPO_ROOT/.ruvector: ${resolved}. Safety boundary enforced.`
    )
  }
}

export function assertNotInCi(): void {
  if (process.env.CI === 'true' || process.env.SKILLSMITH_CI === 'true') {
    throw new Error(
      'doc-retrieval-mcp: refusing to run in CI (CI=true or SKILLSMITH_CI=true). The .rvf is local-only and must not be built in CI artifacts.'
    )
  }
}

export function assertSubmoduleInitialized(cfg: CorpusConfig): void {
  if (!cfg.requireSubmodule) return
  const submodulePath = resolveRepoPath(cfg.requireSubmodule)
  const sentinel = join(submodulePath, 'index.md')
  if (!existsSync(sentinel)) {
    throw new Error(
      `doc-retrieval-mcp: required submodule '${cfg.requireSubmodule}' is not initialized (missing ${cfg.requireSubmodule}/index.md). Run: git submodule update --init. Refusing partial index to avoid silently omitting private content.`
    )
  }
}
