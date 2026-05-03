import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, join } from 'node:path'

import { chunkBlocks, chunkId, estimateTokens, parseMarkdown } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * `memory-topic-files` adapter (SMI-4450 Wave 1 Step 4 §S2a). Indexes
 * `~/.claude/projects/<cwd-encoded>/memory/*.md` — the per-project auto
 * memory directory that survives across Claude Code sessions.
 *
 * This adapter is the primary lever for recovering the 6-pair regression
 * set: pairs 1, 2, and 6 fail today because the relevant lesson files live
 * outside the repo and therefore outside the Phase-1 corpus.
 *
 * Boundaries:
 * - Out-of-repo: absolute reads under `$HOME/.claude/projects/...`.
 * - Virtual namespace: `memory://<username>/<basename>` — repo-relative
 *   paths are not meaningful here, and `ChunkMetadata.filePath` is used
 *   as an opaque MetadataStore key, so we keep the store keyed by a
 *   stable URI rather than an absolute host path that would leak
 *   `$HOME` into persisted state.
 * - Short-term lifetime: these files rotate (MEMORY.md in particular
 *   churns fast) and future ranking passes should weight them below
 *   canonical long-term sources.
 * - Multi-user guard: if the current `os.userInfo().username` differs
 *   from the username baked into `memory://<user>/` virtual keys from
 *   a prior run on the same machine, we still only read our own
 *   `~/.claude` directory — adapter never crosses user home boundaries.
 */
export function createMemoryTopicFilesAdapter(): SourceAdapter {
  return {
    kind: 'memory-topic-files',
    lifetime: 'short-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

const MIN_FILE_BYTES = 32
const SMI_PATTERN = /\bSMI-(\d+)\b/

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const dir = resolveMemoryDir(ctx.repoRoot)
  if (dir === null) return []
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const user = userInfo().username
  const selected = entries.filter(isIndexable)

  const prior = ctx.mode === 'incremental' ? ctx.lastRunAt : null
  const priorMs = prior ? Date.parse(prior) : NaN
  const useMtime = ctx.mode === 'incremental' && Number.isFinite(priorMs)

  const files: AdapterFile[] = []
  for (const name of selected) {
    const abs = join(dir, name)
    let raw: string
    try {
      if (useMtime) {
        const st = statSync(abs)
        if (st.mtimeMs <= priorMs) continue
      }
      raw = await readFile(abs, 'utf8')
    } catch {
      continue
    }
    if (Buffer.byteLength(raw, 'utf8') < MIN_FILE_BYTES) continue

    const smiMatch = raw.match(SMI_PATTERN)
    files.push({
      logicalPath: `memory://${user}/${name}`,
      rawContent: raw,
      absolutePath: abs,
      tags: {
        source: 'memory-topic-files',
        user,
        ...(smiMatch ? { smi: `SMI-${smiMatch[1]}` } : {}),
      },
    })
  }
  return files
}

async function listDeletedPaths(ctx: AdapterContext): Promise<string[]> {
  // Deletion detection for memory files is not implemented in Wave 1:
  // full-mode re-index rebuilds from scratch anyway, and incremental runs
  // accept stale entries until the next full re-index. Returning `[]`
  // matches the SPARC §S2a edge-case note (c): adapters without a cheap
  // delete oracle never infer deletes.
  void ctx
  return []
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const raw = file.rawContent
  if (raw.length === 0) return []

  const totalTokens = estimateTokens(raw)
  const chunkCfg = ctx.cfg.chunk
  const fileBasename = basename(file.logicalPath)

  let chunks: ChunkMetadata[]
  if (totalTokens <= chunkCfg.targetTokens) {
    chunks = [wholeFileChunk(file, raw, totalTokens, fileBasename)]
  } else {
    const blocks = parseMarkdown(raw)
    const withPrefix = blocks.map((b) => ({
      ...b,
      headingChain: [fileBasename, ...b.headingChain],
    }))
    chunks = chunkBlocks(withPrefix, file.logicalPath, chunkCfg).map((c) => ({
      ...c,
      kind: 'memory',
      lifetime: 'short-term' as const,
    }))
  }

  // SMI-4450 M3: `kind` and `lifetime` are now set at the chunk
  // construction sites above — both `wholeFileChunk` and the
  // chunkBlocks map — so the mapper here only merges tags.
  const baseTags = file.tags ?? {}
  const cls = classifyByFilename(fileBasename)
  return chunks.map((c) => ({
    ...c,
    tags: { ...baseTags, ...(c.tags ?? {}) },
    ...(cls ? { class: cls } : {}),
  }))
}

/**
 * Map auto-memory filename prefixes to the `class` array consumed by
 * `rerank.ts` per-class boost (SMI-4485 / SMI-4468). Filename convention
 * is set by the auto-memory system in CLAUDE.md: `feedback_*.md`,
 * `project_*.md`, `template_*.md`, plus topic-shape names. Only the
 * unambiguous prefixes get classified here; everything else stays
 * unclassified (boost factor 1.0).
 */
export function classifyByFilename(fileBasename: string): string[] | null {
  if (fileBasename.startsWith('feedback_')) return ['feedback']
  if (fileBasename.startsWith('project_')) return ['project']
  return null
}

function wholeFileChunk(
  file: AdapterFile,
  raw: string,
  tokens: number,
  fileBasename: string
): ChunkMetadata {
  const lines = raw.split('\n')
  const lineEnd = lines.length
  return {
    id: chunkId(file.logicalPath, 1, lineEnd, raw),
    filePath: file.logicalPath,
    lineStart: 1,
    lineEnd,
    headingChain: [fileBasename],
    text: raw,
    tokens,
    // SMI-4450 M3: kind/lifetime set here directly so this chunk is
    // fully formed without depending on a downstream mapper step.
    kind: 'memory',
    lifetime: 'short-term',
  }
}

function isIndexable(name: string): boolean {
  if (!name.endsWith('.md')) return false
  if (name === 'MEMORY.md') return false
  if (name.includes('.backup-')) return false
  return true
}

/**
 * Resolve the memory directory the adapter should index.
 *
 * SMI-4677 contract change: two paths.
 *
 * 1. **Override path** — if `process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE` is
 *    set and non-empty, return it verbatim. No encoding, no fallback. This
 *    is how Docker-bound contributors point the adapter at the host's
 *    user-scope memory dir (the container's `homedir()` is `/root`, which
 *    has no `.claude/projects/` and no encoded match for the host path).
 *    Empty/whitespace value falls through to the derivation path so a
 *    contributor explicitly clearing the var doesn't accidentally bypass
 *    the encoded fallback.
 * 2. **Derivation path** — derive `~/.claude/projects/<encoded-cwd>/memory/`
 *    from `cwd`. Encoding per Claude Code harness: replace `/` with `-`,
 *    drop the leading `-`. Documented in SPARC §S2a L2 — if the directory
 *    derives cleanly but doesn't exist on disk, return `null` (soft skip);
 *    we do NOT throw on encoding-drift here because the adapter runs inside
 *    the indexer's per-adapter try-free loop and a throw would abort the
 *    full ingest run. The SPARC note's "throw on encoding drift" intent is
 *    preserved via the roundtrip unit test instead.
 */
export function resolveMemoryDir(cwd: string): string | null {
  // SMI-4677 §S0 override path. Explicit length check (not truthiness) per
  // plan-review E3: a contributor who exports an empty SKILLSMITH_MEMORY_DIR_OVERRIDE
  // should fall through to the derivation path, not get null-routed early.
  const override = process.env.SKILLSMITH_MEMORY_DIR_OVERRIDE
  if (typeof override === 'string' && override.length > 0) {
    return override
  }
  if (!cwd || cwd[0] !== '/') return null
  const encoded = '-' + cwd.slice(1).replace(/\//g, '-')
  const home = homedir()
  if (!home) return null
  return join(home, '.claude', 'projects', encoded, 'memory')
}
