import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { chunkId, estimateTokens } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * `supabase-migrations` adapter (SMI-4450 Wave 1 Step 4 §S2e). Indexes
 * `<repo>/supabase/migrations/*.sql` directly from the filesystem —
 * no DB connection, no Supabase CLI.
 *
 * Target: pair 1 of the 6-pair regression set. `081_device_code_auth.sql`
 * carries the lesson about `audit_logs.user_id` column absence in its
 * SQL comment header; pre-Wave 1 that knowledge was unreachable by
 * search because migrations weren't in any corpus glob.
 *
 * Git-crypt guard (SPARC §S2e / plan-review M4):
 *   `supabase/migrations/**` is inside the git-crypt encrypted scope.
 *   If the caller hasn't run `git-crypt unlock`, the directory contents
 *   begin with the magic bytes `\0GITCRYPT`. We probe the first file's
 *   first 9 bytes; on magic-byte or non-UTF-8 content we log a warning
 *   and return `[]`. Documented limitation: adapter requires unlocked
 *   repo. Safer to skip than to index ciphertext into the vector store.
 *
 * Boundaries:
 * - In-repo reads only; repo-relative `logicalPath`.
 * - `kind: "migration"`, `lifetime: "long-term"` — migrations are
 *   immutable history and rarely rotate.
 * - No body split in Wave 1 — one chunk per file up to targetTokens;
 *   larger files emit a single truncated chunk (acceptable coverage
 *   tradeoff; finer chunking lands with the ranker in Wave 1 Step 6).
 */
export function createSupabaseMigrationsAdapter(): SourceAdapter {
  return {
    kind: 'supabase-migrations',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

const MIGRATIONS_SUBDIR = 'supabase/migrations'
const GIT_CRYPT_MAGIC = Buffer.from('\0GITCRYPT', 'utf8')
const MIN_FILE_BYTES = 64
const MIGRATION_NUMBER_PATTERN = /^(\d+)_/
const TABLE_PATTERN = /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?(\w+)/gi

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const dirAbs = join(ctx.repoRoot, MIGRATIONS_SUBDIR)
  if (!existsSync(dirAbs)) return []

  let entries: string[]
  try {
    entries = await readdir(dirAbs)
  } catch {
    return []
  }
  const sqlFiles = entries.filter((n) => n.endsWith('.sql')).sort()
  if (sqlFiles.length === 0) return []

  // Git-crypt magic-byte pre-flight on the first file only. If locked,
  // every file in the scope is locked, so one probe is enough.
  if (isLikelyEncrypted(join(dirAbs, sqlFiles[0]))) {
    console.warn(
      'supabase-migrations: first file appears encrypted (git-crypt locked); ' +
        'skipping adapter. Run `git-crypt unlock` before indexing.'
    )
    return []
  }

  const priorMs = ctx.mode === 'incremental' && ctx.lastRunAt ? Date.parse(ctx.lastRunAt) : NaN
  const useMtime = ctx.mode === 'incremental' && Number.isFinite(priorMs)

  const files: AdapterFile[] = []
  for (const name of sqlFiles) {
    const abs = join(dirAbs, name)
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

    const numMatch = name.match(MIGRATION_NUMBER_PATTERN)
    const tags: Record<string, string | number | null> = {
      source: 'supabase-migrations',
    }
    if (numMatch) tags.migration_number = Number(numMatch[1])
    const tables = extractTables(raw)
    if (tables.length > 0) tags.tables_touched = tables.join(',')

    files.push({
      logicalPath: `${MIGRATIONS_SUBDIR}/${name}`,
      rawContent: raw,
      absolutePath: abs,
      tags,
    })
  }
  return files
}

async function listDeletedPaths(): Promise<string[]> {
  // Migrations are append-only and immutable history — deletions do not
  // occur in normal operation. Returning [] is safe.
  return []
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const raw = file.rawContent
  if (raw.length === 0) return []

  const targetTokens = ctx.cfg.chunk.targetTokens
  const totalTokens = estimateTokens(raw)

  const fileBasename = basename(file.logicalPath)
  const lines = raw.split('\n')

  // Wave 1: one chunk per file, truncating to targetTokens worth of text
  // on oversize. `estimateTokens` uses a char/4 ratio, so we slice by
  // `targetTokens * 4` chars to stay under the embedding model cap.
  const text = totalTokens <= targetTokens ? raw : raw.slice(0, targetTokens * 4)
  const tokens = estimateTokens(text)
  if (tokens < ctx.cfg.chunk.minTokens) return []

  const lineStart = 1
  const lineEnd = totalTokens <= targetTokens ? lines.length : Math.max(1, text.split('\n').length)
  const id = chunkId(file.logicalPath, lineStart, lineEnd, text)

  return [
    {
      id,
      filePath: file.logicalPath,
      lineStart,
      lineEnd,
      headingChain: [fileBasename],
      text,
      tokens,
      kind: 'migration',
      lifetime: 'long-term',
      tags: file.tags,
    },
  ]
}

/**
 * Probe the first 9 bytes of `abs` for the git-crypt magic prefix.
 * Returns `true` when the file is plausibly ciphertext — either the
 * exact magic header or a non-printable byte pattern where ASCII SQL
 * would be expected. Errors reading the file also return `true` so we
 * skip the adapter rather than partial-index.
 */
export function isLikelyEncrypted(abs: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(GIT_CRYPT_MAGIC.length)
    const bytesRead = readSync(fd, buf, 0, buf.length, 0)
    if (bytesRead >= GIT_CRYPT_MAGIC.length && buf.equals(GIT_CRYPT_MAGIC)) return true
    // Heuristic: SQL files are ASCII/UTF-8; a NUL byte in the first 9
    // bytes strongly indicates ciphertext. Skip ASCII control chars
    // commonly found at end-of-line (CR, LF, TAB).
    for (let i = 0; i < bytesRead; i++) {
      const b = buf[i]
      if (b === 0x00) return true
      if (b < 0x09) return true
      if (b > 0x7e && b < 0xa0) return true
    }
    return false
  } catch {
    return true
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Ignore — we already got what we needed.
      }
    }
  }
}

function extractTables(raw: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  TABLE_PATTERN.lastIndex = 0
  while ((m = TABLE_PATTERN.exec(raw)) !== null) {
    out.add(m[1])
  }
  return [...out].sort()
}
