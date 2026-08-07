#!/usr/bin/env tsx
/**
 * SMI-5941 — test-only worker process, spawned by mcp-disconnect-state.test.ts's
 * real-concurrency tests. Runs as a genuinely separate OS process (via `tsx`)
 * so the lock's mkdir-based mutual exclusion is exercised against actual
 * filesystem contention, not just in-process `Promise.all` over synchronous
 * calls (which plan-review pass 3 correctly noted could pass without ever
 * overlapping in the same event-loop tick).
 *
 * Synchronization: writes `readyFile` immediately, then busy-waits for
 * `goFile` to exist before doing its one unit of work — the test orchestrator
 * creates `goFile` only after every worker's `readyFile` exists, maximizing
 * the chance all workers attempt their work at nearly the same instant.
 *
 * Usage: tsx mcp-disconnect-worker.ts <mode> <readyFile> <goFile> <repoKey> <server> [extra...]
 *   record <repoKey> <server> <tool> <errorExcerpt>  — one recordDisconnect() call
 *   ack <repoKey> <server>                            — one readAndAck() call; prints JSON or "null"
 *   hold-lock <repoKey> <server> <holdMs>             — acquires withLock() and sleeps holdMs before releasing
 */

import { existsSync } from 'node:fs'
import { recordDisconnect, readAndAck, withLock } from '../retrieval-log/mcp-disconnect-state.js'
import { writeFileSync } from 'node:fs'

function sleepSyncMs(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

function waitForFile(path: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${path}`)
    sleepSyncMs(5)
  }
}

const [, , mode, readyFile, goFile, repoKey, server, ...rest] = process.argv

writeFileSync(readyFile, String(process.pid))
waitForFile(goFile)

if (mode === 'record') {
  const [tool, errorExcerpt] = rest
  recordDisconnect(repoKey, server as 'skillsmith' | 'skillsmith-doc-retrieval', {
    tool,
    errorExcerpt,
    timestamp: new Date().toISOString(),
  })
} else if (mode === 'ack') {
  const entry = readAndAck(repoKey, server as 'skillsmith' | 'skillsmith-doc-retrieval')
  process.stdout.write(entry ? JSON.stringify(entry) : 'null')
} else if (mode === 'hold-lock') {
  const [holdMs] = rest
  withLock(() => {
    sleepSyncMs(Number(holdMs))
  })
} else {
  process.stderr.write(`unknown mode: ${mode}\n`)
  process.exit(1)
}
