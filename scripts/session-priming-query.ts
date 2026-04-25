#!/usr/bin/env tsx
/**
 * SMI-4451 Wave 1 Step 7 — SessionStart priming query builder.
 *
 * Invoked by `scripts/session-start-priming.sh` after gate checks pass. Builds
 * a 3-signal query (branch+files / Linear issue body / memory bullets), runs
 * `search()` against the doc-retrieval index, logs a `retrieval_events` row
 * via the Step 3 writer, and emits markdown for the SessionStart hook to
 * inject as `additionalContext`.
 *
 * Spec: docs/internal/implementation/smi-4450-sparc-research.md §P2 +
 * smi-4450-step7-session-start-hook.md §S4. Per addendum:
 *   - linear-api.mjs has no `get-issue` command (surface gap caught at impl
 *     time). Inlines a minimal Linear GraphQL fetch instead of touching
 *     linear-api.mjs. ~25 LOC scoped to this feature.
 *   - `disabled` outcome already in RetrievalHookOutcome union (schema.ts:30)
 *     — no schema migration needed, just emit the value.
 *   - Encoded-cwd helper inlined (4 LOC) per addendum §S4 — drift caught by
 *     audit:standards Section 34.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import { logRetrievalEvent } from '../packages/doc-retrieval-mcp/src/retrieval-log/writer.js'
import type { SearchHit } from '../packages/doc-retrieval-mcp/src/types.js'

// search() is dynamically imported inside runQuery — its module loads
// @ruvector/core's native binding at top-level, which throws on hosts
// missing the platform-specific optional dep (e.g. ruvector-core-darwin-arm64
// on macOS without it installed). Top-level static import would crash query.ts
// at module load before runQuery could log a partial_failure row. Surfaced by
// the §S9 post-deploy smoke run on 2026-04-25 (host=darwin-arm64).
type SearchFn = (opts: { query: string; k?: number; minScore?: number }) => Promise<SearchHit[]>

async function loadSearch(): Promise<SearchFn | null> {
  try {
    const mod = (await import('../packages/doc-retrieval-mcp/src/search.js')) as {
      search: SearchFn
    }
    return mod.search
  } catch {
    return null
  }
}

const execFileAsync = promisify(execFile)

const QUERY_CAP_BYTES = 4096
const RENDER_CAP_BYTES = 2048
const SIGNAL_2_CAP_BYTES = 1024
const SIGNAL_3_BULLETS = 15
const SEARCH_K = 8
const MIN_SCORE = 0.35
const MEMORY_FILE_MAX_READ = 100 * 1024
const LINEAR_TIMEOUT_MS = 1800

interface CliArgs {
  sessionId: string
  branch: string
  smi: string
  cwd: string
  out: string
}

export interface PrimingResult {
  additionalContext: string
}

/**
 * Encoded-cwd helper — paired with `encodeProjectPath` in
 * `packages/doc-retrieval-mcp/src/retrieval-log/writer.ts` (line ~67).
 * Drift caught by `audit:standards` Section 34 regex.
 */
function encodeProjectPath(absPath: string): string {
  return '-' + absPath.slice(1).replace(/\//g, '-')
}

function parseCliArgs(argv: string[]): CliArgs | null {
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

async function buildSignal1(args: CliArgs): Promise<string> {
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

async function buildSignal2(args: CliArgs): Promise<string> {
  if (!args.smi) return ''
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) return ''

  const query = `query GetIssue($id: String!) { issue(id: $id) { description } }`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LINEAR_TIMEOUT_MS)
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables: { id: args.smi.toUpperCase() } }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return ''
    const json = (await res.json()) as { data?: { issue?: { description?: string | null } } }
    const desc = json.data?.issue?.description ?? ''
    return truncateBytes(desc, SIGNAL_2_CAP_BYTES)
  } catch {
    return ''
  }
}

async function buildSignal3(args: CliArgs): Promise<string> {
  try {
    const encoded = encodeProjectPath(args.cwd)
    const memPath = join(homedir(), '.claude', 'projects', encoded, 'memory', 'MEMORY.md')
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

function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  return buf.slice(0, maxBytes).toString('utf8')
}

export function renderPrimingMarkdown(query: string, hits: SearchHit[]): string {
  const head = '<!-- session-priming v1 — SMI-4451 Wave 1 Step 7 -->'
  const queryLine = `**Priming query** (truncated; full text in retrieval-logs.db):\n\n> ${truncateBytes(
    query.replace(/\n/g, ' '),
    300
  )}`
  const hitLines = hits.map(
    (h, i) =>
      `${i + 1}. \`${h.filePath}\` (${h.similarity.toFixed(2)})${
        h.headingChain.length > 0 ? ` — ${h.headingChain.join(' › ')}` : ''
      }`
  )
  let out = `${head}\n${queryLine}\n\n**Top ${hits.length} retrievals** (cosine ≥ ${MIN_SCORE}):\n\n${hitLines.join('\n')}\n`
  while (Buffer.byteLength(out, 'utf8') > RENDER_CAP_BYTES && hitLines.length > 1) {
    hitLines.pop()
    out = `${head}\n${queryLine}\n\n**Top ${hitLines.length} retrievals** (cosine ≥ ${MIN_SCORE}):\n\n${hitLines.join('\n')}\n`
  }
  return out
}

export async function runQuery(args: CliArgs): Promise<PrimingResult> {
  if (process.env.SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING === '1') {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query: '',
      topKResults: '[]',
      hookOutcome: 'disabled',
    })
    return { additionalContext: '' }
  }

  const [signal1, signal2, signal3] = await Promise.all([
    buildSignal1(args),
    buildSignal2(args),
    buildSignal3(args),
  ])

  const query = truncateBytes(
    [signal1, signal2, signal3].filter(Boolean).join('\n\n'),
    QUERY_CAP_BYTES
  )

  const search = await loadSearch()
  if (!search) {
    // @ruvector/core native binding unavailable on this host — log and
    // gracefully degrade. Common cause: optional platform dep not installed
    // (e.g. `ruvector-core-darwin-arm64` missing on macOS hosts).
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: '' }
  }

  let hits: SearchHit[]
  try {
    hits = await search({ query, k: SEARCH_K, minScore: MIN_SCORE })
  } catch {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: '' }
  }

  if (hits.length === 0) {
    logRetrievalEvent({
      sessionId: args.sessionId,
      ts: new Date().toISOString(),
      trigger: 'session_start_priming',
      query,
      topKResults: '[]',
      hookOutcome: 'partial_failure',
    })
    return { additionalContext: '' }
  }

  logRetrievalEvent({
    sessionId: args.sessionId,
    ts: new Date().toISOString(),
    trigger: 'session_start_priming',
    query,
    topKResults: JSON.stringify(
      hits.map((h) => ({
        chunk_id: h.id,
        file_path: h.filePath,
        line_range: [h.lineStart, h.lineEnd],
        score: h.similarity,
      }))
    ),
    hookOutcome: 'primed',
  })

  return { additionalContext: renderPrimingMarkdown(query, hits) }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))
  if (!args) {
    process.stdout.write(JSON.stringify({ additionalContext: '' }))
    process.exit(0)
  }
  const result = await runQuery(args)
  process.stdout.write(JSON.stringify(result))
}

if (process.argv[1]?.endsWith('session-priming-query.ts')) {
  void main()
}

export { encodeProjectPath, parseCliArgs, truncateBytes }
