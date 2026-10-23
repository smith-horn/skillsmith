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

/** Starts `node --import tsx skill-swap.child.mjs <args>`, capturing stdout, stderr and the exit. */
export function spawnChild(args: string[]): ChildProc {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD_PATH, ...args])
  let out = ''
  let err = ''
  let ended: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.stdout.on('data', (d) => (out += String(d)))
  child.stderr.on('data', (d) => (err += String(d)))
  const exited = new Promise<void>((res) =>
    child.on('exit', (code, signal) => {
      ended = { code, signal }
      res()
    })
  )
  const waitForFile = async (file: string, what: string, deadlineMs = CHILD_READY_MS) => {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (fs.existsSync(file)) return
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
