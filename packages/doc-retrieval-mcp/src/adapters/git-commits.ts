import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { chunkId, estimateTokens } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * `git-commits` adapter (SMI-4450 Wave 1 Step 4 §S2d). Reads the last 90
 * days of non-merge commits on `main` from the local repo and emits one
 * chunk per commit combining subject + body.
 *
 * Target: pair 3 of the 6-pair regression set (SMI-4401 callback H1 +
 * overlay — the lesson lived in PR #627-class commit/PR body, not in
 * any retro or memory file). `github-pr-bodies` provides the primary
 * signal; `git-commits` provides a fallback when the local repo is
 * offline or token-less.
 *
 * Boundaries:
 * - Local `git log` only, no network.
 * - Virtual namespace: `git://<repo-basename>/commit/<sha-short>` —
 *   commits are not files on disk. Repo basename is derived from
 *   `ctx.repoRoot` (no remote lookup required).
 * - Bounded to 90 days on `main`; ranker-time work in Step 6 may
 *   tighten/widen this window per observed hit-rate.
 * - `kind: "commit"`, `lifetime: "long-term"`.
 * - Skip merge commits (`--no-merges`), dependabot unless body names
 *   an SMI, `[skip-impl-check]` docs bumps with trivial bodies.
 */
export function createGitCommitsAdapter(): SourceAdapter {
  return {
    kind: 'git-commits',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

const SINCE_WINDOW = '90 days ago'
const MIN_COMBINED_TOKENS = 32
const SMI_PATTERN = /\bSMI-(\d+)\b/
const SKIP_IMPL_MARKER = '[skip-impl-check]'

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  if (!existsSync(join(ctx.repoRoot, '.git'))) return []

  // Incremental: only look at commits newer than the prior run wall-clock
  // timestamp. Falls back to the full 90-day window in full mode or when
  // lastRunAt is unparseable.
  const since =
    ctx.mode === 'incremental' && ctx.lastRunAt && !Number.isNaN(Date.parse(ctx.lastRunAt))
      ? ctx.lastRunAt
      : SINCE_WINDOW

  const out = runGitLog(ctx.repoRoot, since)
  if (out === null) return []

  const repoName = basename(ctx.repoRoot)
  const records = parseLogOutput(out)
  const files: AdapterFile[] = []
  for (const rec of records) {
    if (shouldSkip(rec)) continue
    const short = rec.sha.slice(0, 8)
    const combined = `${rec.subject}\n\n${rec.body}`.trim()
    if (combined.length === 0) continue
    const smiMatch = combined.match(SMI_PATTERN)
    files.push({
      logicalPath: `git://${repoName}/commit/${short}`,
      rawContent: combined,
      absolutePath: null,
      tags: {
        source: 'git-commits',
        sha: short,
        committed_at: rec.isoDate,
        author: rec.author,
        ...(smiMatch ? { smi: `SMI-${smiMatch[1]}` } : {}),
      },
    })
  }
  return files
}

async function listDeletedPaths(): Promise<string[]> {
  // Commits don't get deleted from history during normal operation.
  return []
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const raw = file.rawContent
  if (raw.length === 0) return []

  const tokens = estimateTokens(raw)
  if (tokens < MIN_COMBINED_TOKENS) return []
  if (tokens < ctx.cfg.chunk.minTokens) return []

  // Bounded truncation to stay under the embedding model cap.
  const maxChars = ctx.cfg.chunk.targetTokens * 4
  const text = raw.length <= maxChars ? raw : raw.slice(0, maxChars)
  const effTokens = text === raw ? tokens : estimateTokens(text)

  const lineEnd = Math.max(1, text.split('\n').length)
  const id = chunkId(file.logicalPath, 1, lineEnd, text)
  return [
    {
      id,
      filePath: file.logicalPath,
      lineStart: 1,
      lineEnd,
      headingChain: [basename(file.logicalPath)],
      text,
      tokens: effTokens,
      kind: 'commit',
      lifetime: 'long-term',
      tags: file.tags,
    },
  ]
}

interface CommitRecord {
  sha: string
  isoDate: string
  author: string
  subject: string
  body: string
}

/**
 * Run `git log` bounded to `main` over the given `since` window. Returns
 * `null` on any git error (missing repo, detached HEAD, no main branch).
 *
 * Uses NUL-delimited fields (%x00) and record separator `\x1e` so commit
 * bodies containing arbitrary whitespace/newlines parse unambiguously.
 */
function runGitLog(cwd: string, since: string): string | null {
  try {
    return execFileSync(
      'git',
      [
        '--no-optional-locks',
        'log',
        '--no-merges',
        '--format=%H%x00%ct%x00%an%x00%s%x00%b%x1e',
        `--since=${since}`,
        'main',
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 32 * 1024 * 1024,
      }
    )
  } catch {
    return null
  }
}

/**
 * Parse the NUL/record-separator git log output. Exported for tests.
 */
export function parseLogOutput(raw: string): CommitRecord[] {
  if (raw.length === 0) return []
  const records: CommitRecord[] = []
  const chunks = raw.split('\x1e')
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\n/, '').trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split('\x00')
    if (parts.length < 5) continue
    const [sha, ct, author, subject, body] = parts
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    const ctNum = Number(ct)
    if (!Number.isFinite(ctNum)) continue
    records.push({
      sha,
      isoDate: new Date(ctNum * 1000).toISOString(),
      author,
      subject,
      body: body.trim(),
    })
  }
  return records
}

function shouldSkip(rec: CommitRecord): boolean {
  const combined = `${rec.subject}\n${rec.body}`
  const hasSmi = SMI_PATTERN.test(combined)
  if (!hasSmi && rec.author.toLowerCase().includes('dependabot')) return true
  if (!hasSmi && rec.author.toLowerCase().includes('renovate')) return true
  if (rec.body.trim().length === 0 && estimateTokens(rec.subject) < MIN_COMBINED_TOKENS) {
    return true
  }
  if (rec.subject.includes(SKIP_IMPL_MARKER) && estimateTokens(rec.body) < MIN_COMBINED_TOKENS) {
    return true
  }
  return false
}
