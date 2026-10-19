#!/usr/bin/env node
/**
 * Cross-process child for lock-tracker.cross-process.test.ts (SMI-6531 T-L3).
 * Plain `.mjs` and not a `.test.ts`, so it sits outside every vitest glob.
 *
 * Spawned as:
 *   node --import tsx lock-tracker.cross-process.child.mjs <role> <dir> <tracker> <timeoutMs>
 *
 *   role      A: take lock 1, then (once B holds lock 3) request lock 3.
 *             B: take lock 3, then (once A holds lock 1) request lock 1.
 *   tracker   "on" or "off" (setLockTrackerEnabledForTests).
 *   timeoutMs how long the SECOND request waits before StuckLockError.
 *
 * The two children rendezvous through marker files in <dir>, not sleeps.
 * Prints one JSON line to stdout: the second request's outcome.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '../../../src/config/file-lock.ts'
import { setLockTrackerEnabledForTests, LockOrderError } from '../../../src/config/lock-tracker.ts'
import { StuckLockError } from '../../../src/config/owned-lock.ts'

const [role, dir, tracker, timeoutArg] = process.argv.slice(2)
const timeoutMs = Number(timeoutArg)
setLockTrackerEnabledForTests(tracker === 'on')

const lock1Target = join(dir, 'root.lock-target')
const lock3Target = join(dir, 'manifest.json')

function mark(name) {
  writeFileSync(join(dir, name), String(Date.now()))
}

async function waitForMarker(name) {
  const deadline = Date.now() + 15_000
  while (!existsSync(join(dir, name))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for marker ${name}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function describeError(err) {
  if (err instanceof LockOrderError) return `LockOrderError:${err.kind}`
  if (err instanceof StuckLockError) return `StuckLockError:${err.reason}`
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

const first =
  role === 'A'
    ? { target: lock1Target, rank: '1', holds: 'a-holds-1', waitFor: 'b-holds-3' }
    : { target: lock3Target, rank: '3', holds: 'b-holds-3', waitFor: 'a-holds-1' }
const second =
  role === 'A'
    ? { target: lock3Target, rank: '3', label: 'A-lock-3' }
    : { target: lock1Target, rank: '1', label: 'B-lock-1' }

const result = { role, outcome: 'unset', requestedAt: 0, settledAt: 0, releasedFirstAt: 0 }

try {
  await withFileLock(
    first.target,
    `${role}-first`,
    async () => {
      mark(first.holds)
      await waitForMarker(first.waitFor)
      result.requestedAt = Date.now()
      try {
        await withFileLock(second.target, second.label, async () => {}, {
          rank: second.rank,
          timeoutMs,
        })
        result.outcome = 'acquired'
      } catch (err) {
        result.outcome = describeError(err)
      }
      result.settledAt = Date.now()
    },
    { rank: first.rank }
  )
  result.releasedFirstAt = Date.now()
} catch (err) {
  result.outcome = `outer:${describeError(err)}`
}

process.stdout.write(JSON.stringify(result) + '\n')
process.exit(0)
