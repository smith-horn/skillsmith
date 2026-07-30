/**
 * SMI-5883 §8f -- end-to-end lost-update stress test, deliberately kept
 * SEPARATE from the §8b reclaim-race proof: 8 real child processes each
 * acquire -> read -> add a distinct key -> atomicWriteFile -> release, 5
 * rounds each, with NO seam, NO barrier, and NO injection. This exercises
 * the primitive under real contention among genuinely-alive processes (no
 * staleness/reclaim path is ever exercised here), catching whole-mechanism
 * regressions that a seam-driven test could mask. Neither this test nor
 * §8b substitutes for the other.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'owned-lock-stress-child.mjs')

const WORKERS = 8
const ROUNDS = 5

function spawnWorker(id: number, target: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, String(id), target, String(ROUNDS)],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

describe('owned-lock end-to-end lost update (§8f)', () => {
  it(`${WORKERS} workers x ${ROUNDS} rounds under real contention lose no updates`, async () => {
    const dir = path.join(
      os.tmpdir(),
      `owned-lock-lost-update-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'store.json')

    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) => spawnWorker(i, target))
    )
    for (const r of results) {
      expect(r.code, `worker stderr:\n${r.stderr}`).toBe(0)
    }

    expect(existsSync(target)).toBe(true)
    const store = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, boolean>
    const keys = Object.keys(store)
    expect(keys).toHaveLength(WORKERS * ROUNDS)
    for (let id = 0; id < WORKERS; id++) {
      for (let round = 0; round < ROUNDS; round++) {
        expect(store[`${id}-${round}`]).toBe(true)
      }
    }
    expect(existsSync(`${target}.lock`)).toBe(false)
    expect(existsSync(`${target}.lock.reclaim`)).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})
