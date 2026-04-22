import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChunkConfig {
  targetTokens: number
  overlapTokens: number
  minTokens: number
}

export interface CorpusConfig {
  rvfPath: string
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
  if (!c.rvfPath || !c.metadataPath || !c.stateFile) {
    throw new Error('corpus.config.json: rvfPath, metadataPath, stateFile are required')
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
