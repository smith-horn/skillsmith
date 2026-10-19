/**
 * @fileoverview `skillsmith telemetry status` reports a rotation only if its
 * SECOND manifest update performed one, when the manifest lock is lost once.
 * @see SMI-7143: a lost lock reruns the CLI's locked manifest-update callback once;
 *   `rotationTriggered` lives outside it, so the callback resets it.
 *
 * Real writer, real manifest file. The first locked read of the manifest (while
 * `<manifest>.lock` exists) returns the stale id, so the first run rotates it.
 * After that read the file is replaced with a freshly created id and the lock is
 * backdated by 26 s, so the pre-rename check fails on age and the update reruns.
 * The rerun finds nothing to rotate, so no rotation may be reported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { dirname } from 'node:path'

const inject = vi.hoisted(() => ({
  target: null as string | null,
  lockedReads: 0,
  /** Runs right AFTER the first locked read; the read itself returns what it saw. */
  afterFirstLockedRead: null as (() => void) | null,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const { existsSync: exists } = await import('node:fs')
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args)
    if (
      inject.target !== null &&
      String(args[0]) === inject.target &&
      exists(`${inject.target}.lock`)
    ) {
      inject.lockedReads += 1
      if (inject.lockedReads === 1 && inject.afterFirstLockedRead) inject.afterFirstLockedRead()
    }
    return result
  }) as typeof actual.readFile
  return { ...actual, readFile, default: { ...actual, readFile } }
})

import { runStatus } from './telemetry.action.js'
import { MANIFEST_PATH } from '../utils/manifest.js'

// The $HOME sandbox (vitest.setup.ts) must be in force before any hook runs. A
// failed check inside beforeAll/beforeEach still lets afterEach run, and
// afterEach deletes the manifest; a throw here fails collection instead.
if (
  !MANIFEST_PATH.includes('skillsmith-vitest-home-') ||
  !MANIFEST_PATH.startsWith(process.env['HOME'] ?? '/nonexistent')
) {
  throw new Error(`Refusing to run: ${MANIFEST_PATH} is not inside the vitest HOME sandbox`)
}

const STALE_ID = 'a'.repeat(64)
const FRESH_ID = 'b'.repeat(64)
const ROTATED = 'Annual rotation triggered.'

function manifestText(anonymousId: string, createdAt: string): string {
  return JSON.stringify({
    version: '1.0.0',
    installedSkills: {},
    telemetry: { enabled: true, anonymousId, anonymousIdCreatedAt: createdAt },
  })
}

const STALE = (): string =>
  manifestText(STALE_ID, new Date(Date.now() - 400 * 86_400_000).toISOString())
const FRESH = (): string => manifestText(FRESH_ID, new Date().toISOString())

function seed(text: string): void {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, text)
}

async function statusOutput(): Promise<string> {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
    lines.push(a.join(' '))
  })
  try {
    await runStatus()
  } finally {
    log.mockRestore()
  }
  return lines.join('\n')
}

describe('telemetry status after one lost manifest lock (SMI-7143)', () => {
  beforeEach(() => {
    inject.target = MANIFEST_PATH
    inject.lockedReads = 0
    inject.afterFirstLockedRead = null
  })

  afterEach(() => {
    inject.target = null
    inject.afterFirstLockedRead = null
    for (const p of [MANIFEST_PATH, `${MANIFEST_PATH}.lock`]) {
      if (existsSync(p)) rmSync(p, { force: true })
    }
  })

  it('POSITIVE CONTROL: a stale id is rotated and reported, with one locked read', async () => {
    seed(STALE())

    const out = await statusOutput()

    expect(inject.lockedReads).toBe(1)
    expect(out).toContain(ROTATED)
    const saved = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as {
      telemetry: { anonymousId: string; previousAnonymousId?: string }
    }
    expect(saved.telemetry.previousAnonymousId).toBe(STALE_ID)
  })

  it('does not report a rotation that only the lost run performed', async () => {
    seed(STALE())
    inject.afterFirstLockedRead = () => {
      const past = new Date(Date.now() - 26_000)
      utimesSync(`${MANIFEST_PATH}.lock`, past, past)
      writeFileSync(MANIFEST_PATH, FRESH())
    }

    const out = await statusOutput()

    expect(inject.lockedReads).toBe(2)
    expect(out).not.toContain(ROTATED)
    expect(out).toContain(`...${FRESH_ID.slice(-8)}`)
    const saved = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as {
      telemetry: { anonymousId: string; previousAnonymousId?: string }
    }
    expect(saved.telemetry.anonymousId).toBe(FRESH_ID)
    expect(saved.telemetry.previousAnonymousId).toBeUndefined()
  })
})
