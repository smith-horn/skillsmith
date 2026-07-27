/**
 * SMI-5793 — split out of `session-priming-query.ts` per this repo's
 * <500-line-per-file convention (that file crossed 500 lines adding the
 * reindex-staleness banner wiring). Holds the pure/self-contained signal
 * builders and small formatting utilities; `session-priming-query.ts` keeps
 * the orchestrator (`runQuery`), the banner renderers that consume state
 * from sibling `retrieval-log/*` modules, and the CLI entry point.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import {
  resolveClaudeProjectDir,
  resolveSharedProjectDir,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/project-dir.js'
import type { SearchHit } from '../packages/doc-retrieval-mcp/src/types.js'
import { graphql } from './lib/linear-client.mjs'

const execFileAsync = promisify(execFile)

const SIGNAL_2_CAP_BYTES = 1024
const SIGNAL_3_BULLETS = 15
const MEMORY_FILE_MAX_READ = 100 * 1024
const LINEAR_TIMEOUT_MS = 1800

export interface CliArgs {
  sessionId: string
  branch: string
  smi: string
  cwd: string
  out: string
}

// search() is dynamically imported inside runQuery — its module loads
// @ruvector/core's native binding at top-level, which throws on hosts
// missing the platform-specific optional dep (e.g. ruvector-core-darwin-arm64
// on macOS without it installed). Top-level static import would crash query.ts
// at module load before runQuery could log a partial_failure row. Surfaced by
// the §S9 post-deploy smoke run on 2026-04-25 (host=darwin-arm64).
export type SearchFn = (opts: {
  query: string
  k?: number
  minScore?: number
}) => Promise<SearchHit[]>

export async function loadSearch(): Promise<SearchFn | null> {
  try {
    const mod = (await import('../packages/doc-retrieval-mcp/src/search.js')) as {
      search: SearchFn
    }
    return mod.search
  } catch {
    return null
  }
}

export function parseCliArgs(argv: string[]): CliArgs | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'session-id': { type: 'string' },
        branch: { type: 'string' },
        smi: { type: 'string' },
        cwd: { type: 'string' },
        out: { type: 'string' },
      },
      strict: false,
    })
    if (!values['session-id'] || !values.cwd || !values.out) return null
    return {
      sessionId: String(values['session-id']),
      branch: String(values.branch ?? ''),
      smi: String(values.smi ?? ''),
      cwd: String(values.cwd),
      out: String(values.out),
    }
  } catch {
    return null
  }
}

export async function buildSignal1(args: CliArgs): Promise<string> {
  const branchSlug = args.branch.replace(/[^a-z0-9-]+/gi, '-').slice(0, 60)
  let modifiedFiles: string[] = []
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: args.cwd,
      timeout: 1500,
    })
    modifiedFiles = stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, 20)
      .map((f) => basename(f))
  } catch {
    // git not available or no diff — drop modified-files component
  }
  return [args.smi, branchSlug, ...modifiedFiles].filter(Boolean).join(' ')
}

/**
 * SMI-5793 — current HEAD sha for `args.cwd`, used by the reindex-staleness
 * banner's "hung" check (`renderReindexBanner`'s `opts.currentHeadSha`).
 * Fail-soft to null (mirrors `cli.ts`'s own `git rev-parse HEAD` try/catch)
 * — a detached/shallow edge state or missing git binary simply skips the
 * hung check rather than crashing the priming hook.
 */
export async function getCurrentHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 1500 })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function buildSignal2(args: CliArgs): Promise<string> {
  if (!args.smi) return ''
  if (!process.env.LINEAR_API_KEY) return ''

  const query = `query GetIssue($id: String!) { issue(id: $id) { description } }`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LINEAR_TIMEOUT_MS)
  try {
    const data = (await graphql(
      query,
      { id: args.smi.toUpperCase() },
      { signal: ctrl.signal }
    )) as {
      issue?: { description?: string | null }
    }
    const desc = data.issue?.description ?? ''
    return truncateBytes(desc, SIGNAL_2_CAP_BYTES)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

export async function buildSignal3(args: CliArgs): Promise<string> {
  try {
    // SMI-5419: MEMORY.md is shared project knowledge — resolve via the main-repo
    // resolver (casing reconciled) so a worktree session reads the same curated
    // memory store as the main checkout, not an empty per-worktree dir.
    const memPath = join(resolveSharedProjectDir(args.cwd).dir, 'memory', 'MEMORY.md')
    if (!existsSync(memPath)) return ''
    const text = await readFileTruncated(memPath, MEMORY_FILE_MAX_READ)
    return extractRecentBullets(text, SIGNAL_3_BULLETS)
  } catch {
    return ''
  }
}

async function readFileTruncated(path: string, maxBytes: number): Promise<string> {
  const buf = await readFile(path)
  return buf.slice(0, maxBytes).toString('utf8')
}

export function extractRecentBullets(text: string, n: number): string {
  const lines = text.split('\n')
  let recentStart = -1
  let recentEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^## Recent\b/.test(lines[i])) {
      recentStart = i + 1
      // find next ## heading at same depth
      for (let j = i + 1; j < lines.length; j++) {
        if (/^## /.test(lines[j])) {
          recentEnd = j
          break
        }
      }
      break
    }
  }
  let bullets: string[]
  if (recentStart >= 0) {
    bullets = lines
      .slice(recentStart, recentEnd)
      .filter((l) => /^- /.test(l))
      .slice(0, n)
  } else {
    bullets = lines.filter((l) => /^- /.test(l)).slice(0, 20)
  }
  return truncateBytes(bullets.join('\n'), SIGNAL_2_CAP_BYTES)
}

export function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  return buf.slice(0, maxBytes).toString('utf8')
}

/**
 * SMI-4549 Wave 2 — count `~/.claude/projects/<encoded>/sessions/*.jsonl`
 * files modified in the last `staleHours`. The probe uses this as the
 * denominator for its capture-rate gate so the threshold is session-relative
 * rather than absolute (plan-review H3).
 *
 * SMI-5419: sessions are PER-CWD — Claude Code writes transcripts under the
 * actual launch dir — so this resolves the raw cwd (casing reconciled), unlike
 * the memory/telemetry sites which key on the shared main-repo dir.
 *
 * SCOPE-MISMATCH CAVEAT (flagged, not fixed here): the capture-rate ratio divides
 * a main-repo-SHARED telemetry numerator (`retrieval_events` aggregates every
 * worktree into one DB) by this PER-CWD sessions denominator (this launch dir
 * only). In a worktree the denominator undercounts, so capture-rate reads high.
 * Aligning the scopes (aggregate sessions across the main + worktree dirs, or
 * scope telemetry per-cwd) is a probe / metrics-foundation refinement, tracked
 * there — out of scope for the W0.1 case-fix.
 */
export function countRecentJsonlSessions(cwd: string, now: Date, staleHours: number): number {
  try {
    const sessionsDir = join(resolveClaudeProjectDir(cwd).dir, 'sessions')
    if (!existsSync(sessionsDir)) return 0
    const cutoff = now.getTime() - staleHours * 60 * 60 * 1000
    let n = 0
    for (const entry of readdirSync(sessionsDir)) {
      if (!entry.endsWith('.jsonl')) continue
      try {
        const st = statSync(join(sessionsDir, entry))
        if (st.mtimeMs >= cutoff) n += 1
      } catch {
        // ignore missing/unreadable files
      }
    }
    return n
  } catch {
    return 0
  }
}

export function formatRelativeAge(tsIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(tsIso)
  if (!Number.isFinite(ms)) return 'unknown'
  const hours = ms / (1000 * 60 * 60)
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`
  if (hours < 48) return `${Math.round(hours)} hours ago`
  return `${Math.round(hours / 24)} days ago`
}
