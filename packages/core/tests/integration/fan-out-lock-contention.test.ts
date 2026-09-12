/**
 * SMI-6529 round 8: real processes contending for one fan-out destination
 * lock. Before the fix, a holder that released between a waiter's failed
 * create and its claim read was reported as an unparseable lock, which the
 * waiter treated as fatal: 1-4% of operations failed at once. Every round
 * must now succeed, and the shared counter proves no two holders overlapped.
 * The deterministic version of the race is owned-lock.test.ts's
 * "non-waiting callers" item 1; this test catches regressions it can't see.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'fan-out-lock-contention-child.mjs')

const WORKERS = 6
const ROUNDS = 40

interface WorkerResult {
  code: number | null
  stdout: string
  stderr: string
}

function spawnWorker(dest: string, counter: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, dest, counter, String(ROUNDS)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('fan-out destination lock under real contention (SMI-6529 round 8)', () => {
  it(`${WORKERS} workers x ${ROUNDS} rounds: no caller gives up and no update is lost`, async () => {
    const dir = path.join(
      os.tmpdir(),
      `fanout-lock-contention-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, 'dest')
    const counter = path.join(dir, 'counter')
    writeFileSync(counter, '0')
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => spawnWorker(dest, counter))
      )
      const failures: string[] = []
      for (const r of results) {
        expect(r.code, `worker stderr:\n${r.stderr}`).toBe(0)
        failures.push(...(JSON.parse(r.stdout.trim()) as { failures: string[] }).failures)
      }
      expect(failures).toEqual([])
      expect(Number(readFileSync(counter, 'utf-8'))).toBe(WORKERS * ROUNDS)
      expect(readdirSync(dir).filter((n) => n.endsWith('.lock') || n.endsWith('.reclaim'))).toEqual(
        []
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
