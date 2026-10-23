/**
 * SMI-6531: the one way the skill-swap suites start a `skill-swap.child.mjs`
 * process and wait for it. The child compiles TypeScript at startup
 * (`node --import tsx`), so under a loaded full run it can take many seconds
 * to signal. Every wait here fails the moment the child exits without
 * signalling, naming its exit code and stderr, and otherwise at
 * `CHILD_READY_MS`, which is below `CHILD_TEST_TIMEOUT_MS`: a slow or dead
 * child surfaces as this module's error, never as a bare vitest timeout.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHILD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skill-swap.child.mjs'
)

/**
 * How long a child may take to start and signal. Measured under the full
 * 8-folder core run: at most about 13 s from spawn to its marker, so this is
 * several times the worst start seen.
 */
export const CHILD_READY_MS = 60_000
/**
 * For a test that starts children: two waits at `CHILD_READY_MS` (the longest
 * tests start two children) plus 30 s of the test's own work, so a slow start
 * is always reported by `waitForFile`, never by vitest's timeout.
 */
export const CHILD_TEST_TIMEOUT_MS = 2 * CHILD_READY_MS + 30_000

export interface ChildProc {
  /** Resolves when the process exits (never rejects). */
  exited: Promise<void>
  stderr: () => string
  stdout: () => string
  /** `{ code, signal }` once exited, else null. */
  exit: () => { code: number | null; signal: NodeJS.Signals | null } | null
  /** Rejects with the exit code and stderr if the process exits before `file` exists. */
  waitForFile: (file: string, what: string, deadlineMs?: number) => Promise<void>
}

/**
 * `fn` over `items` with at most `limit` running at once, results in input
 * order. Each child compiles TypeScript at startup, so starting a dozen at
 * once is a CPU burst that slows every other test file sharing the runner
 * (SMI-6531: the scanner timing tests in the same CI job). After one call
 * rejects, no further item is started; the rejection propagates.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapLimit: limit must be a positive integer, got ${limit}`)
  }
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Starts `node --import tsx skill-swap.child.mjs <args>`, capturing stdout, stderr and the exit. */
export function spawnChild(args: string[], exe: string = process.execPath): ChildProc {
  const child = spawn(exe, ['--import', 'tsx', CHILD_PATH, ...args])
  let spawnError: Error | null = null
  let out = ''
  let err = ''
  let ended: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.stdout.on('data', (d) => (out += String(d)))
  child.stderr.on('data', (d) => (err += String(d)))
  const exited = new Promise<void>((res) => {
    child.on('exit', (code, signal) => {
      ended = { code, signal }
      res()
    })
    // A spawn that fails (a missing executable) emits `error` and never `exit`.
    child.on('error', (e) => {
      spawnError = e
      res()
    })
  })
  const waitForFile = async (file: string, what: string, deadlineMs = CHILD_READY_MS) => {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (fs.existsSync(file)) return
      if (spawnError !== null) {
        throw new Error(
          `child could not be spawned before ${what}: ${(spawnError as Error).message}`
        )
      }
      if (ended !== null) {
        const e: { code: number | null; signal: NodeJS.Signals | null } = ended
        throw new Error(
          `child exited (code ${e.code}, signal ${e.signal}) before ${what}; stderr: ${err.trim() || '(empty)'}`
        )
      }
      if (Date.now() > deadline) {
        throw new Error(
          `child did not ${what} within ${deadlineMs} ms and is still running; stderr so far: ${err.trim() || '(empty)'}`
        )
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return {
    exited,
    stderr: () => err,
    stdout: () => out,
    exit: () => ended,
    waitForFile,
  }
}
