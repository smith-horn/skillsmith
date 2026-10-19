/**
 * SMI-6531 (A1 step 1): each ranked lock call site carries its rank.
 *
 * The tracker refuses a request ranked BELOW a lock already held (an
 * `inversion`) and allows one at or above it. Nothing else pins which rank a
 * call site passes, so these tests drive the real functions inside an outer
 * lock of a chosen rank and observe whether the tracker refuses them.
 *
 * Order: 1 < 2a < 2b < 3 < 4.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import type { LockRank } from '../../../src/config/lock-tracker.js'
import { withDestinationLock } from '../../../src/install/fan-out.locks.js'
import { updateManifest, getLinkManifestPath } from '../../../src/install/fan-out.manifest.js'
import {
  appendParkedIndexLocked,
  compactParkedIndexLocked,
} from '../../../src/install/park-call.js'
import { runManifestUpdate } from '../../../src/services/skill-manifest.lock.js'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let dir: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-ranks-'))
  // fan-out's link manifest lives under homedir(), read at call time.
  process.env['HOME'] = dir
  process.env['USERPROFILE'] = dir
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run `inner` while holding an outer lock of the given rank on its own file. */
function insideRank<T>(rank: LockRank, inner: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(dir, `outer-${rank}.json`), `outer lock ${rank}`, inner, { rank })
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  return undefined
}

function expectInversion(error: unknown): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe('inversion')
}

describe('runManifestUpdate holds lock 3', () => {
  it('is refused inside lock 4, and neither loads, updates nor saves', async () => {
    const manifestPath = path.join(dir, 'skills-manifest.json')
    let loaded = false
    let updated = false
    const error = await insideRank('4', () =>
      rejection(
        runManifestUpdate({
          manifestPath,
          load: async () => {
            loaded = true
            return {}
          },
          update: (m) => {
            updated = true
            return m
          },
        })
      )
    )
    expectInversion(error)
    expect(loaded).toBe(false)
    expect(updated).toBe(false)
    expect(fs.existsSync(manifestPath)).toBe(false)
  })

  it('is allowed inside lock 2b, and saves', async () => {
    const manifestPath = path.join(dir, 'skills-manifest.json')
    await insideRank('2b', () =>
      runManifestUpdate({
        manifestPath,
        load: async () => ({ saved: false }),
        update: () => ({ saved: true }),
      })
    )
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({ saved: true })
  })
})

describe('the fan-out destination lock holds lock 2a', () => {
  it('is refused inside lock 2b, and the work does not run', async () => {
    const dest = path.join(dir, 'dest-a', 'skill')
    let ran = false
    const error = await insideRank('2b', () =>
      rejection(
        withDestinationLock(dest, async () => {
          ran = true
        })
      )
    )
    expectInversion(error)
    expect(ran).toBe(false)
  })

  it('is allowed inside lock 1, and the work runs', async () => {
    const dest = path.join(dir, 'dest-b', 'skill')
    let ran = false
    await insideRank('1', () =>
      withDestinationLock(dest, async () => {
        ran = true
      })
    )
    expect(ran).toBe(true)
  })
})

describe('the fan-out link manifest updateManifest holds lock 2b', () => {
  it('is refused inside lock 3, and the manifest is not written', async () => {
    let changed = false
    const error = await insideRank('3', () =>
      rejection(
        updateManifest(() => {
          changed = true
        })
      )
    )
    expectInversion(error)
    expect(changed).toBe(false)
    expect(fs.existsSync(getLinkManifestPath())).toBe(false)
  })

  it('is allowed inside lock 2a, and the manifest is written', async () => {
    let changed = false
    await insideRank('2a', () =>
      updateManifest(() => {
        changed = true
      })
    )
    expect(changed).toBe(true)
    expect(fs.existsSync(getLinkManifestPath())).toBe(true)
  })
})

describe('appendParkedIndexLocked holds lock 4', () => {
  it('is allowed inside lock 3, and appends its line', async () => {
    const indexPath = path.join(dir, 'parked-index.jsonl')
    const parked = path.join(dir, 'parked-tree')
    await insideRank('3', () =>
      appendParkedIndexLocked(indexPath, {
        opId: 'op-1',
        path: parked,
        client: null,
        rootKey: null,
        kind: null,
        bytes: null,
        createdAt: null,
      })
    )
    const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).path).toBe(parked)
  })

  it('compactParkedIndexLocked is allowed inside lock 3 (it reports a refusal as ok: false)', async () => {
    const indexPath = path.join(dir, 'parked-index.jsonl')
    fs.writeFileSync(indexPath, '')
    const result = await insideRank('3', () => compactParkedIndexLocked(indexPath))
    expect(result.ok).toBe(true)
  })
})
