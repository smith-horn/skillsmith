/**
 * SMI-5615: Per-surface serialized JSONL writer with daily/size rollover and
 * retention sweep.
 *
 * Write-serialization invariant (F2, from
 * docs/internal/implementation/production-error-logging.md — the plan's
 * original P-5 draft omitted this; it was the Opus `concurrency-auditor`
 * plan-audit's most likely real-world race):
 *
 *   A redacted error record (stack ≤20 frames) can exceed `PIPE_BUF`
 *   (4096 bytes), so concurrent, independent `appendFile`/`appendFileSync`
 *   calls from parallel async tool invocations are NOT safe here — two
 *   large concurrent writes can interleave/tear into one invalid JSONL line.
 *
 *   Fix: one long-lived `fs.createWriteStream(path, { flags: 'a' })` per
 *   surface, created lazily on first write and cached in a module-scoped
 *   map. ALL writes for a given surface go through THIS single stream.
 *
 *   That alone (Node serializing writes queued on one stream) would already
 *   prevent tearing between two writes to the SAME stream object. This
 *   module goes one step further for simplicity and an even stronger
 *   guarantee: every write is wrapped in an async mutex (`runExclusive`) keyed
 *   by surface, so at most one write is ever in flight to a surface's
 *   underlying file descriptor at a time — including the write that decides
 *   whether a daily/size rollover is needed. That decision-and-possible-swap
 *   (open a new stream, `end()` the old one) happens INSIDE the same
 *   exclusive section as the write that triggered it, so a rotation can
 *   never race a write: no write can land on a stream that has already been
 *   told to `end()`, and no two writers can simultaneously decide "today's
 *   file doesn't exist yet" and both create a stream.
 *
 * Daily rollover: `skillsmith-<surface>-<YYYY-MM-DD>.jsonl`, keyed off the
 * calendar date at write time (mocked by `vi.setSystemTime` in tests — no
 * separate clock seam needed).
 *
 * Size cap: ~10MB per file. When the currently-open file for TODAY would
 * exceed the cap, roll to a `.1`/`.2`/... suffixed continuation file for the
 * same day (`skillsmith-<surface>-<YYYY-MM-DD>.jsonl.<n>`), through the same
 * serialization point as everything else.
 *
 * Retention: on module init, asynchronously (NOT awaited — never blocks
 * import) sweep `~/.skillsmith/logs/` and delete files whose mtime is older
 * than 14 days. `pruneExpiredLogs` is also exported directly so tests can
 * await a deterministic run against a temp directory instead of racing the
 * fire-and-forget module-init sweep.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Surface } from './types.js'

const SIZE_CAP_BYTES = 10 * 1024 * 1024 // ~10MB per file (F2)
const RETENTION_DAYS = 14

/**
 * Log directory. Overridable via `SKILLSMITH_LOG_DIR` — a test-only seam
 * (not part of the plan's documented env-var surface) so `rotation.test.ts`
 * can point writes/sweeps at a temp directory instead of the real
 * `~/.skillsmith/logs/`. Read lazily (not frozen at import time) so a test
 * can set the env var before its first write without needing
 * `vi.resetModules()`.
 *
 * SMI-5793: `SKILLSMITH_STATE_DIR_OVERRIDE` is a second, purpose-named
 * precedence tier (checked after the `SKILLSMITH_LOG_DIR` test seam, before
 * the `homedir()` fallback) — production container→host bridging for the
 * doc-retrieval reindex CLI, which runs inside `skillsmith-dev-1` and needs
 * its disk writes to land on a bind-mounted, host-visible path
 * (`docker-compose.yml`'s `${HOME}/.skillsmith:/skillsmith-state` mount)
 * rather than the container's own throwaway `homedir()`. Deliberately a
 * separate var from `SKILLSMITH_LOG_DIR` so this production path-bridging
 * concern never blurs with that var's documented test-isolation-only intent.
 */
function getLogDir(): string {
  if (process.env.SKILLSMITH_LOG_DIR) return process.env.SKILLSMITH_LOG_DIR
  if (process.env.SKILLSMITH_STATE_DIR_OVERRIDE) {
    return join(process.env.SKILLSMITH_STATE_DIR_OVERRIDE, 'logs')
  }
  return join(homedir(), '.skillsmith', 'logs')
}

function dailyFilePath(surface: Surface, date: string): string {
  return join(getLogDir(), `skillsmith-${surface}-${date}.jsonl`)
}

/** Next available `.N` continuation suffix for today's file, same day only. */
function nextRolledFilePath(surface: Surface, date: string): string {
  const base = dailyFilePath(surface, date)
  let n = 1
  while (existsSync(`${base}.${n}`)) n++
  return `${base}.${n}`
}

function statSizeOrZero(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function todayDateString(): string {
  return new Date().toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Async mutex — one FIFO queue per surface. `runExclusive` serializes both
// the rollover decision AND the write itself, so at most one write is ever
// in flight per surface (F2).
// ---------------------------------------------------------------------------

const queueTails = new Map<Surface, Promise<void>>()

function runExclusive<T>(surface: Surface, task: () => Promise<T>): Promise<T> {
  const tail = queueTails.get(surface) ?? Promise.resolve()
  // Run `task` after the prior tail settles, whether it resolved or
  // rejected — one surface's failed write must not permanently jam the
  // queue for that surface's subsequent writes.
  const result = tail.then(task, task)
  // Keep the queue's tail alive regardless of `task`'s outcome; the real
  // outcome is still observable to the caller via `result`.
  queueTails.set(
    surface,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

// ---------------------------------------------------------------------------
// Per-surface stream state
// ---------------------------------------------------------------------------

interface SurfaceState {
  stream: WriteStream | null
  date: string | null
  sizeBytes: number
}

const states = new Map<Surface, SurfaceState>()

function getState(surface: Surface): SurfaceState {
  let state = states.get(surface)
  if (!state) {
    state = { stream: null, date: null, sizeBytes: 0 }
    states.set(surface, state)
  }
  return state
}

/**
 * Ends a stream and resolves once it has fully finished (or errored) — never
 * rejects, so a close failure can't block the caller from opening the
 * replacement stream.
 */
function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve()
    stream.once('error', done)
    stream.end(done)
  })
}

/**
 * Opens `filePath` for append and resolves once the underlying fd is open
 * (or rejects if `open()` itself fails, e.g. permission denied) — waiting
 * for `'open'`/`'error'` rather than trusting `createWriteStream`'s
 * synchronous return lets an unwritable path surface as a rejected Promise
 * instead of a later unhandled `'error'` event.
 */
function openStream(filePath: string): Promise<WriteStream> {
  return new Promise<WriteStream>((resolve, reject) => {
    const stream = createWriteStream(filePath, { flags: 'a' })
    const onOpen = () => {
      cleanup()
      resolve(stream)
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    function cleanup() {
      stream.off('open', onOpen)
      stream.off('error', onError)
    }
    stream.once('open', onOpen)
    stream.once('error', onError)
  }).then((stream) => {
    // Persistent handler for errors that occur AFTER open (disk full, etc.)
    // — required so an unlistened 'error' event never crashes the process.
    // Actual write failures are still propagated to the caller via the
    // write() callback in `writeChunk`; this is a pure safety net.
    stream.on('error', (err) => {
      console.error('[skillsmith] log stream error:', err instanceof Error ? err.message : err)
    })
    return stream
  })
}

function writeChunk(stream: WriteStream, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Resolves the stream to write to for `surface` RIGHT NOW, opening a new one
 * (and ending the old one) if the calendar day changed or the current file
 * has exceeded the size cap. Must only be called from inside
 * `runExclusive(surface, ...)` — it is not itself lock-protected.
 */
async function resolveStream(surface: Surface): Promise<WriteStream> {
  const state = getState(surface)
  const today = todayDateString()
  const isNewDay = state.stream === null || state.date !== today
  const isOversized = !isNewDay && state.sizeBytes >= SIZE_CAP_BYTES

  if (isNewDay || isOversized) {
    if (state.stream) {
      await closeStream(state.stream)
    }
    await mkdir(getLogDir(), { recursive: true })
    const filePath = isOversized
      ? nextRolledFilePath(surface, today)
      : dailyFilePath(surface, today)
    const stream = await openStream(filePath)
    state.stream = stream
    state.date = today
    // Stat the target file so reopening a same-day file across a process
    // restart still enforces the cap accurately, instead of resetting to 0
    // and silently growing the already-oversized base file further.
    state.sizeBytes = statSizeOrZero(filePath)
  }

  // `resolveStream` only sets `state.stream` to a non-null value above, and
  // this function is the sole place that ever nulls or reassigns it, so the
  // non-null assertion here is safe.
  return state.stream!
}

/**
 * Serializes `line` for `surface`: acquires that surface's exclusive queue,
 * resolves (opening/rotating as needed) the current stream, and writes.
 * Resolves once the OS-level write has completed; rejects (never throws
 * synchronously) if the directory/file couldn't be created or the write
 * failed — callers (see `logger.ts`) must handle rejection to honor the
 * "logger never throws" invariant.
 */
export function writeLogLine(surface: Surface, line: string): Promise<void> {
  return runExclusive(surface, async () => {
    const stream = await resolveStream(surface)
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    await writeChunk(stream, buf)
    getState(surface).sizeBytes += buf.length
  })
}

// ---------------------------------------------------------------------------
// Retention sweep
// ---------------------------------------------------------------------------

/**
 * Deletes files under the log directory whose mtime is older than
 * `RETENTION_DAYS`. Best-effort: a missing directory or a per-file stat/
 * unlink failure (permissions, a concurrent process already deleted it,
 * etc.) is swallowed rather than thrown — this must never be able to crash
 * module init or take down a caller that awaits it in a test.
 *
 * Exported (not just fired at module init) so tests can await a
 * deterministic run against a temp directory rather than racing the
 * fire-and-forget call below.
 */
export async function pruneExpiredLogs(): Promise<void> {
  const dir = getLogDir()
  try {
    if (!existsSync(dir)) return
    const entries = await readdir(dir)
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name)
        try {
          const info = await stat(full)
          if (info.isFile() && info.mtimeMs < cutoff) {
            await unlink(full)
          }
        } catch {
          // Best-effort per-file; ignore and move on.
        }
      })
    )
  } catch {
    // Best-effort overall; never throw from module init.
  }
}

// Fire-and-forget at module load — async, non-blocking, intentionally not
// awaited (F2: "unrelated to the active writer"). Skipped under Vitest
// (`process.env.VITEST` is set automatically by the test runner, not
// something call sites configure) and via an explicit opt-out, so merely
// IMPORTING this module — which every `logger.test.ts`/`redact.test.ts` run
// does transitively — never sweeps the real `~/.skillsmith/logs/` directory
// as a side effect. Tests call `pruneExpiredLogs()` directly against
// `SKILLSMITH_LOG_DIR` instead, for a deterministic, awaitable run.
if (process.env.VITEST !== 'true' && process.env.SKILLSMITH_LOG_DISABLE_STARTUP_SWEEP !== '1') {
  void pruneExpiredLogs()
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/**
 * Closes any open streams and clears all in-memory state. Test-only — used
 * by `rotation.test.ts` between cases so state from one temp-dir scenario
 * never leaks into the next.
 */
export async function __resetLoggingStateForTests(): Promise<void> {
  const closes: Promise<void>[] = []
  for (const state of states.values()) {
    if (state.stream) closes.push(closeStream(state.stream))
  }
  await Promise.all(closes)
  states.clear()
  queueTails.clear()
}
