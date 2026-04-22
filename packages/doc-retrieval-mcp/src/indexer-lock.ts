// SMI-4426: Single-writer discipline for the RuVector storagePath. The native
// binding provides no OS-level lock, so we coordinate indexer processes via an
// exclusive-create lockfile inside the storage directory. Stale locks whose
// holder is dead (kill -0 ESRCH) are broken automatically.
//
// Node's built-in fs module has no flock API — this PID-based pattern is the
// portable alternative (SMI-4426 plan-review amendments A/B).

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AcquireLockOptions {
  /** Max time (ms) to wait for an existing lock to clear. Default 30000. */
  timeoutMs?: number
  /** Poll interval while waiting (ms). Default 100. */
  pollMs?: number
  /** Liveness probe override for tests; real callers rely on process.kill(pid, 0). */
  probeAlive?: (pid: number) => boolean
  /** Self-pid override for tests. */
  selfPid?: number
  /** Register signal/exit cleanup handlers. Default true. */
  registerHandlers?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 100

/**
 * Acquire the indexer lock. Returns a release callback the caller MUST invoke
 * on normal completion. Signal/exit handlers registered on top are a safety
 * net — SIGKILL still leaves the lock behind, but the next run's kill -0
 * staleness check breaks it.
 *
 * @throws Error('indexer lock timeout ...') when acquisition exceeds timeoutMs
 * while the existing holder remains alive.
 */
export async function acquireIndexerLock(
  storagePath: string,
  opts: AcquireLockOptions = {}
): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const probeAlive = opts.probeAlive ?? defaultProbeAlive
  const selfPid = opts.selfPid ?? process.pid
  const registerHandlers = opts.registerHandlers ?? true
  const lockPath = join(storagePath, '.indexer.lock')

  mkdirSync(storagePath, { recursive: true })

  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, `${selfPid}\n${new Date().toISOString()}\n`)
      closeSync(fd)
      return registerRelease(lockPath, registerHandlers)
    } catch (err) {
      if (!isEexist(err)) throw err

      if (breakIfStale(lockPath, probeAlive)) {
        continue
      }

      if (Date.now() > deadline) {
        throw new Error(
          `indexer lock timeout after ${timeoutMs}ms. Held by another live process at ${lockPath}.`
        )
      }

      await sleep(pollMs)
    }
  }
}

function breakIfStale(lockPath: string, probeAlive: (pid: number) => boolean): boolean {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }

  const pidStr = raw.split('\n')[0]?.trim()
  const pid = Number.parseInt(pidStr ?? '', 10)

  if (!Number.isFinite(pid) || pid <= 0) {
    tryUnlink(lockPath)
    return true
  }

  if (!probeAlive(pid)) {
    tryUnlink(lockPath)
    return true
  }

  return false
}

function defaultProbeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM: process exists but is owned by another user. Treat as alive so we
    // don't trample a real writer.
    return code === 'EPERM'
  }
}

function registerRelease(lockPath: string, registerHandlers: boolean): () => void {
  let released = false

  const release = (): void => {
    if (released) return
    released = true
    tryUnlink(lockPath)
  }

  if (registerHandlers) {
    const onSignal = (): void => {
      release()
      process.exit(1)
    }
    const onUncaught = (err: Error): void => {
      release()
      // Re-throw so Node's default handler prints the stack and exits non-zero.
      throw err
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    process.once('exit', release)
    process.once('uncaughtException', onUncaught)
  }

  return release
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone — concurrent winner deleted it.
  }
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
