/**
 * SMI-7148 (T2b): `doctor locks --release` sets a newer lock aside while the
 * holder of that lock releases it, across real processes.
 *
 * Before the fix the holder's release found the path empty, reported itself
 * released, and doctor then linked the lock back: a lock with a live pid and a
 * token nobody holds. Now the holder's release waits for `<lock>.reclaim`,
 * which doctor holds for the whole set-aside, then finds its lock back in place
 * and removes it. The single-process form, which cannot show that success path,
 * is in tests/unit/config/owned-lock.release-under-reclaim.test.ts (T2a).
 *
 * Child B (`owned-lock-race-child.mjs`) acquires only after doctor has removed
 * the stale lock and holds `.reclaim`, then releases once doctor has moved B's
 * lock aside. Every wait is bounded and throws a labelled error.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { releaseLock } from '../../src/config/lock-doctor.js'
import { sleepSync } from '../../src/config/owned-lock.claim.js'
import { mintDeadPid } from '../helpers/deterministic-dead-pid.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'owned-lock-race-child.mjs')

function spawnChild(argsList: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, ...argsList], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

/** Spin (synchronously, the caller is inside doctor's critical section) until `marker` exists. */
function spinUntil(marker: string, label: string, capMs = 15_000): void {
  const deadline = Date.now() + capMs
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error(`[owned-lock-release-doctor] timed out: ${label}`)
    sleepSync(5)
  }
}

describe('T2b: B releases while doctor has its lock aside (cross-process)', () => {
  it('B’s release waits for doctor, then removes its own lock: nothing is orphaned', async () => {
    const dir = path.join(
      os.tmpdir(),
      `owned-lock-release-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const barrierDir = path.join(dir, 'barrier')
    mkdirSync(barrierDir, { recursive: true })
    const target = path.join(dir, 'store.json')
    const lockPath = `${target}.lock`
    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: mintDeadPid(),
        token: 'stale-token-0000',
        host: hostname(),
        acquiredAt: Date.now() - 60_000,
      }) + '\n'
    )
    const marker = (name: string): string => path.join(barrierDir, name)

    const pendingB = spawnChild([
      'B',
      target,
      barrierDir,
      '--wait-before-acquire=go',
      '--signal-held=held',
      '--wait-release=rel',
      '--touch-before-release=releasing',
    ])

    let sawReleasing = false
    const result = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        rmSync(lockPath) // the stale holder is gone ...
        writeFileSync(marker('go'), '')
        spinUntil(marker('held'), "B's lock") // ... and B took the path while doctor holds .reclaim
      },
      afterMoveAside: () => {
        writeFileSync(marker('rel'), '') // B's lock is aside: let B release now
        sleepSync(100) // B's release runs and has to wait inside this window
        sawReleasing = existsSync(marker('releasing'))
      },
    })
    const b = await pendingB

    try {
      // The property: B removed its own lock, so nothing is left at the path.
      expect(existsSync(lockPath), 'a lock with no holder was left behind').toBe(false)
      // The mechanism.
      expect(b.code, `child B stderr:\n${b.stderr}`).toBe(0)
      expect(existsSync(marker('released-B-true'))).toBe(true)
      expect(result.outcome).toBe('refused')
      expect(result.outcome === 'refused' && result.refusal).toBe('changed')
      // Presence control: B's release really started inside doctor's set-aside.
      expect(sawReleasing).toBe(true)
      expect(existsSync(`${lockPath}.reclaim`)).toBe(false)
      expect(readdirSync(dir).filter((n) => n.includes('.doctor-') || n.endsWith('.tmp'))).toEqual(
        []
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
