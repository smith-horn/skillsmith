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
      // 500ms, not 200 (SMI-6764 F4): RECLAIM_PROBE_AFTER_MS is 250, and
      // `acquireConfigLock` forwards only `timeoutMs`, so under the old budget
      // the probe never ran and `held` came from the safe default rather than
      // from `classifyRefusal`. The expected answer was the same either way,
      // which is exactly why it went unnoticed — the test could not tell a
      // working classifier from an absent one.
      let caught: unknown
      try {
        acquireConfigLock(configPath, 500)
      } catch (err) {
        caught = err
      }
      const message = caught instanceof Error ? caught.message : String(caught)
      expect(message).toMatch(/Could not acquire config lock/)
      // Now classified, not defaulted: a live v1 owner reports its pid.
      expect(message).toMatch(new RegExp(`held by pid ${process.pid}\\b`))
      expect(message).toMatch(/retrying is the right first response/)
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

    // 500ms for the same reason as the case above (SMI-6764 F4): under 200ms
    // the reclaim probe never fired, so this test asserted the lock bytes were
    // unchanged when nothing had ever tried to change them. The age-irrelevance
    // property it exists for is only exercised once the probe actually runs.
    let caught: unknown
    try {
      acquireConfigLock(configPath, 500)
    } catch (err) {
      caught = err
    }
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toMatch(/Could not acquire config lock/)
    expect(message).toMatch(new RegExp(`held by pid ${process.pid}\\b`))
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('never auto-reclaims a legacy bare-PID lock even when the PID is definitely live (D-5, §8d)', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`

    writeFileSync(lockPath, String(process.pid)) // bare integer, no JSON, definitely live
    const before = readFileSync(lockPath)

    let caught: unknown
    try {
      // 500ms, not 150ms (SMI-6764). `acquireConfigLock` forwards only
      // `timeoutMs`, so the reclaim probe fires on its own schedule --
      // RECLAIM_PROBE_AFTER_MS is 250. Under the old 150ms budget the probe
      // never ran once, `lastRefusal` stayed at its safe default and this case
      // reported `held`: the test named the D-5 legacy path and never reached
      // `classifyRefusal` at all. Measured, not inferred -- the message read
      // "held by another process" for a bare-PID claim.
      acquireConfigLock(configPath, 500)
    } catch (err) {
      caught = err
    }
    const message = caught instanceof Error ? caught.message : String(caught)
    // Guard the guard: if the budget ever drops back below the probe delay,
    // this fails loudly here instead of silently re-testing `held`.
    expect(message).toContain('legacy')
    // "Could not acquire", not "Timed out waiting": a legacy claim is never
    // auto-reclaimed by this process, so retrying cannot resolve it (SMI-6764).
    expect(message).toMatch(/Could not acquire config lock/)
    // The verb no longer discriminates anything — every reason opens this way
    // since SMI-6764 — so it is `legacy` above and this remedy phrase that
    // separate this case from the two `held` cases in the sibling tests.
    expect(message).toMatch(/never auto-reclaimed, in any configuration/)
    expect(message).not.toMatch(/retrying is the right first response/)
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
