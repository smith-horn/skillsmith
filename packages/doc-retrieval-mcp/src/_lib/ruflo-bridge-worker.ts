#!/usr/bin/env tsx
/**
 * SMI-6744 — test-only worker process, spawned by ruflo-bridge-state.test.ts's
 * real-concurrency arm (arm 5). Runs as a genuinely separate OS process (via
 * `tsx`), matching `mcp-disconnect-worker.ts`'s own established precedent and
 * its reason: plan-review pass 3 found that synchronous `mkdirSync`-based
 * calls wrapped in an in-process `Promise.all` can run sequentially within
 * one event-loop tick with no real overlap, which would let a narrowed-lock
 * mutant pass the "exactly one probe" assertion by sheer timing luck.
 *
 * Synchronization: writes `readyFile` immediately, then busy-waits for
 * `goFile` to exist before doing its one simulated probe run — the test
 * orchestrator creates `goFile` only after every worker's `readyFile` exists,
 * maximizing the chance all workers attempt their run at nearly the same
 * instant (Sol round 2 finding 3's "instrumented barrier").
 *
 * Usage:
 *   tsx ruflo-bridge-worker.ts <mode> <readyFile> <goFile> <resultFile> <key> <verdict> <probeDelayMs>
 *
 *   mode "correct": acquires the lock BEFORE deciding/probing/writing and
 *     holds it through the write (the design this delta specifies). Writes
 *     `<resultFile>.probed` only once it has decided (under the lock) that a
 *     probe should run — so the count of `.probed` files across workers IS
 *     the "how many probes ran" assertion.
 *   mode "buggy": decides (reads `readState()` unlocked) and "probes"
 *     (sleeps `probeDelayMs`, unlocked) BEFORE acquiring any lock — the lock
 *     wraps only the final `writeEntryIfOwned` call. This is the
 *     "narrow the lock to the write alone" mutation named in the spec,
 *     reproduced here as an actual alternate code path (not a source edit)
 *     so the test can run both orchestrations in the same process space.
 *
 * `SKILLSMITH_STATE_DIR_OVERRIDE` must be set in this process's env (the test
 * sets it identically for both spawned workers) so they share one state file
 * and one lock.
 */

import { existsSync, writeFileSync } from 'node:fs'

import {
  acquireBridgeLock,
  readState,
  releaseBridgeLock,
  shouldProbe,
  writeEntryIfOwned,
  type BridgeEntry,
} from '../retrieval-log/ruflo-bridge-state.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function buildEntry(verdict: string): BridgeEntry {
  return {
    evaluatedAt: new Date().toISOString(),
    verdict,
    reason: `worker-simulated ${verdict}`,
    observedBackend: verdict === 'degraded' ? 'mock' : verdict === 'healthy' ? 'onnx' : null,
    derivedFromVersion: '3.42.4',
    patternsLearned: null,
    trajectoriesRecorded: null,
    consecutiveNoLearning: 0,
    // SMI-6967 H-9/H-1 added these fields to BridgeEntry. This worker only
    // exercises lock/orchestration concurrency (arm 5), never the liveness
    // arm, so a fixed dormant/no-baseline shape is correct here.
    everProducerPresent: false,
    everLearned: false,
    countersRegressed: false,
    lastObservedPatternsLearned: null,
    lastObservedTrajectoriesRecorded: null,
  }
}

async function main(): Promise<void> {
  const [, , mode, readyFile, goFile, resultFile, key, verdict, probeDelayStr] = process.argv
  const probeDelayMs = Number(probeDelayStr) || 0

  writeFileSync(readyFile, String(process.pid))
  waitForFile(goFile)

  if (mode === 'correct') {
    const handle = await acquireBridgeLock(5000)
    if (!handle) {
      writeFileSync(resultFile, 'NO-LOCK')
      return
    }
    const prior = readState()[key] ?? null
    if (!shouldProbe(prior, Date.now())) {
      releaseBridgeLock(handle)
      writeFileSync(resultFile, 'DECLINED')
      return
    }
    writeFileSync(`${resultFile}.probed`, '1')
    await sleep(probeDelayMs) // simulated probe latency, held under the lock
    const wrote = writeEntryIfOwned(key, buildEntry(verdict), handle)
    releaseBridgeLock(handle)
    writeFileSync(resultFile, wrote ? 'WROTE' : 'TOKEN-LOST')
    return
  }

  if (mode === 'buggy') {
    // Decide and "probe" WITHOUT holding any lock — the mutation under test.
    const prior = readState()[key] ?? null
    const doProbe = shouldProbe(prior, Date.now())
    if (doProbe) writeFileSync(`${resultFile}.probed`, '1')
    await sleep(probeDelayMs) // simulated probe latency, UNLOCKED
    if (!doProbe) {
      writeFileSync(resultFile, 'DECLINED')
      return
    }
    const handle = await acquireBridgeLock(5000) // lock wraps ONLY the write
    if (!handle) {
      writeFileSync(resultFile, 'NO-LOCK')
      return
    }
    const wrote = writeEntryIfOwned(key, buildEntry(verdict), handle)
    releaseBridgeLock(handle)
    writeFileSync(resultFile, wrote ? 'WROTE' : 'TOKEN-LOST')
    return
  }

  process.stderr.write(`unknown mode: ${mode}\n`)
  process.exitCode = 1
}

main().catch((e) => {
  process.stderr.write(`ruflo-bridge-worker fatal: ${e?.stack ?? e}\n`)
  process.exitCode = 1
})
