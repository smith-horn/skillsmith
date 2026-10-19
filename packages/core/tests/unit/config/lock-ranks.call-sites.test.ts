/**
 * SMI-6531 (A1 step 1): each ranked lock call site carries its rank.
 *
 * The tracker refuses a request ranked BELOW a lock already held (an
 * `inversion`), one of the SAME rank (`same-rank`), and anything while lock 4
 * is held (`under-leaf`). Nothing else pins which rank a call site passes, so
 * these tests drive the real functions inside an outer lock of a chosen rank
 * and observe the exact refusal: inside the site's own rank (same-rank), inside
 * the rank just above it (inversion), and allowed inside the rank just below.
 * Together they pin each rank exactly. Lock 4 is pinned in
 * lock-ranks.parked-index.test.ts.
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

function expectKind(error: unknown, kind: LockOrderError['kind']): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe(kind)
}

/** A manifest-update request against a fresh path; reports whether it ran. */
async function manifestRequest(name: string): Promise<{ error: unknown; touched: boolean }> {
  const manifestPath = path.join(dir, name)
  let touched = false
  const error = await rejection(
    runManifestUpdate({
      manifestPath,
      load: async () => {
        touched = true
        return {}
      },
      update: (m) => {
        touched = true
        return m
      },
    })
  )
  return { error, touched: touched || fs.existsSync(manifestPath) }
}

describe('runManifestUpdate holds lock 3', () => {
  it('is refused inside lock 4 (under-leaf), and neither loads, updates nor saves', async () => {
    const { error, touched } = await insideRank('4', () => manifestRequest('m-in-4.json'))
    expectKind(error, 'under-leaf')
    expect(touched).toBe(false)
  })

  it('is refused inside lock 3 (same-rank), and neither loads, updates nor saves', async () => {
    const { error, touched } = await insideRank('3', () => manifestRequest('m-in-3.json'))
    expectKind(error, 'same-rank')
    expect(touched).toBe(false)
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
  it('is refused inside lock 2b (inversion), and the work does not run', async () => {
    const dest = path.join(dir, 'dest-a', 'skill')
    let ran = false
    const error = await insideRank('2b', () =>
      rejection(
        withDestinationLock(dest, async () => {
          ran = true
        })
      )
    )
    expectKind(error, 'inversion')
    expect(ran).toBe(false)
  })

  it('is refused inside lock 2a (same-rank), and the work does not run', async () => {
    const dest = path.join(dir, 'dest-c', 'skill')
    let ran = false
    const error = await insideRank('2a', () =>
      rejection(
        withDestinationLock(dest, async () => {
          ran = true
        })
      )
    )
    expectKind(error, 'same-rank')
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
  it('is refused inside lock 3 (inversion), and the manifest is not written', async () => {
    let changed = false
    const error = await insideRank('3', () =>
      rejection(
        updateManifest(() => {
          changed = true
        })
      )
    )
    expectKind(error, 'inversion')
    expect(changed).toBe(false)
    expect(fs.existsSync(getLinkManifestPath())).toBe(false)
  })

  it('is refused inside lock 2b (same-rank), and the manifest is not written', async () => {
    let changed = false
    const error = await insideRank('2b', () =>
      rejection(
        updateManifest(() => {
          changed = true
        })
      )
    )
    expectKind(error, 'same-rank')
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
