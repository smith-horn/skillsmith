/**
 * @fileoverview Change-journal record shape (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/types
 *
 * The journal is the trust-loop evidence base described in
 * docs/internal/product/prd-skillsmith-agent.md §7: an append-only,
 * hash-chained record of every mutation the apply-family MCP tools make
 * (`apply_namespace_rename`, `apply_recommended_edit`) plus the `undo_apply`
 * tool that reverses them, and of every in-place skill update `swapInPlace`
 * commits (`tool: 'update'`, SMI-6531). It is the substrate PRD §10 exclusion 1 points at
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
 * Field semantics. Two writers fill these in: the apply-family helpers in
 * `@skillsmith/mcp-server`'s `tools/apply-journal.helpers.ts`
 * (`journalApplySuccess`, `journalApplyError`, `journalUndo`) and the in-place
 * update, `swapInPlace` (one `action: 'apply'` record per committed update, A1
 * plan §3.3 step 11). Each field says which meaning belongs to which record.
 * - `tool` — the tool whose mutation the record describes: `'apply_namespace_rename'`,
 *   `'apply_recommended_edit'`, or `'update'`. An `'undo'` record carries the
 *   tool of the apply it undid (with `action: 'undo'`), not `'undo_apply'`.
 * - `action` — `'apply'` / `'revert'` (a successful mutation), `'error'` (a
 *   failed attempt), `'undo'` (an `undo_apply` restore); `update` records are
 *   always `'apply'`.
 * - `suggestion_id` — apply-family: the `collisionId` the mutation was
 *   applied for. `update`: the transaction's `opId` (by default 128 random
 *   bits as 32 hex characters; a test seam can inject another), the name of
 *   its op dir and of its backup.
 * - `target_path` — `update`: the skill DIRECTORY that was updated (the
 *   native realpath, `realDir`), not a file. Apply-family: the on-disk file
 *   whose CONTENT the record's hashes describe: the mutated file itself for a
 *   single-file mutation (prose edit, command/agent rename), and
 *   `<newSkillDir>/SKILL.md` for a skill-directory rename
 *   (`rename_skill_dir_and_frontmatter`), the one file whose bytes changed;
 *   the directory rename itself is out of this record's scope (see
 *   `tools/apply-journal.helpers.ts`'s header for the rationale). May be
 *   `null` on an `'error'` record.
 * - `before_hash` / `after_hash` — apply-family: sha256 of `target_path`'s
 *   content (`null` wherever the file cannot be read). On a successful apply
 *   with a backup, `before_hash` is the hash of the backup's copy of the file
 *   (`null` when that copy could not be resolved) and `after_hash` the file
 *   now. On an idempotent no-op both are
 *   the current hash. On a genuine revert `before_hash` is `null` (no fresh
 *   backup exists to hash) and `after_hash` the file now. On an `'error'`
 *   record both are `null`. On an `'undo'` record they are the file's hash
 *   just before and just after the restore. `update`: the A1 plan §3.4 TREE
 *   hashes of the folder, `preTree` (as planned and re-verified at step 4) and
 *   `postTree` (the new folder as built), not a file's sha256.
 * - `approval` — apply-family: the approval mode the caller passed:
 *   `'apply'` / `'custom'` / `'revert'` for `apply_namespace_rename`,
 *   `'apply_with_confirmation'` for `apply_recommended_edit` (both tools run
 *   their `confirmed: true` gate before mutating), `'undo'` on an
 *   `'undo'` record. `update`: the constant `'update'`; no confirmation gate
 *   runs inside `swapInPlace`, which records it whatever its caller did.
 * - `backup_ref` — apply-family: the absolute path of the apply tool's own
 *   pre-mutation backup directory (from `createSkillBackup` /
 *   `createProseBackup`) on a successful apply that took one. `null` on a
 *   revert, on an idempotent no-op, on an `'error'` record and on an
 *   `'undo'` record. `update`: the old folder's backup path,
 *   `<realpath(stateRoot)>/backups/update/<client>/<rootKey>/<dirName>/<opId>`,
 *   the same path `record.json` names, written before step 12 moves the folder
 *   there (it is absent when the move did not happen; see `SwapResult`'s
 *   `incomplete`). The tree there does not always hash to `before_hash`: when
 *   step 9 warned `backup-holds-foreign-change`, a foreign write landed in the
 *   old folder before rename 1 and is in the backup.
 * - `detail` — the typed error `kind` (e.g. `'namespace.rename.backup_failed'`)
 *   on an `'error'` record; `'idempotent_no_op'` on an idempotent no-op
 *   (`action` `'apply'` or `'revert'`); `'backup_file_unresolved'` on a
 *   successful apply whose backup directory could not be read or holds no
 *   single file for `target_path` (`resolveBackupFileName` returned null);
 *   `null`
 *   otherwise, including every `'undo'` and `update` record.
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
