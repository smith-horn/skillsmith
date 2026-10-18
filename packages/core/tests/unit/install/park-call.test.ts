/**
 * SMI-6531 (A1 step 3a): lock 4 (UD31) around every parked-index write, and
 * the entry points that accept `indexPath`.
 *
 * T-PI1's race is cross-process. In one process a compaction runs from its
 * read to its rename with no await, so an async appender in the same process
 * can never land inside that window, with or without the lock. The test
 * therefore plays the other process inside the window: a hook on the
 * compaction's rename takes lock 4 with one synchronous, non-waiting
 * `acquireOwnedLock`, the same call another process's `withFileLock` makes,
 * and appends only if it gets the lock.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireOwnedLock, StuckLockError } from '../../../src/config/owned-lock.js'
import {
  appendParkedIndexLocked,
  compactParkedIndexLocked,
} from '../../../src/install/park-call.js'
import {
  appendParkedIndex,
  compactParkedIndex,
  readParkedIndex,
} from '../../../src/install/parked-index.js'
import type { ParkedIndexEntry } from '../../../src/install/parked-index.js'
import { prepareParkTree } from '../../../src/install/park-tree.js'
import {
  CLIENT,
  KIND,
  PARKED,
  cleanup,
  exists,
  guardOf,
  park,
  parkIndexed,
  parkedEntries,
  simpleFixture,
  withAllFsTrapped,
  withFsStub,
  writeAfterRename,
} from './park-tree.helpers.js'

type AnyFn = (...args: unknown[]) => unknown
const fsTable = fs as unknown as Record<string, unknown>

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-call-')
  roots.push(f.root)
  return f
}
const entry = (p: string): ParkedIndexEntry => ({
  opId: 'op',
  path: p,
  client: 'c',
  rootKey: null,
  kind: 'k',
  bytes: 1,
  createdAt: '2026-10-18T00:00:00.000Z',
})
const paths = (indexPath: string): string[] => {
  const r = readParkedIndex(indexPath)
  if (!r.ok) throw new Error(`index read failed: ${r.errno}`)
  return r.entries.map((e) => e.path)
}

/** Replaces `fs[name]` until `body`'s promise settles, so the stub spans awaits. */
async function withAsyncFsStub<T>(
  name: string,
  impl: (orig: AnyFn) => AnyFn,
  body: () => Promise<T>
): Promise<T> {
  const orig = fsTable[name] as AnyFn
  fsTable[name] = impl(orig.bind(fs) as AnyFn)
  try {
    return await body()
  } finally {
    fsTable[name] = orig
  }
}

describe('indexPath is accepted only by parkTreeIndexed', () => {
  it('parkTree refuses indexPath with a TypeError before any filesystem work', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const { value, touched, deletes } = withAllFsTrapped(() => {
      try {
        park(f.parent, 'tree', { indexPath })
        return 'returned'
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`
      }
    })
    expect(value).toBe(
      'TypeError: parkTree: indexPath is not accepted here; the index append takes lock 4, ' +
        'which waits asynchronously, so call parkTreeIndexed'
    )
    expect(touched).toEqual([])
    expect(deletes).toEqual([])
    expect(exists(f.origin)).toBe(true)
  })

  it('control: parkTree without indexPath parks', () => {
    const f = fixture()
    expect(park(f.parent, 'tree').status).toBe('parked')
  })

  it('a prepared park runs at most once', () => {
    const f = fixture()
    const prepared = prepareParkTree(f.parent, 'tree', { client: CLIENT, kind: KIND })
    expect(prepared.run().result.status).toBe('parked')
    expect(() => prepared.run()).toThrow('parkTree: a prepared park runs at most once')
  })

  for (const [entryPoint, suffix] of [
    ['parkTree', '.lock'],
    ['parkTreeIndexed', '.lock'],
    ['parkTreeIndexed', '.lock.reclaim'],
  ] as const) {
    it(`${entryPoint} refuses an indexPath naming the ${suffix} file, before any filesystem work`, async () => {
      const f = fixture()
      const lockName = path.join(f.root, `parked-index.jsonl${suffix}`)
      const { value, touched } = withAllFsTrapped(() => {
        try {
          // Validation runs before parkTreeIndexed's first await, so a refusal
          // surfaces as a rejected promise created inside the trap.
          return entryPoint === 'parkTree'
            ? Promise.resolve(park(f.parent, 'tree', { indexPath: lockName }))
            : parkIndexed(f.parent, 'tree', { indexPath: lockName })
        } catch (e) {
          return Promise.reject(e)
        }
      })
      expect(touched).toEqual([])
      await expect(value).rejects.toThrow(
        `parkTree: indexPath names a lock file (${JSON.stringify(lockName)})`
      )
      expect(exists(f.origin)).toBe(true)
    })
  }
})

describe('the index append takes lock 4', () => {
  /** Runs `body` and reports whether `<indexPath>.lock` existed at each open of the index. */
  /** True at an open when `<indexPath>.lock` holds a claim naming this process. */
  async function lockSeenAtOpen(indexPath: string, body: () => Promise<unknown>) {
    const seen: boolean[] = []
    const heldByUs = (): boolean => {
      try {
        const claim = JSON.parse(fs.readFileSync(`${indexPath}.lock`, 'utf8')) as { pid?: unknown }
        return claim.pid === process.pid
      } catch {
        return false
      }
    }
    await withAsyncFsStub(
      'openSync',
      (orig) =>
        (...args: unknown[]) => {
          if (args[0] === indexPath) seen.push(heldByUs())
          return orig(...args)
        },
      body
    )
    return seen
  }

  it('parkTreeIndexed: the lock file exists when the index is opened, and is gone after', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    let status = ''
    const seen = await lockSeenAtOpen(indexPath, async () => {
      status = (await parkIndexed(f.parent, 'tree', { indexPath })).status
    })
    expect(status).toBe('parked')
    expect(seen).toEqual([true])
    expect(exists(`${indexPath}.lock`)).toBe(false)
    expect(paths(indexPath)).toHaveLength(1)
  })

  it('control: an unlocked append opens the index with no lock file, so the probe can say false', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const seen = await lockSeenAtOpen(indexPath, async () => {
      appendParkedIndex(indexPath, entry('/abs/x'))
    })
    expect(seen).toEqual([false])
  })

  it('a lock that cannot be taken leaves the status parked, writes no line, and reports indexError', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    // An unparseable claim is refused at once, never reclaimed (owned-lock D-5),
    // so this exercises the lock failure without waiting out the 30 s timeout.
    fs.writeFileSync(`${indexPath}.lock`, 'not a claim')
    const r = await parkIndexed(f.parent, 'tree', { indexPath })
    expect(r.status).toBe('parked')
    expect(String(r.indexError)).toContain('the parked-index lock (lock 4)')
    expect(exists(indexPath)).toBe(false)
    expect(exists(f.origin)).toBe(false)
    expect(parkedEntries(path.join(f.parent, PARKED, String(r.opId)))).toHaveLength(1)
  })
})

describe('which outcomes get an index line through parkTreeIndexed', () => {
  it('held: one line, naming the held path', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const r = await withFsStub('renameSync', writeAfterRename(f.origin), () =>
      parkIndexed(f.parent, 'tree', { indexPath, guardHash: guardOf(f.origin) })
    )
    expect(r.status).toBe('held')
    expect(paths(indexPath)).toEqual([r.heldPath])
  })

  it('kept (a guard that does not match) and stopped (no such entry): no line, no index file', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const kept = await parkIndexed(f.parent, 'tree', { indexPath, guardHash: 'not-the-hash' })
    expect(kept.status).toBe('kept')
    const stopped = await parkIndexed(f.parent, 'no-such-entry', { indexPath })
    expect(stopped.status).toBe('stopped')
    expect(exists(indexPath)).toBe(false)
    expect('indexError' in kept || 'indexError' in stopped).toBe(false)
  })
})

describe('parkTreeIndexed waits for a held lock 4', () => {
  it('a live holder delays the append; it lands once the holder releases', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const release = acquireOwnedLock(indexPath, {
      timeoutMs: 0,
      reclaimProbeAfterMs: 0,
      reclaimLockTimeoutMs: 0,
    })
    const pending = parkIndexed(f.parent, 'tree', { indexPath })
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The tree is parked already; its line is not written while the lock is held.
    expect(exists(f.origin)).toBe(false)
    expect(exists(indexPath)).toBe(false)
    release()
    const r = await pending
    expect(r.status).toBe('parked')
    expect('indexError' in r).toBe(false)
    expect(paths(indexPath)).toEqual([r.path])
  })
})

describe('only park-call.ts writes the index', () => {
  const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  const srcFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) return d.name === 'node_modules' ? [] : srcFiles(p)
      return /\.(ts|mts|js|mjs)$/.test(d.name) && !/\.test\./.test(d.name) ? [p] : []
    })
  it('no source module but park-call.ts names appendParkedIndex or compactParkedIndex', () => {
    const files = ['core', 'mcp-server', 'cli']
      .map((pkg) => path.join(PACKAGES, pkg, 'src'))
      .filter((d) => fs.existsSync(d))
      .flatMap(srcFiles)
    const writers = files
      .filter((f) => /\b(appendParkedIndex|compactParkedIndex)\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PACKAGES, f))
      .sort()
    // Presence control: the scan reaches the defining module and park-call.ts.
    expect(writers).toEqual(['core/src/install/park-call.ts', 'core/src/install/parked-index.ts'])
    expect(files.length).toBeGreaterThan(100)
  })
})

describe('T-PI1: compaction loses no append (UD31)', () => {
  /** An index with one live line (an existing path) and one stale line. */
  const seed = (root: string) => {
    const indexPath = path.join(root, 'parked-index.jsonl')
    appendParkedIndex(indexPath, entry(root))
    appendParkedIndex(indexPath, entry(path.join(root, 'gone')))
    return indexPath
  }

  /**
   * Runs `compact` with a hook on its rename of the temp file onto the index:
   * another writer takes lock 4 without waiting and, only if it gets it,
   * appends `late`. Returns what that writer saw.
   */
  async function compactWithLateWriter(
    indexPath: string,
    late: ParkedIndexEntry,
    compact: () => Promise<unknown>
  ): Promise<string> {
    let outcome = 'hook did not run'
    await withAsyncFsStub(
      'renameSync',
      (orig) =>
        (...args: unknown[]) => {
          if (args[1] === indexPath && outcome === 'hook did not run') {
            try {
              const release = acquireOwnedLock(indexPath, {
                timeoutMs: 0,
                reclaimProbeAfterMs: 0,
                reclaimLockTimeoutMs: 0,
              })
              try {
                appendParkedIndex(indexPath, late)
              } finally {
                release()
              }
              outcome = 'appended'
            } catch (e) {
              outcome = e instanceof StuckLockError ? `refused:${e.reason}` : `error:${String(e)}`
            }
          }
          return orig(...args)
        },
      compact
    )
    return outcome
  }

  it('with lock 4, the late append is refused inside the window and lands once the lock is free', async () => {
    const f = fixture()
    const indexPath = seed(f.root)
    const late = entry('/abs/late')
    let compacted: unknown
    const outcome = await compactWithLateWriter(indexPath, late, async () => {
      compacted = await compactParkedIndexLocked(indexPath)
    })
    expect(outcome).toBe('refused:held')
    expect(compacted).toEqual({ ok: true, kept: 1, dropped: 1, keptMalformed: 0 })
    // The refused writer waits and retries, as withFileLock does.
    await appendParkedIndexLocked(indexPath, late)
    expect(paths(indexPath)).toEqual([f.root, '/abs/late'])
  })

  it('control: without lock 4 the late append lands inside the window and the rename drops it', async () => {
    const f = fixture()
    const indexPath = seed(f.root)
    const outcome = await compactWithLateWriter(indexPath, entry('/abs/late'), async () => {
      compactParkedIndex(indexPath)
    })
    expect(outcome).toBe('appended')
    expect(paths(indexPath)).toEqual([f.root])
  })

  it('a compaction whose lock cannot be taken leaves the index bytes unchanged and returns the error', async () => {
    const f = fixture()
    const indexPath = seed(f.root)
    const before = fs.readFileSync(indexPath)
    fs.writeFileSync(`${indexPath}.lock`, 'not a claim')
    const r = await compactParkedIndexLocked(indexPath)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.errno).toContain('the parked-index lock (lock 4)')
    expect(fs.readFileSync(indexPath).equals(before)).toBe(true)
  })
})
