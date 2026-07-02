/**
 * Shared result/option types for the agent-install config-merge helpers
 * (SMI-5456 Wave 1 Step 5). One shape reused by the JSON, YAML, and
 * TOML-block merge implementations so the installer orchestrator branches on
 * a single result contract regardless of which harness's config format it
 * just merged into.
 *
 * @module @skillsmith/core/install/agent-config-merge.types
 */

/**
 * Outcome of a single merge attempt.
 *
 *   created   - the file (or the whole key path) did not exist; created fresh.
 *   updated   - an entry recognizable as OURS existed with different content
 *               (e.g. a version bump); backed up the file, then overwrote.
 *   unchanged - an entry recognizable as OURS already matched exactly —
 *               idempotent no-op, no backup written (P-5 double-install test).
 *   conflict  - an entry existed that does NOT look like ours; left
 *               untouched unless `force` was passed.
 *   error     - the file could not be read/parsed/written; left untouched.
 */
export type MergeStatus = 'created' | 'updated' | 'unchanged' | 'conflict' | 'error'

export interface MergeResult {
  status: MergeStatus
  path: string
  /** Absolute path to the pre-write backup, or null when no backup was needed. */
  backupPath: string | null
  /** Present only when status is 'error'. */
  errorMessage?: string
}

export interface MergeOptions {
  path: string
  /** The value to install under the `skillsmith` key. */
  entryValue: Record<string, unknown>
  /** Directory backups are written into. Caller ensures it exists. */
  backupDir: string
  /**
   * When an existing entry does not look like ours, overwrite it anyway.
   * Defaults to false — the non-interactive refusal path (P-5 preserve-
   * existing test): no prompt, no silent clobber, just a `'conflict'` result
   * the caller surfaces in the per-harness report.
   */
  force?: boolean
  /**
   * Paths already backed up during THIS `installAgentPack` run (shared
   * across every merge call in the run — `HarnessInstallCtx.backedUpPaths`).
   * Some harnesses (claude-code) merge into the SAME file more than once per
   * run (SessionStart hook, SessionEnd hook, then MCP registration, all in
   * `~/.claude/settings.json`) — without this, the second and third merges
   * would each "back up" a state that WE ourselves just wrote earlier in the
   * same run, producing redundant, meaningless backups. A path is only ever
   * backed up once per run, capturing genuine pre-install content.
   */
  alreadyBackedUpPaths?: Set<string>
}

/**
 * Decide whether a merge should take a backup of `path` right now: only if
 * it hasn't already been backed up earlier in this same install run. Callers
 * that DO write a backup must call {@link markBackedUp} immediately after.
 */
export function shouldBackup(path: string, alreadyBackedUpPaths: Set<string> | undefined): boolean {
  return !alreadyBackedUpPaths?.has(path)
}

/** Record that `path` has now been backed up for the remainder of this install run. */
export function markBackedUp(path: string, alreadyBackedUpPaths: Set<string> | undefined): void {
  alreadyBackedUpPaths?.add(path)
}

/**
 * Heuristic ownership check shared by every format-specific merge helper:
 * does an existing entry look like a Skillsmith MCP server registration we
 * (a prior `sklx agent install` run) wrote, as opposed to a user's own
 * hand-written `skillsmith`-named entry pointing somewhere else entirely?
 *
 * There is no injected marker field in the entry value itself (that would
 * pollute a config another tool's strict-schema client might read) — instead
 * this checks for the structural fingerprint our own entries always carry:
 * an `args` array mentioning `@skillsmith/mcp-server`, or an `env.SKILLSMITH_TOOL_PROFILE`
 * key. Either is a strong, low-false-positive signal.
 */
export function looksLikeOurMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const args = v.args
  if (
    Array.isArray(args) &&
    args.some((a) => typeof a === 'string' && a.includes('@skillsmith/mcp-server'))
  ) {
    return true
  }
  const env = v.env
  if (env && typeof env === 'object' && 'SKILLSMITH_TOOL_PROFILE' in (env as object)) return true
  return false
}

/** Deep structural equality for plain JSON-shaped values (objects/arrays/primitives). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqualJson(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort()
    const bKeys = Object.keys(b as object).sort()
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false
    return aKeys.every((k) =>
      deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
  }
  return false
}
