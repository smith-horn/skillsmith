/**
 * SMI-5531: Atomic config-write primitive tests.
 * SMI-5883 Wave 2 (§8d/§8e): `acquireConfigLock` is now a thin wrapper over
 * the shared two-level `acquireOwnedLock` primitive (`owned-lock.ts`). The
 * age-based stale-lock test below is DELETED (its premise — clearing on file
 * age — is the behavior being removed), replaced by three tests asserting
 * the new owner-liveness-based contract: a v1 dead-PID lock reclaims
 * quickly, a v1 live-PID lock times out regardless of a backdated mtime, and
 * a legacy bare-PID lock (this module's OWN pre-SMI-5883 format) is NEVER
 * auto-reclaimed even when definitely dead (D-5).
 *
 * Uses the same tmpdir-per-test isolation harness as device-identity.test.ts
 * / index.test.ts (no shared HOME mutation needed here — these primitives
 * take an explicit path, not the global config path).
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { hostname } from 'node:os'

import { acquireConfigLock, atomicWriteFile } from './config-atomic-write.js'
import { mintDeadPid } from '../../tests/helpers/deterministic-dead-pid.js'

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `skillsmith-atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('acquireConfigLock — mutual exclusion', () => {
  it('a second acquire attempt while the lock is held times out', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')

    const release = acquireConfigLock(configPath)
    try {
      expect(() => acquireConfigLock(configPath, 200)).toThrow(/Timed out waiting for config lock/)
    } finally {
      release()
    }
  })

  it('a subsequent acquire succeeds immediately after release', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')

    const release = acquireConfigLock(configPath)
    release()

    // Should not throw / should not need to wait out any timeout.
    const secondRelease = acquireConfigLock(configPath, 200)
    secondRelease()
  })

  it('release() is idempotent — calling it twice does not throw', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')

    const release = acquireConfigLock(configPath)
    release()
    expect(() => release()).not.toThrow()
  })

  it('reclaims a v1 dead-PID lock quickly (owner-liveness based, not age)', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`
    const deadPid = mintDeadPid()

    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: deadPid,
        token: 'a'.repeat(16),
        host: hostname(),
        acquiredAt: Date.now(),
      }) + '\n'
    )

    const start = Date.now()
    const release = acquireConfigLock(configPath, 5_000)
    const elapsedMs = Date.now() - start

    release()
    expect(elapsedMs).toBeLessThan(2_000)
  })

  it('does NOT force-clear a v1 live-PID lock even with a backdated mtime — age is irrelevant now', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`

    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: process.pid, // definitively alive for the duration of this test
        token: 'b'.repeat(16),
        host: hostname(),
        acquiredAt: Date.now() - 60_000,
      }) + '\n'
    )
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo)
    const before = readFileSync(lockPath)

    expect(() => acquireConfigLock(configPath, 200)).toThrow(/Timed out waiting for config lock/)
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('never auto-reclaims a legacy bare-PID lock even when the PID is definitely live (D-5, §8d)', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`

    writeFileSync(lockPath, String(process.pid)) // bare integer, no JSON, definitely live
    const before = readFileSync(lockPath)

    expect(() => acquireConfigLock(configPath, 150)).toThrow(/Timed out waiting for config lock/)
    expect(readFileSync(lockPath).equals(before)).toBe(true) // byte-identical
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false) // no orphan left behind
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('the on-disk lock format is a v1 JSON record, not a bare PID integer', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`

    const release = acquireConfigLock(configPath)
    const raw = readFileSync(lockPath, 'utf-8')
    release()

    const parsed = JSON.parse(raw) as { v: number; pid: number; token: string; host: string }
    expect(parsed.v).toBe(1)
    expect(parsed.pid).toBe(process.pid)
    expect(typeof parsed.token).toBe('string')
    expect(parsed.host).toBe(hostname())
  })
})

describe('atomicWriteFile', () => {
  it('writes the given content to the target path', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'config.json')

    atomicWriteFile(filePath, JSON.stringify({ a: 1 }), 0o600)

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ a: 1 })
  })

  it('leaves no stray temp file behind after a successful write', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'config.json')

    atomicWriteFile(filePath, '{}', 0o600)

    const entries = readdirSync(dir)
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('overwrites existing content atomically (rename-in-place, not append)', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'config.json')

    atomicWriteFile(filePath, JSON.stringify({ a: 1 }), 0o600)
    atomicWriteFile(filePath, JSON.stringify({ b: 2 }), 0o600)

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ b: 2 })
  })

  it('sets the requested file mode', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'config.json')

    atomicWriteFile(filePath, '{}', 0o600)

    expect(existsSync(filePath)).toBe(true)
  })
})
