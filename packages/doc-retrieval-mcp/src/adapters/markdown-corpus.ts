import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { minimatch } from 'minimatch'

import { chunkDocument } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * The legacy markdown corpus behaviour extracted as a `SourceAdapter`
 * (SMI-4450 Wave 1 Step 4). Preserves the prior `indexer.ts` semantics
 * verbatim: glob expansion, git-diff incremental path, and lazy per-file
 * content read inside `chunk()`.
 *
 * This is the default adapter — a corpus with no `adapters: []` config
 * still gets the markdown-corpus path wired in by the registry.
 */
export function createMarkdownCorpusAdapter(): SourceAdapter {
  return {
    kind: 'markdown-corpus',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const all = new Set(await expandGlobs(ctx.cfg.globs, ctx.repoRoot))

  if (ctx.mode === 'full') {
    return [...all].sort().map((rel) => toAdapterFile(rel, ctx.repoRoot))
  }

  const changed = ctx.lastSha ? gitChangedFiles(ctx.repoRoot, ctx.lastSha) : [...all]

  return changed
    .filter((rel) => all.has(rel) && existsSync(join(ctx.repoRoot, rel)))
    .map((rel) => toAdapterFile(rel, ctx.repoRoot))
}

async function listDeletedPaths(ctx: AdapterContext): Promise<string[]> {
  if (ctx.mode === 'full') return []
  if (!ctx.lastSha) return []

  const all = new Set(await expandGlobs(ctx.cfg.globs, ctx.repoRoot))
  const changed = gitChangedFiles(ctx.repoRoot, ctx.lastSha)
  return changed.filter((rel) => all.has(rel) && !existsSync(join(ctx.repoRoot, rel)))
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const abs = file.absolutePath ?? join(ctx.repoRoot, file.logicalPath)
  let raw: string
  try {
    raw = file.rawContent.length > 0 ? file.rawContent : await readFile(abs, 'utf8')
  } catch {
    return []
  }
  const chunks = chunkDocument(raw, file.logicalPath, ctx.cfg)
  return chunks.map((c) => ({ ...c, kind: 'markdown-doc', lifetime: 'long-term' as const }))
}

function toAdapterFile(rel: string, root: string): AdapterFile {
  return {
    logicalPath: rel,
    rawContent: '',
    absolutePath: join(root, rel),
  }
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

function gitChangedFiles(root: string, baseSha: string): string[] {
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
