/**
 * @fileoverview Change-journal writer — single-writer, fsync'd, hash-chained
 *               append (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/writer
 *
 * P-5 single-writer invariant (docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md
 * "Shared-State / Coordination Audit"): the journal file is written by the
 * apply-family MCP tools ONLY, and every writer in this process funnels
 * through `appendJournalRecord`, which serializes behind ONE module-scoped
 * promise queue. That queue — not any per-caller locking — is what makes
 * concurrent `apply_namespace_rename` / `apply_recommended_edit` / `undo_apply`
 * calls in the same server process produce well-formed, correctly-chained
 * lines instead of interleaved/torn writes.
 *
 * Durability: each append opens the file, writes the line, calls
 * `FileHandle.sync()` (fsync), then closes — so a record that returns
 * successfully is durable on disk before the caller's apply/undo response
 * goes out, matching the "fsync'd appends" requirement in the plan's P-5
 * table.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { syncDirectory } from '../install/dir-sync.js'
import { JOURNAL_GENESIS_HASH, sha256Hex } from './hash.js'
import { getJournalFilePath } from './path.js'
import type { JournalRecord, JournalRecordInput } from './types.js'

/**
 * Canonical (fixed-key-order) JSON of every hash-chain-relevant field,
 * INCLUDING `prev_hash` but EXCLUDING `record_hash` itself. Plain
 * `JSON.stringify` is sufficient canonicalization here because the object
 * literal below is always constructed with the same key order — a full
 * canonical-JSON library would be overkill for a single fixed shape.
 */
function canonicalFields(record: Omit<JournalRecord, 'record_hash'>): string {
  const ordered = {
    schema: record.schema,
    ts: record.ts,
    session_id: record.session_id,
    tool: record.tool,
    action: record.action,
    suggestion_id: record.suggestion_id,
    target_path: record.target_path,
    before_hash: record.before_hash,
    after_hash: record.after_hash,
    approval: record.approval,
    backup_ref: record.backup_ref,
    detail: record.detail,
    prev_hash: record.prev_hash,
  }
  return JSON.stringify(ordered)
}

/**
 * Recompute a record's `record_hash` from its other fields. Exported so the
 * reader can independently verify each line without duplicating the
 * canonicalization logic (drift between writer and reader would silently
 * break every chain-verification call).
 */
export function computeRecordHash(record: Omit<JournalRecord, 'record_hash'>): string {
  return sha256Hex(canonicalFields(record))
}

/**
 * Error thrown when the journal's last line cannot be parsed as a valid
 * record — the writer cannot safely determine the chain head to append
 * after. This is distinct from the reader's "corrupt tail = report, never
 * throw" contract: a reader is producing evidence about the past and must
 * degrade gracefully; a writer is about to create NEW evidence and silently
 * starting a fresh chain over a corrupt/tampered tail would hide exactly
 * the tamper signal the chain exists to surface.
 */
export interface JournalCorruptTailError extends Error {
  kind: 'journal.write.corrupt_tail'
}

export function isCorruptTailError(err: unknown): err is JournalCorruptTailError {
  return (
    err instanceof Error &&
    (err as Partial<JournalCorruptTailError>).kind === 'journal.write.corrupt_tail'
  )
}

async function getLastRecordHash(filePath: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return JOURNAL_GENESIS_HASH
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return JOURNAL_GENESIS_HASH

  const lastLine = lines[lines.length - 1]!
  try {
    const parsed = JSON.parse(lastLine) as Partial<JournalRecord>
    if (typeof parsed.record_hash === 'string' && parsed.record_hash.length > 0) {
      return parsed.record_hash
    }
  } catch {
    // fall through to the corrupt-tail error below
  }

  const err = new Error(
    'journal tail is corrupt or unparseable; refusing to append past an unverifiable chain head'
  ) as JournalCorruptTailError
  err.kind = 'journal.write.corrupt_tail'
  throw err
}

// P-5 single-writer invariant: every append in this process funnels through
// this one queue, regardless of which apply-family tool called it.
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Append a record to the journal. Serialized behind the module-scoped
 * write queue and fsync'd before the returned promise resolves.
 *
 * Callers (the apply-family tools) should treat a rejection as fail-soft —
 * the journal is an evidence trail, not a gate on the user's mutation —
 * and log rather than propagate. See `tools/apply-journal.helpers.ts` in
 * `@skillsmith/mcp-server` for the call-site convention.
 */
export function appendJournalRecord(input: JournalRecordInput): Promise<JournalRecord> {
  const task = writeQueue.then(() => doAppend(input))
  // A rejected append must not wedge the queue for subsequent callers.
  writeQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

/**
 * The directories a recursive `mkdir` created, top-down. `first` is what
 * `mkdir({ recursive: true })` returned (the first directory it made, or
 * `undefined` when nothing was created); `leaf` is the directory asked for.
 */
function createdDirectories(first: string | undefined, leaf: string): string[] {
  if (first === undefined) return []
  const top = resolve(first)
  const chain: string[] = []
  for (let p = resolve(leaf); ; p = dirname(p)) {
    chain.unshift(p)
    if (p === top || dirname(p) === p) return chain
  }
}

/**
 * `fsync` a directory so an entry made in it survives a crash. `unsupported`
 * (a filesystem or platform that cannot sync a directory) is accepted; a
 * `failed` sync rejects the append, since the record's file or directory may
 * not survive a crash.
 */
async function syncOrReject(dir: string): Promise<void> {
  const synced = await syncDirectory(dir)
  if (synced.outcome === 'failed') {
    throw new Error(
      `journal directory ${dir} could not be synced after creating an entry in it (${synced.code})`,
      { cause: synced.error }
    )
  }
}

async function doAppend(input: JournalRecordInput): Promise<JournalRecord> {
  const filePath = getJournalFilePath()
  const journalDir = dirname(filePath)
  // Each directory this mkdir made is an entry in its parent, so the parent is
  // synced (top-down) before anything is written below it.
  const madeDirs = createdDirectories(await mkdir(journalDir, { recursive: true }), journalDir)
  for (const made of madeDirs) await syncOrReject(dirname(made))

  // Propagates as-is (including `JournalCorruptTailError`) — callers use
  // `isCorruptTailError` to distinguish it from a generic I/O failure.
  const prevHash = await getLastRecordHash(filePath)

  const withoutHash: Omit<JournalRecord, 'record_hash'> = { ...input, prev_hash: prevHash }
  const record: JournalRecord = { ...withoutHash, record_hash: computeRecordHash(withoutHash) }

  const line = JSON.stringify(record) + '\n'
  // `'ax'` (O_CREAT|O_EXCL) creates the file atomically and fails with EEXIST
  // when it is already there, so "this append created the file" is decided by
  // the open itself. A separate `lstat` before an `'a'` open would leave a gap
  // in which another creator could win and this append would sync for nothing
  // (or skip the sync for a file it did create).
  let created = true
  let handle: FileHandle
  try {
    handle = await open(filePath, 'ax')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    created = false
    handle = await open(filePath, 'a')
  }
  try {
    await handle.appendFile(line, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // The new file is an entry in the journal directory: sync it so the record
  // is reachable after a crash, not only its bytes.
  if (created) await syncOrReject(journalDir)

  return record
}
