import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireIndexerLock } from '../src/indexer-lock.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doc-retrieval-lock-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('acquireIndexerLock', () => {
  it('creates the lockfile on happy path and removes it on release', async () => {
    const release = await acquireIndexerLock(dir, { registerHandlers: false })

    const lockPath = join(dir, '.indexer.lock')
    expect(existsSync(lockPath)).toBe(true)
    const held = await readFile(lockPath, 'utf8')
    expect(held.startsWith(`${process.pid}\n`)).toBe(true)

    release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('breaks a stale lock whose holder is dead (ESRCH)', async () => {
    await writeFile(join(dir, '.indexer.lock'), `99999\n2020-01-01T00:00:00.000Z\n`)

    const release = await acquireIndexerLock(dir, {
      registerHandlers: false,
      probeAlive: (pid) => pid !== 99999,
    })

    const held = await readFile(join(dir, '.indexer.lock'), 'utf8')
    expect(held.startsWith(`${process.pid}\n`)).toBe(true)
    release()
  })

  it('times out when an alive process holds the lock', async () => {
    await writeFile(join(dir, '.indexer.lock'), `${process.pid}\n${new Date().toISOString()}\n`)

    await expect(
      acquireIndexerLock(dir, {
        registerHandlers: false,
        probeAlive: () => true,
        timeoutMs: 200,
        pollMs: 50,
      })
    ).rejects.toThrow(/indexer lock timeout/)
  })

  it('treats a garbled lock body as stale and reclaims it', async () => {
    await writeFile(join(dir, '.indexer.lock'), 'not-a-pid\nbad\n')

    const release = await acquireIndexerLock(dir, {
      registerHandlers: false,
      probeAlive: () => {
        throw new Error('probeAlive should not be called for garbled lock')
      },
    })

    expect(existsSync(join(dir, '.indexer.lock'))).toBe(true)
    release()
  })

  it('release is idempotent', async () => {
    const release = await acquireIndexerLock(dir, { registerHandlers: false })
    release()
    release()
    expect(existsSync(join(dir, '.indexer.lock'))).toBe(false)
  })

  it('creates the storage directory if missing', async () => {
    const nested = join(dir, 'does-not-exist-yet')
    const release = await acquireIndexerLock(nested, { registerHandlers: false })
    expect(existsSync(join(nested, '.indexer.lock'))).toBe(true)
    release()
  })
})
