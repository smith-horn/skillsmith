import { readFile, writeFile, unlink, mkdir, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { minimatch } from 'minimatch'
import { VectorDb } from '@ruvector/core'
import './ruvector-types.js'
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
import { chunkDocument } from './indexer.helpers.js'
import type { IndexState } from './types.js'

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

  let chunksUpserted = 0
  let chunksDeleted = 0
  let filesScanned = 0

  if (mode === 'full') {
    const existingIds = store.entries().map((e) => e.id)
    for (const id of existingIds) {
      store.delete(id)
    }
    chunksDeleted = existingIds.length
    if (existsSync(vectorsFile)) {
      await unlink(vectorsFile)
    }
  }

  const db = new VectorDb({
    dimensions: cfg.embeddingDim,
    storagePath: vectorsFile,
    distanceMetric: 'Cosine',
  })

  const { filesToIndex, deletedFiles } = await resolveFiles(mode, root, cfg, stateAbs)

  for (const relPath of deletedFiles) {
    const removed = store.deleteByFile(relPath)
    for (const id of removed) {
      await db.delete(id)
      chunksDeleted++
    }
  }

  for (const relPath of filesToIndex) {
    const absPath = join(root, relPath)
    let raw: string
    try {
      raw = await readFile(absPath, 'utf8')
    } catch {
      continue
    }

    if (mode === 'incremental') {
      const removed = store.deleteByFile(relPath)
      for (const id of removed) {
        await db.delete(id)
        chunksDeleted++
      }
    }

    const chunks = chunkDocument(raw, relPath, cfg)
    if (chunks.length === 0) continue

    const vectors = await embedBatch(chunks.map((c) => c.text))
    const entries = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: vectors[i],
      metadata: JSON.stringify({
        file_path: chunk.filePath,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        heading_chain: chunk.headingChain,
        text: chunk.text,
      }),
    }))

    await db.insertBatch(entries)
    for (const chunk of chunks) {
      store.upsert(chunk)
      chunksUpserted++
    }
    filesScanned++
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

async function expandGlobs(patterns: string[], cwd: string): Promise<string[]> {
  let rawEntries: Dirent[]
  try {
    rawEntries = (await readdir(cwd, {
      recursive: true,
      withFileTypes: true,
    })) as unknown as Dirent[]
  } catch {
    return []
  }
  const results = new Set<string>()
  for (const entry of rawEntries) {
    if (!entry.isFile()) continue
    const relPath = relative(cwd, join(entry.parentPath, entry.name))
    for (const pattern of patterns) {
      if (minimatch(relPath, pattern, { dot: true })) {
        results.add(relPath)
        break
      }
    }
  }
  return [...results].sort()
}

async function resolveFiles(
  mode: 'full' | 'incremental',
  root: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  stateAbs: string
): Promise<{ filesToIndex: string[]; deletedFiles: string[] }> {
  if (mode === 'full') {
    return { filesToIndex: await expandGlobs(cfg.globs, root), deletedFiles: [] }
  }

  const state: IndexState | null = existsSync(stateAbs)
    ? (JSON.parse(await readFile(stateAbs, 'utf8')) as IndexState)
    : null

  const changed = state?.lastIndexedSha
    ? gitChangedFiles(root, state.lastIndexedSha)
    : await expandGlobs(cfg.globs, root)

  const allCorpusFiles = new Set(await expandGlobs(cfg.globs, root))

  const filesToIndex = changed.filter(
    (f: string) => allCorpusFiles.has(f) && existsSync(join(root, f))
  )
  const deletedFiles = changed.filter(
    (f: string) => allCorpusFiles.has(f) && !existsSync(join(root, f))
  )
  return { filesToIndex, deletedFiles }
}

function gitChangedFiles(root: string, baseSha: string): string[] {
  // Validate SHA format before interpolating into the git range argument.
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return []
  try {
    const out = execSync(`git --no-optional-locks diff --name-only ${baseSha}..HEAD`, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
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
