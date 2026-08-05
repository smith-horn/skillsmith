/**
 * SMI-5883 §9 H-9 -- lost update under a forced stale reclaim, against the
 * REAL accept path (`acceptFinding`), not a generic lock stress test (that
 * lives at `packages/core/tests/integration/owned-lock-*.test.ts`). Two real
 * child processes are forced through the reclaim path (a genuinely
 * reclaimable stale lock) and then race for the acceptance store's own
 * lock, each accepting a DISTINCT finding. `SKILLSMITH_ACCEPT_LOCK_TEST_DELAY_MS`
 * deterministically guarantees overlap inside the critical section rather
 * than relying on scheduling luck.
 */

import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeAcceptKey,
  computeStoreDigest,
  findingFingerprint,
} from '../../src/audit/security-acceptance.js'
import type {
  AcceptanceRecord,
  AcceptanceStore,
} from '../../src/audit/security-acceptance.types.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'acceptance-lost-update-child.mjs')

function mintDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ['-e', ''])
    const pid = result.pid
    if (typeof pid !== 'number') continue
    try {
      process.kill(pid, 0)
      continue
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error(
    '[security-acceptance-lost-update.test] could not mint a deterministically-dead PID'
  )
}

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

function spawnChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SKILLSMITH_ACCEPT_LOCK_TEST_DELAY_MS: '300' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function waitForAsync(
  predicate: () => boolean,
  label: string,
  // 45s, not the more typical ~10s: this spawns REAL child processes (node +
  // --import tsx, itself resolving the mcp-server + core dependency graph)
  // 20 times in a loop. Under full-suite CPU contention (many other vitest
  // worker files running concurrently) that startup cost can legitimately
  // balloon well past 10s -- a genuine mechanism regression (an actual
  // deadlock) still fails this test, just later, so widening the cap does
  // not weaken what this test catches.
  capMs = 45_000
): Promise<void> {
  const deadline = Date.now() + capMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`[security-acceptance-lost-update.test] timed out waiting for ${label}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

function seedPreexistingStore(acceptancePath: string): AcceptanceRecord {
  const fp = findingFingerprint({ type: 'jailbreak', severity: 'high', message: 'pre-existing' })
  const contentDigest = 'e'.repeat(64)
  const acceptKey = computeAcceptKey({
    contentDigest,
    findingFingerprint: fp,
    rulesetVersion: 'irrelevant-legacy',
  })
  const record: AcceptanceRecord = {
    acceptKey,
    sourcePath: '/skills/pre-existing/SKILL.md',
    identifier: 'pre-existing',
    contentDigest,
    findingFingerprint: fp,
    rulesetVersion: 'irrelevant-legacy', // deliberately not the current ruleset -- exercises GC-survival isn't the point here, revision tracking is
    display: {
      type: 'jailbreak',
      severity: 'high',
      message: 'pre-existing',
      location: null,
      lineNumber: null,
    },
    acceptedAt: '2026-01-01T00:00:00.000Z',
    reason: 'pre-existing acceptance',
  }
  const shell = { version: 1 as const, revision: 5, records: [record] }
  const storeDigest = computeStoreDigest(shell)
  writeFileSync(
    acceptancePath,
    JSON.stringify({ ...shell, storeDigest } satisfies AcceptanceStore, null, 2)
  )
  return record
}

describe('security-acceptance lost update under a forced stale reclaim (§9 H-9)', () => {
  it('no child that reports ok:true ever loses its acceptance; revision and lock state are consistent', async () => {
    const ITERATIONS = 20
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const dir = path.join(
        os.tmpdir(),
        `sec-acceptance-lost-update-${iter}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      const barrierDir = path.join(dir, 'barrier')
      mkdirSync(barrierDir, { recursive: true })
      const acceptancePath = path.join(dir, 'security-acceptance.json')
      const lockPath = `${acceptancePath}.lock`

      const deadPid = mintDeadPid()
      writeFileSync(
        lockPath,
        JSON.stringify({
          v: 1,
          pid: deadPid,
          token: '0'.repeat(32),
          host: hostname(),
          acquiredAt: Date.now() - 60_000,
        }) + '\n'
      )
      seedPreexistingStore(acceptancePath)

      const pendingC1 = spawnChild(['C1', acceptancePath, barrierDir])
      const pendingC2 = spawnChild(['C2', acceptancePath, barrierDir])

      await waitForAsync(() => existsSync(path.join(barrierDir, 'arrived-C1')), 'C1 to arrive')
      await waitForAsync(() => existsSync(path.join(barrierDir, 'arrived-C2')), 'C2 to arrive')
      writeFileSync(path.join(barrierDir, 'go'), '')

      const [c1, c2] = await Promise.all([pendingC1, pendingC2])

      for (const c of [c1, c2]) {
        expect(c.stderr).not.toContain('lock_release_not_owner') // (d)
      }

      const outcomes = [c1, c2].map((c) => {
        const line = c.stdout.trim().split('\n').pop() ?? ''
        try {
          return JSON.parse(line) as { ok: boolean; acceptKey: string }
        } catch {
          throw new Error(
            `[iteration ${iter}] child produced unparseable stdout: ${JSON.stringify(c)}`
          )
        }
      })
      const successes = outcomes.filter((o) => o.ok)

      const finalRaw = JSON.parse(readFileSync(acceptancePath, 'utf-8')) as AcceptanceStore
      const finalKeys = new Set(finalRaw.records.map((r) => r.acceptKey))

      for (const s of successes) {
        expect(finalKeys.has(s.acceptKey), `iteration ${iter}: lost acceptKey ${s.acceptKey}`).toBe(
          true
        ) // (a) INV-7
      }
      expect(finalRaw.revision, `iteration ${iter}`).toBe(5 + successes.length) // (b)
      expect(existsSync(lockPath), `iteration ${iter}`).toBe(false) // (c)
      expect(existsSync(`${lockPath}.reclaim`), `iteration ${iter}`).toBe(false)

      rmSync(dir, { recursive: true, force: true })
    }
    // 300s: 20 iterations x 2 real child-process spawns, widened alongside
    // waitForAsync's own cap above for the same full-suite-contention reason.
  }, 300_000)
})
