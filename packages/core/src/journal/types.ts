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

/**
 * Bump on a breaking shape change to `JournalRecord` — including adding a
 * new `JournalAction` literal, since `reader.ts`'s `isJournalRecordShape`
 * validates `action` against a closed set: an older reader encountering an
 * unrecognized value would misclassify a legitimate record as corrupt.
 * (SMI-5671 bumped 1 → 2 for exactly this reason, adding `'revert'`.)
 */
export const JOURNAL_SCHEMA_VERSION = 2

/**
 * `'apply'`   — an apply-family tool successfully mutated a file, or
 *               `swapInPlace` (tool `'update'`, SMI-6531) committed an
 *               in-place update of a skill folder.
 * `'error'`   — an apply-family tool attempted a mutation and it failed
 *               (the `detail` field carries the typed error kind).
 * `'undo'`    — `undo_apply` successfully restored a file from an apply on
 *               this process's session stack. The matching `'apply'`
 *               record may be missing: that apply's own append can have
 *               failed while the apply itself stood (SMI-6531).
 * `'revert'`  — `apply_namespace_rename`'s `action: 'revert'` successfully
 *               reversed a prior rename via the ledger (SMI-5671) — distinct
 *               from `'undo'`, which is `undo_apply`'s same-process,
 *               backup-restore mechanism.
 */
export type JournalAction = 'apply' | 'error' | 'undo' | 'revert'

/**
 * Every field the caller supplies. The writer (`writer.ts`) fills in
 * `prev_hash` + `record_hash` to complete a `JournalRecord`.
 *
 * Field semantics. Two writers fill these in: the apply-family tools
 * (`apply_namespace_rename`, `apply_recommended_edit`, `undo_apply`) and the
 * in-place update, `swapInPlace` (`tool: 'update'`, `action: 'apply'`, one
 * record per committed update, A1 plan §3.3 step 11). Where they differ, each
 * field says which meaning belongs to which tool.
 * - `tool` — the writer: an apply-family tool's name, or `'update'`.
 * - `suggestion_id` — apply-family: the `collisionId` the mutation was
 *   applied for. `update`: the transaction's `opId` (32 hex characters), the
 *   name of its op dir and of its backup.
 * - `target_path` — `update`: the skill DIRECTORY that was updated (the
 *   native realpath, `realDir`), not a file. Apply-family: the on-disk file
 *   whose CONTENT the record's hashes describe. For a single-file mutation (prose edit, command/agent rename)
 *   this is the mutated file itself. For a skill-directory rename
 *   (`rename_skill_dir_and_frontmatter`) this is `<newSkillDir>/SKILL.md` —
 *   the one file whose bytes actually changed; the directory rename itself
 *   is not content-hashable and is intentionally out of this record's scope
 *   (see `tools/apply-journal.helpers.ts` header in `@skillsmith/mcp-server`
 *   for the full rationale).
 * - `before_hash` / `after_hash` — apply-family: sha256 of `target_path`'s
 *   content immediately before / after the mutation. `update`: the A1 plan
 *   §3.4 TREE hashes of the folder, `preTree` (as planned and verified at step
 *   4) and `postTree` (the new folder as built), not a file's sha256. `null` where not applicable
 *   (e.g. an `'error'` record where the mutation never reached a
 *   content-changing step, so there is no "after" state to hash).
 * - `approval` — the caller-supplied approval mode that authorized the
 *   mutation, e.g. `'apply'` / `'custom'` (namespace rename) or
 *   `'apply_with_confirmation'` (recommended edit); `'update'` for an update
 *   record. Always non-null for
 *   `'apply'`/`'error'` records (the confirmation gate ran); `'undo'` for
 *   undo records.
 * - `backup_ref` — apply-family: absolute path to the apply tool's own
 *   pre-mutation backup directory (from `createSkillBackup` /
 *   `createProseBackup`). `update`: the old folder's backup path,
 *   `<stateRoot>/backups/update/<client>/<rootKey>/<dirName>/<opId>`, the same
 *   path `record.json` names; written before step 12 moves the folder there.
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
