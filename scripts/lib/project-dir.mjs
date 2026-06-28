/**
 * SMI-5419 W0.1 — plain-Node mirror of the canonical encoded-project-dir
 * resolver (packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts).
 *
 * Exists because plain-node scripts (retrieval-log-cli.mjs, retro-frontmatter.mjs)
 * run WITHOUT tsx — to avoid its ~300ms startup cost — and so cannot import the
 * package TS. This file MUST stay behavior-equivalent to project-dir.ts; the
 * cross-runtime parity test (scripts/tests/project-dir-parity.test.ts) feeds both
 * runtimes identical inputs and asserts identical output. See project-dir.ts for
 * the full rationale: the bug is input-path CASING (not the encoding); we never
 * decode an on-disk name; CLAUDE_PROJECT_DIR is wrong (worktree shards the shared
 * DB) and realpathSync is inert on APFS.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function claudeProjectsRoot() {
  return join(homedir(), '.claude', 'projects')
}

/** Walk up to the first ancestor whose `.git` is a DIRECTORY (worktrees have a file). */
export function findMainRepoRoot(start) {
  let current = resolve(start)
  for (let i = 0; i < 64; i += 1) {
    const gitPath = join(current, '.git')
    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory()) return current
      } catch {
        // unreadable — treat as missing, keep walking
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** Replace each `/` with `-` (Claude Code's `~/.claude/projects/` naming). */
export function encodeProjectSegment(abs) {
  return abs.replace(/\//g, '-')
}

/** ASCII-only lower-case fold (restricted to [A-Z] so TS/mjs/shell agree). */
export function asciiFold(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function listProjectEntries() {
  try {
    return readdirSync(claudeProjectsRoot())
  } catch {
    return [] // ENOENT on a fresh install / wiped state
  }
}

/**
 * Reconcile a computed encoded name against the filesystem WITHOUT decoding.
 * Order: exact → full-string case-variant (reconciled) → descendant prefix
 * (anchored, length-bounded so we never select a sub-project) → ambiguous → miss.
 * Mirror of reconcileEncodedDir in project-dir.ts.
 */
export function reconcileEncodedDir(computed) {
  if (existsSync(join(claudeProjectsRoot(), computed))) {
    return { encoded: computed, state: 'exact' }
  }
  const entries = listProjectEntries()
  const foldedComputed = asciiFold(computed)

  const fullMatches = entries.filter((n) => asciiFold(n) === foldedComputed)
  if (fullMatches.length === 1) return { encoded: fullMatches[0], state: 'reconciled' }
  if (fullMatches.length > 1)
    return { encoded: computed, state: 'ambiguous', candidates: fullMatches }

  const prefix = `${foldedComputed}-`
  const anchorPrefixes = new Set(
    entries.filter((n) => asciiFold(n).startsWith(prefix)).map((n) => n.slice(0, computed.length))
  )
  if (anchorPrefixes.size === 1) {
    return { encoded: [...anchorPrefixes][0], state: 'anchored' }
  }
  if (anchorPrefixes.size > 1) {
    return { encoded: computed, state: 'ambiguous', candidates: [...anchorPrefixes] }
  }

  return { encoded: computed, state: 'miss' }
}

let telemetryMemo = null
const cwdMemo = new Map()

/** Test-only: reset module-scope memoization between cases. */
export function resetProjectDirCache() {
  telemetryMemo = null
  cwdMemo.clear()
}

function build(encoded, state, candidates) {
  return {
    encoded,
    dir: join(claudeProjectsRoot(), encoded),
    state,
    ...(candidates ? { candidates } : {}),
  }
}

/** SHARED project-level dir (telemetry DB + /memory corpus), keyed on the main
 * repo root so all worktrees share one. Memoized. */
export function resolveSharedProjectDir(cwd = process.cwd()) {
  if (telemetryMemo) return telemetryMemo
  const root = findMainRepoRoot(cwd) ?? cwd
  const r = reconcileEncodedDir(encodeProjectSegment(root))
  telemetryMemo = build(r.encoded, r.state, r.candidates)
  return telemetryMemo
}

/** PER-CWD dir for session *.jsonl transcripts (NOT memory — that's shared via
 * resolveSharedProjectDir). Memoized per cwd. */
export function resolveClaudeProjectDir(cwd = process.cwd()) {
  const key = resolve(cwd)
  const cached = cwdMemo.get(key)
  if (cached) return cached
  const r = reconcileEncodedDir(encodeProjectSegment(key))
  const resolved = build(r.encoded, r.state, r.candidates)
  cwdMemo.set(key, resolved)
  return resolved
}
