import { existsSync } from 'node:fs'
import { VectorDB } from '@ruvector/core'
import { loadConfig, resolveRepoPath } from './config.js'
import { MetadataStore } from './metadata-store.js'
import { embed } from './embedding.js'
import type { SearchHit } from './types.js'

export interface SearchOpts {
  query: string
  k?: number
  minScore?: number
  scopeGlobs?: string[]
  configPath?: string
}

const DEFAULT_K = 5
const DEFAULT_MIN_SCORE = 0.3

export async function search(opts: SearchOpts): Promise<SearchHit[]> {
  const cfg = await loadConfig(opts.configPath)
  const rvfAbs = resolveRepoPath(cfg.rvfPath)
  const metaAbs = resolveRepoPath(cfg.metadataPath)

  if (!existsSync(rvfAbs) || !existsSync(metaAbs)) {
    throw new Error(
      'doc-retrieval: index not built. Run: node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full'
    )
  }

  const db = new VectorDB({ dimensions: cfg.embeddingDim, storagePath: rvfAbs })
  const store = await MetadataStore.load(metaAbs)
  const vector = await embed(opts.query)

  const k = opts.k ?? DEFAULT_K
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE
  const raw = await db.search({ vector, k: Math.max(k * 4, k + 10) })

  const hits: SearchHit[] = []
  for (const r of raw) {
    const meta = store.get(r.id)
    if (!meta) continue
    if (r.score < minScore) continue
    if (opts.scopeGlobs && !matchesAny(meta.filePath, opts.scopeGlobs)) continue
    hits.push({
      id: meta.id,
      filePath: meta.filePath,
      lineStart: meta.lineStart,
      lineEnd: meta.lineEnd,
      headingChain: meta.headingChain,
      text: meta.text,
      score: r.score,
    })
    if (hits.length >= k) break
  }
  return hits
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§DOUBLESTAR§§/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
