/**
 * @fileoverview Change-journal writer — single-writer, fsync'd, hash-chained
 *               append (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/writer
 *
 * P-5 single-writer invariant (docs/internal/implementation/smi-5456-skillsmith-agent-wave1.md
 * "Shared-State / Coordination Audit"): every journal write goes through
 * `appendJournalRecord`. Its writers are the apply-family MCP tools
 * (`apply_namespace_rename`, `apply_recommended_edit`, `undo_apply`) and the
 * in-place update transaction (`swapInPlace`, SMI-6531 step 11). In one
 * process the appends serialize behind ONE module-scoped promise queue, so
 * concurrent callers produce well-formed, correctly-chained lines instead of
 * interleaved/torn writes.
 *
 * Across processes (SMI-6531, owner decision 2026-10-22) the queue is not
 * enough: two processes each read the same chain head and append a record
 * naming it, forking the chain. So each append also holds lock 5,
 * `withFileLock(<journal file>, …, { rank: '5' })` (the lock file is
 * `journal.jsonl.lock` beside it), from reading the head to the file sync and
 * the directory syncs. Lock 5 is a leaf: nothing is requested while it is
 * held. The queue stays as an in-process optimization (callers in one process
 * do not poll the file lock against each other). A lock that cannot be taken
 * (busy past its wait, an unparseable or foreign-host claim) rejects the
 * append. A rejection must cost only the journal record: the apply-family
 * helpers log it and still register the apply for `undo_apply`
 * (`apply-journal.helpers.ts`), and `swapInPlace` reports the update
 * committed with `incomplete: audit`, its record kept for doctor.
 *
 * Durability: each append opens the file, writes the line, calls
 * `FileHandle.sync()` (fsync), then closes, so the record's bytes are on disk
 * before the append resolves (the "fsync'd appends" requirement in the plan's
 * P-5 table). Directory entries: when this append's `mkdir` creates
 * directories, each created directory's parent is synced; when this append
 * creates `journal.jsonl`, the journal directory is synced. Nothing else is
 * synced: in particular, a journal directory another process created is not
 * re-synced in its parent here. A rejection can follow the fsynced write (a
 * failed directory sync), so a rejected append may still have left its
 * record in the file.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { withFileLock } from '../config/file-lock.js'
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
// this one queue, whichever writer called it.
let writeQueue: Promise<void> = Promise.resolve()

/**
 * Append a record to the journal. Serialized behind the module-scoped
 * write queue and fsync'd before the returned promise resolves.
 *
 * Callers (the apply-family tools and `swapInPlace`) treat a rejection as
 * fail-soft — the journal is an evidence trail, not a gate on the user's
 * mutation — and must not let it undo or hide the mutation: the apply-family
 * helpers log it and still register the apply for `undo_apply` (see
 * `tools/apply-journal.helpers.ts` in `@skillsmith/mcp-server`); `swapInPlace`
 * returns `committed` with `incomplete: audit` and keeps its record.
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

/** Lock 5's label (A1 plan §3.2's order table, owner decision 2026-10-22). */
const JOURNAL_LOCK_LABEL = 'the journal lock (lock 5)'

async function doAppend(input: JournalRecordInput): Promise<JournalRecord> {
  return underJournalLock(getJournalFilePath(), (filePath, madeDirs) =>
    appendLocked(input, filePath, madeDirs)
  )
}

/** Makes the journal directory, then runs `fn` under lock 5 for `filePath`. */
async function underJournalLock<T>(
  filePath: string,
  fn: (filePath: string, madeDirs: string[]) => Promise<T>
): Promise<T> {
  const journalDir = dirname(filePath)
  // The lock file lives in the journal directory, so the directory is made
  // first; the syncs of what this mkdir made run under the lock.
  const madeDirs = createdDirectories(await mkdir(journalDir, { recursive: true }), journalDir)
  return withFileLock(filePath, JOURNAL_LOCK_LABEL, () => fn(filePath, madeDirs), { rank: '5' })
}

/** What `appendJournalRecordOnce` did. */
export type AppendOnceOutcome =
  | { outcome: 'appended'; record: JournalRecord; file: string }
  /** A parseable line already names this `tool` and `suggestion_id`; nothing was written. */
  | { outcome: 'present'; file: string }
  /**
   * Nothing was written: the journal ends mid-line (no final newline) or with
   * an unparseable last line (`unparseable-tail`), or its last line parses but
   * names no chain head, `record_hash` (`no-chain-head`), so the chain cannot
   * be continued.
   */
  | { outcome: 'torn-tail'; file: string; why: 'unparseable-tail' | 'no-chain-head' }

/** Every parseable line of `raw` that is an object naming `tool` and `id`. */
function holdsRecordFor(raw: string, tool: string, id: string): boolean {
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (typeof v !== 'object' || v === null) continue
      const r = v as { tool?: unknown; suggestion_id?: unknown }
      if (r.tool === tool && r.suggestion_id === id) return true
    } catch {
      // An unparseable line (a torn tail, a corrupt middle) names nothing.
    }
  }
  return false
}

/** True when the journal's last line is unparseable or the file does not end with a newline. */
function tornTail(raw: string): boolean {
  if (raw === '') return false
  if (!raw.endsWith('\n')) return true
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return false
  try {
    JSON.parse(lines[lines.length - 1]!)
    return false
  } catch {
    return true
  }
}

/**
 * Doctor's audit append for an `incomplete: audit` update (SMI-6531 step 6a-ii,
 * A1 plan step 6). Under lock 5 it reads the journal and scans **every**
 * parseable line (not only the verified chain, which stops at a break) for a
 * record with this `tool` and `suggestion_id`; appends only if there is none;
 * and syncs the journal directory either way, since an earlier append can have
 * created the file and then failed that sync. A torn tail is `torn-tail`, not a
 * throw: the caller reports the record as not recorded (owner decision
 * 2026-10-26). `file` is a test seam (default `getJournalFilePath()`).
 */
export function appendJournalRecordOnce(
  input: JournalRecordInput,
  options: { file?: string } = {}
): Promise<AppendOnceOutcome> {
  const filePath = options.file ?? getJournalFilePath()
  const task = writeQueue.then(() =>
    underJournalLock(filePath, async (file, madeDirs): Promise<AppendOnceOutcome> => {
      let raw = ''
      try {
        raw = await readFile(file, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      if (holdsRecordFor(raw, input.tool, input.suggestion_id ?? '')) {
        for (const made of madeDirs) await syncOrReject(dirname(made))
        await syncOrReject(dirname(file))
        return { outcome: 'present', file }
      }
      if (tornTail(raw)) return { outcome: 'torn-tail', file, why: 'unparseable-tail' }
      let record: JournalRecord
      try {
        record = await appendLocked(input, file, madeDirs)
      } catch (err) {
        // A last line that parses but names no chain head: as unappendable as a torn one.
        if (isCorruptTailError(err)) return { outcome: 'torn-tail', file, why: 'no-chain-head' }
        throw err
      }
      await syncOrReject(dirname(file))
      return { outcome: 'appended', record, file }
    })
  )
  writeQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

async function appendLocked(
  input: JournalRecordInput,
  filePath: string,
  madeDirs: string[]
): Promise<JournalRecord> {
  const journalDir = dirname(filePath)
  // Each directory this mkdir made is an entry in its parent, so the parent is
  // synced (top-down) before anything is written below it.
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
