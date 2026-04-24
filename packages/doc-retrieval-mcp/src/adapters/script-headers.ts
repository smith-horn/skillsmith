import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

import { chunkId, estimateTokens } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * `script-headers` adapter (SMI-4450 Wave 1 Step 4 §S2b). Indexes the
 * contiguous leading comment block of files under `<repo>/scripts/` and
 * `<repo>/.husky/` — e.g. `pooler-psql.sh`, `sync-main.sh`, the husky
 * dispatch stubs.
 *
 * Target: pair 5 of the 6-pair regression set (pooler password URL
 * parsing). The canonical lesson lives in the script header, not in a
 * retro or memory file; Phase 1 missed it because `scripts/**` was not
 * in the corpus globs.
 *
 * Boundaries:
 * - In-repo reads only; repo-relative `logicalPath` (no virtual key).
 * - `kind: "script"`, `lifetime: "long-term"` — script headers rotate
 *   rarely and carry durable rationale.
 * - One chunk per file max. No body content indexed — the comment
 *   header is the "why"; implementation is the "what".
 * - Skip node_modules, <200-byte files, `// @generated` markers,
 *   shebang-only headers.
 */
export function createScriptHeadersAdapter(): SourceAdapter {
  return {
    kind: 'script-headers',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

const EXT_PATTERN = /\.(sh|mjs|ts|js|bash)$/
const MIN_FILE_BYTES = 200
const MIN_HEADER_TOKENS = 32
const SCAN_DIRS = ['scripts', '.husky'] as const
const GENERATED_MARKER = '@generated'

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const files: AdapterFile[] = []
  const priorMs = ctx.mode === 'incremental' && ctx.lastRunAt ? Date.parse(ctx.lastRunAt) : NaN
  const useMtime = ctx.mode === 'incremental' && Number.isFinite(priorMs)

  for (const dirRel of SCAN_DIRS) {
    const dirAbs = join(ctx.repoRoot, dirRel)
    if (!existsSync(dirAbs)) continue

    let entries: Dirent[]
    try {
      entries = (await readdir(dirAbs, { recursive: true, withFileTypes: true })) as Dirent[]
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue

      const abs = join(entry.parentPath, entry.name)
      const rel = relative(ctx.repoRoot, abs)
      if (rel.split(sep).includes('node_modules')) continue

      // `.husky/` hooks (pre-commit, pre-push, etc.) are extensionless
      // by convention — accept them as-is; otherwise require a known
      // scripting extension.
      const inHusky = rel.split(sep)[0] === '.husky'
      if (!inHusky && !EXT_PATTERN.test(entry.name)) continue

      try {
        const st = statSync(abs)
        if (st.size < MIN_FILE_BYTES) continue
        if (useMtime && st.mtimeMs <= priorMs) continue
      } catch {
        continue
      }

      let raw: string
      try {
        raw = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      if (raw.includes(GENERATED_MARKER)) continue

      files.push({
        logicalPath: rel.split(sep).join('/'),
        rawContent: raw,
        absolutePath: abs,
        tags: {
          source: 'script-headers',
          script_type: classifyScript(rel),
        },
      })
    }
  }
  return files
}

async function listDeletedPaths(): Promise<string[]> {
  // No delete oracle in Wave 1 — full re-index prunes stale entries.
  return []
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const header = extractHeader(file.rawContent)
  if (header === null) return []

  const tokens = estimateTokens(header.text)
  if (tokens < MIN_HEADER_TOKENS) return []
  if (tokens < ctx.cfg.chunk.minTokens) return []

  const fileBasename = basename(file.logicalPath)
  const id = chunkId(file.logicalPath, header.startLine, header.endLine, header.text)

  return [
    {
      id,
      filePath: file.logicalPath,
      lineStart: header.startLine,
      lineEnd: header.endLine,
      headingChain: [fileBasename],
      text: header.text,
      tokens,
      kind: 'script',
      lifetime: 'long-term',
      tags: file.tags,
    },
  ]
}

interface Header {
  text: string
  startLine: number
  endLine: number
}

/**
 * Extract the contiguous leading comment block from a script. Skips an
 * optional shebang line. Stops at the first non-comment, non-blank line.
 * Comment markers (hash, double-slash, slash-star, star-slash, asterisk)
 * are stripped from each line of the returned text so the embedded
 * content is natural prose.
 *
 * Returns `null` when no header is present or the header is empty after
 * stripping.
 */
export function extractHeader(raw: string): Header | null {
  const lines = raw.split('\n')
  let i = 0
  if (lines[0]?.startsWith('#!')) i = 1

  // Skip leading blank lines between shebang and header.
  while (i < lines.length && lines[i].trim() === '') i++

  const startLine = i + 1
  let inBlockComment = false
  const out: string[] = []

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        const cleaned = stripBlockInner(trimmed.replace(/\*\/.*$/, ''))
        if (cleaned) out.push(cleaned)
        inBlockComment = false
        i++
        break
      }
      const cleaned = stripBlockInner(trimmed)
      if (cleaned) out.push(cleaned)
      i++
      continue
    }

    if (trimmed === '') {
      // Blank line inside header: accept as paragraph break, but only if
      // we've already captured something — otherwise advance startLine.
      if (out.length === 0) {
        i++
        continue
      }
      out.push('')
      i++
      continue
    }

    if (trimmed.startsWith('//')) {
      out.push(trimmed.replace(/^\/\/\s?/, ''))
      i++
      continue
    }
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
      out.push(trimmed.replace(/^#+\s?/, ''))
      i++
      continue
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = true
      const inner = trimmed.replace(/^\/\*+\s?/, '')
      if (inner.includes('*/')) {
        // Single-line /* ... */ block.
        const closed = stripBlockInner(inner.replace(/\*\/.*$/, ''))
        if (closed) out.push(closed)
        inBlockComment = false
      } else {
        const cleaned = stripBlockInner(inner)
        if (cleaned) out.push(cleaned)
      }
      i++
      continue
    }

    break
  }

  const endLine = Math.max(startLine, i)
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  const text = out.join('\n').trim()
  if (text.length === 0) return null
  return { text, startLine, endLine }
}

function stripBlockInner(line: string): string {
  return line.replace(/^\*+\s?/, '').trim()
}

function classifyScript(rel: string): string {
  const normalized = rel.split(sep).join('/')
  if (normalized.startsWith('.husky/')) return 'hook'
  if (normalized.startsWith('scripts/tests/')) return 'test'
  if (normalized.startsWith('scripts/')) return 'utility'
  return 'other'
}
