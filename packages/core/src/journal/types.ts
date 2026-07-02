/**
 * @fileoverview Change-journal record shape (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/types
 *
 * The journal is the trust-loop evidence base described in
 * docs/internal/product/prd-skillsmith-agent.md §7: an append-only,
 * hash-chained record of every mutation the apply-family MCP tools make
 * (`apply_namespace_rename`, `apply_recommended_edit`) plus the `undo_apply`
 * tool that reverses them. It is the substrate PRD §10 exclusion 1 points at
 * before autonomy can ever be relaxed ("90 days of journal data shows ≥95%
 * suggestion-acceptance and zero rollback incidents").
 *
 * Field naming is snake_case (not the package's usual camelCase) because the
 * journal is a durable on-disk wire format, not an in-memory TS shape — it
 * mirrors the telemetry wire format's convention (SMI-5012) for the same
 * reason: an on-disk/over-the-wire record should read the same regardless of
 * which language eventually parses it.
 */

/** Bump on a breaking shape change to `JournalRecord`. */
export const JOURNAL_SCHEMA_VERSION = 1

/**
 * `'apply'`   — an apply-family tool successfully mutated a file.
 * `'error'`   — an apply-family tool attempted a mutation and it failed
 *               (the `detail` field carries the typed error kind).
 * `'undo'`    — `undo_apply` successfully reversed a prior `'apply'` record.
 */
export type JournalAction = 'apply' | 'error' | 'undo'

/**
 * Every field the caller supplies. The writer (`writer.ts`) fills in
 * `prev_hash` + `record_hash` to complete a `JournalRecord`.
 *
 * Field semantics:
 * - `suggestion_id` — the `collisionId` the mutation was applied for.
 * - `target_path` — the on-disk file whose CONTENT the record's hashes
 *   describe. For a single-file mutation (prose edit, command/agent rename)
 *   this is the mutated file itself. For a skill-directory rename
 *   (`rename_skill_dir_and_frontmatter`) this is `<newSkillDir>/SKILL.md` —
 *   the one file whose bytes actually changed; the directory rename itself
 *   is not content-hashable and is intentionally out of this record's scope
 *   (see `tools/apply-journal.helpers.ts` header in `@skillsmith/mcp-server`
 *   for the full rationale).
 * - `before_hash` / `after_hash` — sha256 of `target_path`'s content
 *   immediately before / after the mutation. `null` where not applicable
 *   (e.g. an `'error'` record where the mutation never reached a
 *   content-changing step, so there is no "after" state to hash).
 * - `approval` — the caller-supplied approval mode that authorized the
 *   mutation, e.g. `'apply'` / `'custom'` (namespace rename) or
 *   `'apply_with_confirmation'` (recommended edit). Always non-null for
 *   `'apply'`/`'error'` records (the confirmation gate ran); `'undo'` for
 *   undo records.
 * - `backup_ref` — absolute path to the apply tool's own pre-mutation
 *   backup directory (from `createSkillBackup` / `createProseBackup`).
 *   `null` for `'error'` and `'undo'` records — an error may not have
 *   reached the backup step, and an undo record documents a restore that
 *   already happened rather than creating a new backup.
 * - `detail` — free-text elaboration. Populated with the typed error
 *   `kind` (e.g. `'namespace.rename.backup_failed'`) on `'error'` records;
 *   `null` otherwise.
 */
export interface JournalRecordFields {
  schema: number
  ts: number
  session_id: string
  tool: string
  action: JournalAction
  suggestion_id: string | null
  target_path: string | null
  before_hash: string | null
  after_hash: string | null
  approval: string | null
  backup_ref: string | null
  detail: string | null
}

/** Input to `appendJournalRecord` — the writer computes the rest. */
export type JournalRecordInput = JournalRecordFields

/**
 * A fully-formed, on-disk journal record (one JSON-Lines row). `prev_hash`
 * chains to the previous record's `record_hash` (or `JOURNAL_GENESIS_HASH`
 * for the first record); `record_hash` commits to every other field
 * INCLUDING `prev_hash`, so any single-record tamper is detectable by
 * recomputing it — see `reader.ts:verifyJournalChain`.
 */
export interface JournalRecord extends JournalRecordFields {
  prev_hash: string
  record_hash: string
}
