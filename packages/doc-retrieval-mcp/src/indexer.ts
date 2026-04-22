import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { VectorDB } from '@ruvector/core'
import {
  loadConfig,
  resolveRepoPath,
  assertSafeIndexTarget,
  assertNotInCi,
  assertSubmoduleInitialized,
  type CorpusConfig,
} from './config.js'
import { chunkDocument } from './indexer.helpers.js'
import { MetadataStore } from './metadata-store.js'
import { embed } from './embedding.js'
import type { ChunkMetadata, IndexState } from './types.js'

const CORPUS_VERSION = 1

export interface IndexResult {
  mode: 'full' | 'incremental'
  filesScanned: number
  chunksUpserted: number
  chunksDeleted: number
  durationMs: number
}

export async function runIndexer(
  mode: 'full' | 'incremental',
  opts: { quiet?: boolean; configPath?: string } = {}
): Promise<IndexResult> {
  assertNotInCi()
  const started = Date.now()
  const cfg = await loadConfig(opts.configPath)
  assertSubmoduleInitialized(cfg)

  const rvfAbs = resolveRepoPath(cfg.rvfPath)
  const metaAbs = resolveRepoPath(cfg.metadataPath)
  const stateAbs = resolveRepoPath(cfg.stateFile)
  assertSafeIndexTarget(rvfAbs)
  assertSafeIndexTarget(metaAbs)
  assertSafeIndexTarget(stateAbs)

  await mkdir(dirname(rvfAbs), { recursive: true })

  const db = new VectorDB({ dimensions: cfg.embeddingDim, storagePath: rvfAbs })
  const store = await MetadataStore.load(metaAbs)
  const prevState = await loadState(stateAbs)

  const files = await resolveFiles(cfg, mode, prevState, opts)
  const deletedFiles = mode === 'incremental' ? await resolveDeletedFiles(prevState) : []

  let upserted = 0
  let deleted = 0
  for (const absPath of deletedFiles) {
    const rel = toRelPath(absPath)
    const ids = store.deleteByFile(rel)
    for (const id of ids) {
      try {
        await db.delete(id)
        deleted++
      } catch {
        // swallow — store of truth is MetadataStore, vector DB eventual consistency is fine
      }
    }
  }

  for (const absPath of files) {
    const rel = toRelPath(absPath)
    let raw: string
    try {
      raw = await readFile(absPath, 'utf8')
    } catch {
      continue
    }
    const chunks = chunkDocument(raw, rel, cfg)
    const staleIds = store.deleteByFile(rel)
    for (const id of staleIds) {
      if (!chunks.find((c) => c.id === id)) {
        try {
          await db.delete(id)
          deleted++
        } catch {
          /* tolerate */
        }
      }
    }
    for (const chunk of chunks) {
      const vector = await embed(chunk.text)
      await db.insert({ id: chunk.id, vector })
      store.upsert(chunk)
      upserted++
    }
  }

  await store.flush()
  const nextState: IndexState = {
    lastIndexedSha: await gitHeadSha(),
    chunkCountByFile: buildCountMap(store.entries()),
    lastRunAt: new Date().toISOString(),
    corpusVersion: CORPUS_VERSION,
  }
  await saveState(stateAbs, nextState)

  const result: IndexResult = {
    mode,
    filesScanned: files.length,
    chunksUpserted: upserted,
    chunksDeleted: deleted,
    durationMs: Date.now() - started,
  }
  if (!opts.quiet) {
    console.log(
      `[doc-retrieval] ${mode}: files=${result.filesScanned} upserted=${result.chunksUpserted} deleted=${result.chunksDeleted} dur=${result.durationMs}ms`
    )
  }
  return result
}

async function resolveFiles(
  cfg: CorpusConfig,
  mode: 'full' | 'incremental',
  prev: IndexState | null,
  opts: { quiet?: boolean }
): Promise<string[]> {
  if (mode === 'full' || !prev?.lastIndexedSha) {
    return globCorpus(cfg)
  }
  const changed = changedMarkdownSince(prev.lastIndexedSha)
  if (changed === null) {
    if (!opts.quiet) {
      console.warn('[doc-retrieval] git diff unavailable; falling back to full scan')
    }
    return globCorpus(cfg)
  }
  const all = new Set(await globCorpus(cfg))
  return changed.filter((p) => all.has(p))
}

async function resolveDeletedFiles(prev: IndexState | null): Promise<string[]> {
  if (!prev?.lastIndexedSha) return []
  const deleted = deletedMarkdownSince(prev.lastIndexedSha)
  if (deleted === null) return []
  return deleted
}

async function globCorpus(cfg: CorpusConfig): Promise<string[]> {
  const { glob } = await import('glob')
  const out = new Set<string>()
  for (const pattern of cfg.globs) {
    const matches = await glob(pattern, {
      cwd: resolveRepoPath(''),
      absolute: true,
      nodir: true,
      dot: false,
    })
    for (const m of matches) out.add(m)
  }
  return [...out].sort()
}

function changedMarkdownSince(sha: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      [
        '--no-optional-locks',
        'diff',
        '--name-only',
        '--diff-filter=AM',
        `${sha}..HEAD`,
        '--',
        '**/*.md',
      ],
      {
        cwd: resolveRepoPath(''),
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }
    )
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => join(resolveRepoPath(''), p))
  } catch {
    return null
  }
}

function deletedMarkdownSince(sha: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      [
        '--no-optional-locks',
        'diff',
        '--name-only',
        '--diff-filter=D',
        `${sha}..HEAD`,
        '--',
        '**/*.md',
      ],
      {
        cwd: resolveRepoPath(''),
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }
    )
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => join(resolveRepoPath(''), p))
  } catch {
    return null
  }
}

async function gitHeadSha(): Promise<string | null> {
  try {
    return execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
      cwd: resolveRepoPath(''),
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()
  } catch {
    return null
  }
}

function buildCountMap(entries: ChunkMetadata[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) out[e.filePath] = (out[e.filePath] ?? 0) + 1
  return out
}

async function loadState(path: string): Promise<IndexState | null> {
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as IndexState
    if (parsed.corpusVersion !== CORPUS_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

async function saveState(path: string, state: IndexState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
}

function toRelPath(abs: string): string {
  const root = resolveRepoPath('')
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1)
  return abs
}
