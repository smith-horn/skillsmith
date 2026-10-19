/**
 * SMI-6531 (A1 step 1), plan row T-L3: no cross-process inversion.
 *
 * Child A holds lock 1 and, once child B holds lock 3, requests lock 3. Child B
 * holds lock 3 and, once A holds lock 1, requests lock 1. Taken in opposite
 * orders the two requests deadlock; the tracker must refuse B's request at once
 * (`LockOrderError`, kind `inversion`), B then releases lock 3, and A finishes.
 *
 * The control runs the identical scenario with the tracker off in both
 * children: it must deadlock until a request times out (`StuckLockError`),
 * which proves the scenario really inverts and the tracker is what resolves it.
 *
 * The children rendezvous through marker files, never sleeps alone. They live
 * in a plain `.mjs` outside every vitest glob and import the SOURCE modules.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, 'lock-tracker.cross-process.child.mjs')

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

interface Outcome {
  role: 'A' | 'B'
  outcome: string
  requestedAt: number
  settledAt: number
  releasedFirstAt: number
}

function spawnChild(role: 'A' | 'B', dir: string, tracker: 'on' | 'off', timeoutMs: number) {
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, role, dir, tracker, String(timeoutMs)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

function parse(result: ChildResult, who: string): Outcome {
  expect(result.code, `child ${who} stderr:\n${result.stderr}`).toBe(0)
  const line = result.stdout.trim().split('\n').pop() ?? ''
  return JSON.parse(line) as Outcome
}

async function runScenario(tracker: 'on' | 'off', timeoutMs: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-xproc-'))
  mkdirSync(dir, { recursive: true })
  try {
    const [a, b] = await Promise.all([
      spawnChild('A', dir, tracker, timeoutMs),
      spawnChild('B', dir, tracker, timeoutMs),
    ])
    return { a: parse(a, 'A'), b: parse(b, 'B') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('lock tracker: cross-process inversion (T-L3)', () => {
  it('refuses B at once, releases lock 3, and lets A finish within 5 s', async () => {
    const { a, b } = await runScenario('on', 4000)

    expect(b.outcome).toBe('LockOrderError:inversion')
    expect(b.settledAt - b.requestedAt, 'B is refused before any wait').toBeLessThan(1000)

    // A could only take lock 3 once B released it, so a clean acquisition is
    // the proof that B let go after the refusal.
    expect(a.outcome).toBe('acquired')
    expect(a.settledAt - a.requestedAt).toBeLessThan(5000)
  }, 30_000)

  it('control: with the tracker off in both children the same scenario deadlocks until a request times out', async () => {
    const timeoutMs = 1500
    const { a, b } = await runScenario('off', timeoutMs)

    const outcomes = [a, b]
    const stuck = outcomes.filter((o) => o.outcome.startsWith('StuckLockError:'))
    expect(
      stuck.length,
      `expected at least one StuckLockError, got A=${a.outcome} B=${b.outcome}`
    ).toBeGreaterThanOrEqual(1)
    expect(outcomes.some((o) => o.outcome.startsWith('LockOrderError'))).toBe(false)
    // The timeout is the wait itself, not an instant refusal.
    for (const o of stuck) {
      expect(o.settledAt - o.requestedAt).toBeGreaterThanOrEqual(timeoutMs - 100)
    }
  }, 30_000)
})
