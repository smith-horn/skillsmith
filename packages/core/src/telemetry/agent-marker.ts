/**
 * SMI-5456: Agent-mediation marker channel.
 *
 * Wave 1 needs to distinguish agent-mediated skill invocations from ambient
 * ones so the mediation gate (≥25% agent-mediated share by day 30) is
 * measurable. Two channels feed the three per-event telemetry fields
 * (`agent_session`, `nudge_origin`, `trigger_id`) plus the per-harness
 * `framework` attribution (via the vocabulary-validated `harness` hint —
 * the mediation dashboard's per-harness denominator):
 *
 *  1. MCP `_meta` on the tool call (spec-clean; wins when present). No Tier-1
 *     harness can inject `_meta` on a genuine agent tool call today (Step-0
 *     spike (e)) — hooks only touch `arguments`, the model has no `_meta`
 *     schema affordance — so this is forward-looking infrastructure that
 *     activates the day a harness ships native support.
 *  2. A session-scoped marker file written by a harness SessionStart hook
 *     under `~/.skillsmith/agent-markers/` (PRIMARY channel for Wave 1). The
 *     server treats these files as READ-ONLY: it never writes, updates, or
 *     deletes them (that is the hook's job at SessionEnd). Stale files that a
 *     crashed session left behind expire by a session TTL.
 *
 * A missing / corrupt / expired file is simply "no marker" — never an error.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config/index.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** On-disk marker schema version — bump on a breaking shape change. */
export const AGENT_MARKER_SCHEMA_VERSION = 1

/**
 * Session TTL. A marker older than this (measured from its `started_at`) is
 * ignored as stale.
 *
 * Rationale for 12h: the primary staleness control is the hook deleting its
 * own file at SessionEnd; the TTL only backstops a session that crashed
 * without cleanup. 12h comfortably spans a long interactive working day so a
 * genuinely live session is never expired mid-flight, while still ensuring a
 * marker abandoned by a crash cannot mislabel invocations a day or more later.
 */
export const AGENT_MARKER_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Max bytes read from a single marker file.
 *
 * `readSessionMarker` runs synchronously on the MCP dispatch hot path (every
 * tool call). A well-formed marker is a handful of scalar fields — a few
 * hundred bytes; 16 KiB is generous headroom. Without this cap a corrupt or
 * hostile file of unbounded size would block the event loop for the full
 * synchronous `readFileSync` + `JSON.parse` on every single tool call until
 * the hook cleans it up (or the TTL elapses, which only affects staleness,
 * not the read cost). Oversized files are treated as corrupt: skipped, never
 * thrown.
 */
export const AGENT_MARKER_MAX_FILE_BYTES = 16 * 1024

/**
 * Accepted `harness` vocabulary — the SMI-5012 wire format's `framework` enum
 * (authoritative list: skill-invoke-telemetry-guide.md § Wire format) minus
 * `'unknown'`. `'unknown'` is the extractor's absence fallback, not a value a
 * marker may assert: accepting it would let a marker file overwrite a real
 * extractor result with noise. Anything outside this set (junk from disk or
 * `_meta`) resolves to `undefined` and never flows into telemetry.
 */
export const KNOWN_HARNESS_FRAMEWORKS = [
  'claude-code',
  'cursor',
  'continue',
  'cline',
  'copilot',
  'windsurf',
  'codex',
  'vscode',
  'opencode',
  'hermes',
] as const

/** A validated harness/framework value from the marker channel. */
export type HarnessFramework = (typeof KNOWN_HARNESS_FRAMEWORKS)[number]

const KNOWN_HARNESS_SET: ReadonlySet<string> = new Set(KNOWN_HARNESS_FRAMEWORKS)

/** Validate an untrusted harness value; anything not in the vocabulary → undefined. */
function validHarness(value: unknown): HarnessFramework | undefined {
  return typeof value === 'string' && KNOWN_HARNESS_SET.has(value)
    ? (value as HarnessFramework)
    : undefined
}

/** The "no marker present" resolution — all fields at their neutral default. */
export const NO_AGENT_MARKER: AgentMarker = Object.freeze({
  agentSession: false,
  nudgeOrigin: false,
  triggerId: null,
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolved marker — the three per-event fields threaded into the telemetry
 * payload. Always fully populated (neutral defaults when no marker resolves).
 */
export interface AgentMarker {
  /** True when the invocation is part of an agent-mediated session. */
  agentSession: boolean
  /** True when the invocation originated from a nudge (job-9 onboarding). */
  nudgeOrigin: boolean
  /** Paywall / nudge trigger id, or `null` when none applies. */
  triggerId: string | null
  /**
   * Validated harness identity from the marker channel (the file's `harness`
   * hint or `_meta.harness`). Feeds the event's `framework` field when the
   * per-call extractor has nothing better (see wrap.ts). Absent when the
   * channel supplied no value or an out-of-vocabulary one.
   */
  harness?: HarnessFramework
}

/**
 * On-disk marker file shape (snake_case to match the telemetry wire format).
 * Written by a harness SessionStart hook; only ever READ by the server.
 */
export interface AgentMarkerFile {
  /** Schema version (see `AGENT_MARKER_SCHEMA_VERSION`). */
  schema?: number
  /** Harness session identifier (the hook's `session_id`). */
  session_id: string
  /** Epoch-ms session start; the TTL is measured from this. */
  started_at: number
  /** Optional harness hint, e.g. `'claude-code'`, `'cursor'`, `'opencode'`. */
  harness?: string
  /** Agent session? Defaults true for a valid marker; set false to opt out. */
  agent_session?: boolean
  /** Nudge-originated? Defaults false. */
  nudge_origin?: boolean
  /** Trigger id, or null. Defaults null. */
  trigger_id?: string | null
}

// ---------------------------------------------------------------------------
// Directory resolution (matches getCacheDir override convention, SMI-4577)
// ---------------------------------------------------------------------------

/**
 * Resolve `~/.skillsmith/agent-markers/`.
 *
 * `SKILLSMITH_AGENT_MARKER_DIR` overrides the default — mirrors
 * `SKILLSMITH_CACHE_DIR_OVERRIDE`, needed because macOS `os.homedir()`
 * resolves via `getpwuid()` and ignores `process.env.HOME` mutations in tests.
 *
 * Read-only: this only computes the path, it never creates the directory.
 */
function getAgentMarkerDir(): string {
  const override = process.env.SKILLSMITH_AGENT_MARKER_DIR
  return override && override.length > 0 ? override : join(getConfigDir(), 'agent-markers')
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

interface ParsedMarker {
  file: AgentMarkerFile
  startedAt: number
}

/**
 * Read + validate a single marker file. Returns null for anything that is not
 * a well-formed, non-expired marker (corrupt JSON, wrong shape, missing/invalid
 * `started_at`, empty `session_id`, past the TTL, not a regular file, or over
 * `AGENT_MARKER_MAX_FILE_BYTES`). Never throws.
 */
function readMarkerFile(path: string, now: number): ParsedMarker | null {
  let raw: string
  try {
    // `lstatSync` (not `stat`) so a symlink is rejected outright rather than
    // followed — the directory is documented read-only server-side, so a
    // symlink here is never something the reader itself created.
    const stat = lstatSync(path)
    if (!stat.isFile()) return null
    if (stat.size > AGENT_MARKER_MAX_FILE_BYTES) return null
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (!data || typeof data !== 'object') return null
  const file = data as Record<string, unknown>

  if (typeof file.session_id !== 'string' || file.session_id.length === 0) return null

  const startedAt = file.started_at
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return null

  // Expired: older than the TTL. A future timestamp (clock skew) is not stale.
  if (now - startedAt > AGENT_MARKER_TTL_MS) return null

  return { file: file as unknown as AgentMarkerFile, startedAt }
}

/** Map a validated on-disk file to the resolved marker fields. */
function markerFromFile(file: AgentMarkerFile): AgentMarker {
  return {
    // A valid marker means "agent session" by presence; honour an explicit opt-out.
    agentSession: file.agent_session === false ? false : true,
    nudgeOrigin: file.nudge_origin === true,
    triggerId: typeof file.trigger_id === 'string' ? file.trigger_id : null,
    // Vocabulary-gated: junk from disk must not flow into telemetry.
    harness: validHarness(file.harness),
  }
}

/**
 * Read the freshest non-expired session marker from `~/.skillsmith/agent-markers/`.
 *
 * Wave-1 correlation note: the server cannot know its own harness session id,
 * so it selects the most recently started live marker. Concurrent sessions on
 * one machine may therefore observe each other's marker — an accepted,
 * documented imprecision (the `_meta` channel is exact and wins when present).
 *
 * @returns the resolved marker, or null when no live marker exists.
 */
export function readSessionMarker(opts: { now?: number } = {}): AgentMarker | null {
  const now = opts.now ?? Date.now()
  const dir = getAgentMarkerDir()

  let names: string[]
  try {
    if (!existsSync(dir)) return null
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return null
  }

  let best: ParsedMarker | null = null
  for (const name of names) {
    const parsed = readMarkerFile(join(dir, name), now)
    if (!parsed) continue
    if (!best || parsed.startedAt > best.startedAt) best = parsed
  }

  return best ? markerFromFile(best.file) : null
}

// ---------------------------------------------------------------------------
// `_meta` extraction
// ---------------------------------------------------------------------------

/**
 * Defensively extract the marker fields from an MCP request's `_meta`.
 *
 * `_meta` is a loose passthrough schema (SDK 1.29.0), so junk keys and wrong
 * types must be ignored. Keys are snake_case to match the wire format:
 * `agent_session`, `nudge_origin`, `trigger_id`, `harness`. Only well-typed
 * values are returned; everything else is dropped (`harness` additionally
 * gated on the `KNOWN_HARNESS_FRAMEWORKS` vocabulary).
 */
export function extractMarkerMeta(meta: unknown): Partial<AgentMarker> {
  if (!meta || typeof meta !== 'object') return {}
  const m = meta as Record<string, unknown>
  const out: Partial<AgentMarker> = {}
  if (typeof m.agent_session === 'boolean') out.agentSession = m.agent_session
  if (typeof m.nudge_origin === 'boolean') out.nudgeOrigin = m.nudge_origin
  if (typeof m.trigger_id === 'string') out.triggerId = m.trigger_id
  else if (m.trigger_id === null) out.triggerId = null
  const metaHarness = validHarness(m.harness)
  if (metaHarness !== undefined) out.harness = metaHarness
  return out
}

// ---------------------------------------------------------------------------
// Resolution (precedence: _meta wins per-field, else marker file, else default)
// ---------------------------------------------------------------------------

/**
 * Resolve the agent marker for a single tool call.
 *
 * Per-field precedence: a value present in `_meta` wins; otherwise the session
 * marker file supplies it; otherwise the neutral default (`false`/`false`/`null`).
 *
 * @param meta - the MCP request's `_meta` object (or undefined).
 * @param opts.now - injectable clock for tests.
 */
export function resolveAgentMarker(meta: unknown, opts: { now?: number } = {}): AgentMarker {
  const fromFile = readSessionMarker(opts) ?? NO_AGENT_MARKER
  const fromMeta = extractMarkerMeta(meta)
  return {
    agentSession: fromMeta.agentSession ?? fromFile.agentSession,
    nudgeOrigin: fromMeta.nudgeOrigin ?? fromFile.nudgeOrigin,
    triggerId: fromMeta.triggerId !== undefined ? fromMeta.triggerId : fromFile.triggerId,
    harness: fromMeta.harness ?? fromFile.harness,
  }
}
