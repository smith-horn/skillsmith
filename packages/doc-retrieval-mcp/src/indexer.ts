import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import './ruvector-types.js'
// @ruvector/core is CJS; ESM named imports fail at runtime in Node.js v22.
// Use createRequire so the module.exports object is accessible as-is.
const { VectorDb } = createRequire(import.meta.url)(
  '@ruvector/core'
) as typeof import('@ruvector/core')
import {
  loadConfig,
  resolveRepoPath,
  repoRoot,
  assertNotInCi,
  assertSafeIndexTarget,
  assertSubmoduleInitialized,
} from './config.js'
import { acquireIndexerLock } from './indexer-lock.js'
import { MetadataStore } from './metadata-store.js'
import { embedBatch } from './embedding.js'
import { buildRegistry } from './adapters/index.js'
import type { AdapterContext, ChunkMetadata, IndexState, SourceAdapter } from './types.js'

export interface IndexResult {
  mode: 'full' | 'incremental'
  filesScanned: number
  chunksUpserted: number
  chunksDeleted: number
  durationMs: number
}

const CORPUS_VERSION = 1

export async function runIndexer(
  mode: 'full' | 'incremental',
  opts: { quiet?: boolean; configPath?: string } = {}
): Promise<IndexResult> {
  assertNotInCi()
  const t0 = Date.now()

  const cfg = await loadConfig(opts.configPath)
  const storageAbs = resolveRepoPath(cfg.storagePath)
  const metaAbs = resolveRepoPath(cfg.metadataPath)
  const stateAbs = resolveRepoPath(cfg.stateFile)
  const vectorsFile = join(storageAbs, 'vectors')

  assertSafeIndexTarget(storageAbs)
  assertSubmoduleInitialized(cfg)

  const release = await acquireIndexerLock(storageAbs)
  try {
    return await doIndex(mode, { storageAbs, metaAbs, stateAbs, vectorsFile, cfg, t0 })
  } finally {
    release()
  }
}

interface IndexContext {
  storageAbs: string
  metaAbs: string
  stateAbs: string
  vectorsFile: string
  cfg: Awaited<ReturnType<typeof loadConfig>>
  t0: number
}

async function doIndex(mode: 'full' | 'incremental', ctx: IndexContext): Promise<IndexResult> {
  const { metaAbs, stateAbs, vectorsFile, cfg, t0 } = ctx
  const root = repoRoot()
  const store = await MetadataStore.load(metaAbs)

  const prior: IndexState | null =
    mode === 'incremental' && existsSync(stateAbs)
      ? (JSON.parse(await readFile(stateAbs, 'utf8')) as IndexState)
      : null

  let chunksUpserted = 0
  let chunksDeleted = 0
  let filesScanned = 0

  if (mode === 'full') {
    const existingIds = store.entries().map((e) => e.id)
    for (const id of existingIds) store.delete(id)
    chunksDeleted = existingIds.length
    if (existsSync(vectorsFile)) await unlink(vectorsFile)
  }

  const db = new VectorDb({
    dimensions: cfg.embeddingDim,
    storagePath: vectorsFile,
    distanceMetric: 'Cosine',
  })

  const adapters = buildRegistry(cfg)

  for (const adapter of adapters) {
    const adapterCtx: AdapterContext = {
      repoRoot: root,
      cfg,
      adapterCfg: cfg.adapters?.find((a) => a.kind === adapter.kind),
      mode,
      lastSha: prior?.lastIndexedSha ?? null,
      lastRunAt: prior?.lastRunAt ?? null,
    }

    // Prune deletions first so re-inserts in listFiles don't collide with
    // stale ids for the same logicalPath.
    const deletedPaths = await adapter.listDeletedPaths(adapterCtx)
    for (const logicalPath of deletedPaths) {
      const removed = store.deleteByFile(logicalPath)
      for (const id of removed) {
        await db.delete(id)
        chunksDeleted++
      }
    }

    const files = await adapter.listFiles(adapterCtx)
    for (const file of files) {
      if (mode === 'incremental') {
        const removed = store.deleteByFile(file.logicalPath)
        for (const id of removed) {
          await db.delete(id)
          chunksDeleted++
        }
      }

      const chunks = await adapter.chunk(file, adapterCtx)
      if (chunks.length === 0) continue

      const counts = await upsertChunks(db, store, chunks, adapter)
      chunksUpserted += counts
      filesScanned++
    }
  }

  await store.flush()

  const state: IndexState = {
    lastIndexedSha: currentGitSha(root),
    chunkCountByFile: buildChunkCountByFile(store),
    lastRunAt: new Date().toISOString(),
    corpusVersion: CORPUS_VERSION,
  }
  await mkdir(join(root, '.ruvector'), { recursive: true })
  await writeFile(stateAbs, JSON.stringify(state, null, 2), 'utf8')

  return { mode, filesScanned, chunksUpserted, chunksDeleted, durationMs: Date.now() - t0 }
}

async function upsertChunks(
  db: InstanceType<typeof VectorDb>,
  store: MetadataStore,
  chunks: ChunkMetadata[],
  adapter: SourceAdapter
): Promise<number> {
  const vectors = await embedBatch(chunks.map((c) => c.text))
  const entries = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: vectors[i],
    metadata: JSON.stringify(buildStoredMetadata(chunk, adapter)),
  }))
  await db.insertBatch(entries)
  for (const chunk of chunks) store.upsert(chunk)
  return chunks.length
}

function buildStoredMetadata(
  chunk: ChunkMetadata,
  adapter: SourceAdapter
): Record<string, unknown> {
  const blob: Record<string, unknown> = {
    file_path: chunk.filePath,
    line_start: chunk.lineStart,
    line_end: chunk.lineEnd,
    heading_chain: chunk.headingChain,
    text: chunk.text,
  }
  const kind = chunk.kind ?? adapter.kind
  if (kind) blob.kind = kind
  const lifetime = chunk.lifetime ?? adapter.lifetime
  if (lifetime) blob.lifetime = lifetime
  if (chunk.tags && Object.keys(chunk.tags).length > 0) blob.tags = chunk.tags
  return blob
}

function currentGitSha(root: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()
  } catch {
    return null
  }
}

function buildChunkCountByFile(store: MetadataStore): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of store.entries()) {
    counts[entry.filePath] = (counts[entry.filePath] ?? 0) + 1
  }
  return counts
}
