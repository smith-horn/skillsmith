/**
 * SMI-5419 W0.1 — canonical encoded-project-dir resolver with on-disk case
 * reconciliation.
 *
 * Background: Claude Code stores per-project state under
 * `~/.claude/projects/<encoded>` where `<encoded>` is the project's absolute
 * path with every `/` replaced by `-`. Several dev-tooling sites independently
 * re-derive this name. The encoders already AGREE on output; the defect is the
 * INPUT path's *casing*: `process.cwd()` / a git walk-up can resolve to a
 * lower-cased variant (e.g. `…/documents/github/…`) that does not match Claude
 * Code's case-preserving directory. APFS case-insensitivity masks the mismatch
 * locally; on a case-sensitive filesystem (Linux/CI) the two casings split into
 * two different directories — which is how the retrieval-telemetry feed went
 * silently dead for ~6 weeks.
 *
 * Fix: after computing the encoded name, reconcile its casing against the
 * directories that actually exist under `~/.claude/projects/`. We never DECODE
 * an on-disk name (a real path segment may legitimately contain `-`, so
 * dash→slash is ambiguous); all matching is done on the ENCODED form, which is
 * unambiguous.
 *
 * Two input policies, exposed as two resolvers:
 *   - {@link resolveSharedProjectDir} — keyed on the MAIN repo root so all
 *     worktrees of one project share a single store: the `retrieval-logs.db`
 *     telemetry feed AND the curated `/memory` topic-file corpus (both are
 *     project-level knowledge, not per-worktree state).
 *   - {@link resolveClaudeProjectDir} — keyed on the raw cwd for per-working-
 *     directory state: the session `*.jsonl` transcripts Claude Code writes
 *     under the actual launch dir.
 *
 * `CLAUDE_PROJECT_DIR` is intentionally NOT used as the source: in a worktree
 * session it is the worktree path, which would shard the deliberately-shared
 * telemetry DB. `fs.realpathSync` is intentionally NOT used: it resolves
 * symlinks/`..` but does not reverse on-disk casing (inert on APFS) and trips
 * the realpath-asymmetry audit (Check 41).
 *
 * This module is the canonical implementation. Two mirrors exist for runtime
 * boundaries that cannot import it: `scripts/lib/project-dir.mjs` (plain-node
 * scripts that avoid the tsx startup cost) and a shell function in
 * `scripts/check-retrieval-events.sh` (must survive a dead-node/dead-binding
 * state). A cross-runtime parity test keeps all three in agreement; audit
 * Check 34 enforces that every site references its canonical resolver.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Outcome of reconciling a computed encoded name against the filesystem. */
export type ReconcileState =
  | 'exact' // the computed name exists on disk verbatim
  | 'reconciled' // a single case-variant existed; we adopted its casing
  | 'anchored' // borrowed correct casing from a descendant entry's prefix
  | 'ambiguous' // multiple conflicting case-variants — caller must surface this
  | 'miss' // nothing on disk to reconcile against (fresh / never-opened project)

export interface ResolvedProjectDir {
  /** Encoded directory NAME (not a full path) to use under `~/.claude/projects/`. */
  encoded: string
  /** Absolute path `~/.claude/projects/<encoded>`. */
  dir: string
  state: ReconcileState
  /** Populated only when `state === 'ambiguous'` — the conflicting on-disk names. */
  candidates?: string[]
}

function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Walk up from `start` until a directory containing `.git` as a DIRECTORY (not
 * a file — worktrees have `.git` as a file pointing at the main gitdir). Returns
 * the first such ancestor, or `null` before filesystem root. For a worktree
 * under `<repo>/.worktrees/<name>/`, this returns `<repo>` so all worktrees of
 * one project resolve to the same telemetry DB.
 */
export function findMainRepoRoot(start: string): string | null {
  let current = resolve(start)
  // Worktrees live inside the main repo, so depth is small; cap for safety.
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

/**
 * Encode an absolute path the way Claude Code names `~/.claude/projects/`
 * entries: replace each `/` with `-`. `/Users/foo/Bar` → `-Users-foo-Bar`.
 */
export function encodeProjectSegment(abs: string): string {
  return abs.replace(/\//g, '-')
}

/**
 * ASCII-only lower-case fold. Restricted to `[A-Z]` so locale-specific rules
 * (Turkish dotless-i, etc.) cannot make the TS and shell/mjs mirrors disagree.
 */
export function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** List `~/.claude/projects/` entries, tolerating a fresh install (no dir). */
function listProjectEntries(): string[] {
  try {
    return readdirSync(claudeProjectsRoot())
  } catch {
    return [] // ENOENT on a fresh install / wiped state
  }
}

/**
 * Reconcile a computed encoded name against the filesystem WITHOUT decoding.
 *
 * Resolution order (each step is unambiguous on the encoded string):
 *   1. exact      — `<computed>` exists verbatim.
 *   2. reconciled — exactly one entry equals `<computed>` under ASCII fold
 *                   (a pure casing variant). Adopt its casing.
 *   3. anchored   — no full-string variant, but one or more entries are
 *                   `<computed>-<descendant>` under ASCII fold (e.g. a worktree
 *                   session of the same repo). Borrow the correctly-cased
 *                   PREFIX (length-bounded to `<computed>`), never the longer
 *                   name — so we never select a sub-project's directory
 *                   (guards the substring-collision trap). Ambiguous only if
 *                   the candidate prefixes disagree on casing.
 *   4. ambiguous  — multiple conflicting case-variants at step 2 or 3.
 *   5. miss       — nothing to reconcile against.
 *
 * Returns the name to use plus the state; the caller decides how loudly to
 * surface non-`exact`/`reconciled`/`anchored` states (warn-once, outage
 * marker, probe non-zero exit) — this module never throws and never writes.
 */
export function reconcileEncodedDir(computed: string): {
  encoded: string
  state: ReconcileState
  candidates?: string[]
} {
  if (existsSync(join(claudeProjectsRoot(), computed))) {
    return { encoded: computed, state: 'exact' }
  }
  const entries = listProjectEntries()
  const foldedComputed = asciiFold(computed)

  // Step 2: full-string case-variant (exact length, not a prefix).
  const fullMatches = entries.filter((n) => asciiFold(n) === foldedComputed)
  if (fullMatches.length === 1) return { encoded: fullMatches[0], state: 'reconciled' }
  if (fullMatches.length > 1)
    return { encoded: computed, state: 'ambiguous', candidates: fullMatches }

  // Step 3: prefix anchor — borrow casing from a descendant entry's prefix.
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

let telemetryMemo: ResolvedProjectDir | null = null
const cwdMemo = new Map<string, ResolvedProjectDir>()

/** Test-only: reset module-scope memoization between cases. */
export function resetProjectDirCache(): void {
  telemetryMemo = null
  cwdMemo.clear()
}

function build(encoded: string, state: ReconcileState, candidates?: string[]): ResolvedProjectDir {
  return {
    encoded,
    dir: join(claudeProjectsRoot(), encoded),
    state,
    ...(candidates ? { candidates } : {}),
  }
}

/**
 * Resolve the encoded project dir for SHARED, project-level state — keyed on the
 * MAIN repo root so all worktrees of one project resolve to a single dir. Used by
 * both the telemetry DB (`retrieval-logs.db`) and the curated `/memory` corpus,
 * which are project knowledge rather than per-worktree state. Memoized at module
 * scope — separate from the DB handle cache, because the writer's no-op paths
 * re-enter resolution per event.
 */
export function resolveSharedProjectDir(cwd: string = process.cwd()): ResolvedProjectDir {
  if (telemetryMemo) return telemetryMemo
  const root = findMainRepoRoot(cwd) ?? cwd
  const r = reconcileEncodedDir(encodeProjectSegment(root))
  telemetryMemo = build(r.encoded, r.state, r.candidates)
  return telemetryMemo
}

/**
 * Resolve the encoded project dir for PER-CWD state — the session `*.jsonl`
 * transcripts Claude Code writes under the actual working directory. NOT for
 * memory, which is shared project knowledge (see {@link resolveSharedProjectDir}).
 * Memoized per cwd.
 */
export function resolveClaudeProjectDir(cwd: string = process.cwd()): ResolvedProjectDir {
  const key = resolve(cwd)
  const cached = cwdMemo.get(key)
  if (cached) return cached
  const r = reconcileEncodedDir(encodeProjectSegment(key))
  const resolved = build(r.encoded, r.state, r.candidates)
  cwdMemo.set(key, resolved)
  return resolved
}
