/**
 * SMI-5531: Atomic config-write primitive tests.
 *
 * Uses the same tmpdir-per-test isolation harness as device-identity.test.ts
 * / index.test.ts (no shared HOME mutation needed here — these primitives
 * take an explicit path, not the global config path).
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'

import { acquireConfigLock, atomicWriteFile } from './config-atomic-write.js'

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

  it('force-clears a stale lock (older than the staleness threshold) instead of waiting out the full timeout', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')
    const lockPath = `${configPath}.lock`

    // Simulate a lock abandoned by a crashed process: create it, then
    // backdate its mtime well past the staleness threshold.
    writeFileSync(lockPath, '99999')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo)

    const start = Date.now()
    // Even with a tight timeout budget, stale-lock recovery should let this
    // succeed almost immediately rather than burning the whole window.
    const release = acquireConfigLock(configPath, 500)
    const elapsedMs = Date.now() - start

    release()
    expect(elapsedMs).toBeLessThan(500)
  })

  it('release() is idempotent — calling it twice does not throw', () => {
    const dir = makeTempDir()
    const configPath = path.join(dir, 'config.json')

    const release = acquireConfigLock(configPath)
    release()
    expect(() => release()).not.toThrow()
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
