/**
 * SMI-6531: post-move verification and the `held` contract (ADR-166 D-8,
 * D-10), ported from the SMI-6676 spike's `harness/test-quarantine-postmove.mjs`.
 *
 * Each mutation lands after the park's own hash (the 3rd root lstat, its
 * pre-rename re-check) or at the rename, without changing the root's identity,
 * so only verification at the destination can see it. The spike also asserted
 * its trace matcher accepted each run; that matcher is harness code and is
 * not ported.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import { RESULT_FIELDS, isSuccess, shapeResult } from '../../../src/install/park-result.js'
import {
  CLIENT,
  PARKED,
  buildFixture,
  cleanup,
  errnoError,
  exists,
  field,
  guardOf,
  populate,
  readJson,
  readText,
  runWithHooks,
  withFsStub,
  CALLER,
  KIND,
} from './park-tree.helpers.js'
import type { Fixture, HookRun } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const HEX64 = /^[0-9a-f]{64}$/
let seq = 0

/** Runs a guarded park with `mutate` at `window`, then checks the common held contract. */
function heldCase(a: {
  window?: 'post-hash' | 'at-rename'
  mutate: (f: Fixture) => void
  reason?: 'changed-during-move' | 'mount-appeared-during-move'
}): { f: Fixture; run: HookRun; guardHash: string; opId: string } {
  const f = buildFixture()
  roots.push(f.root)
  const guardHash = guardOf(f.origin)
  const opId = `pm-op-${++seq}`
  const window = a.window ?? 'post-hash'
  const reason = a.reason ?? 'changed-during-move'
  const run = runWithHooks({
    parentAbs: f.parent,
    name: f.name,
    options: { client: CLIENT, caller: CALLER, kind: KIND, opId, guardHash },
    onRecheck: window === 'post-hash' ? () => a.mutate(f) : undefined,
    onRename: window === 'at-rename' ? () => a.mutate(f) : undefined,
  })
  const res = run.result
  const firedKey = window === 'post-hash' ? 'recheck' : 'rename'
  expect(run.fired[firedKey] && run.hookErrors.length === 0).toBe(true)
  expect(res.status).toBe('held')
  expect(res.reason).toBe(reason)
  expect(String(res.path).startsWith(path.join(f.parent, PARKED) + path.sep)).toBe(true)
  expect(res.heldPath === res.path && res.path !== null).toBe(true)
  expect(res.originPath).toBe(f.origin)
  expect(exists(f.origin)).toBe(false)
  const sidecar = readJson(res.sidecarPath)
  expect(field(sidecar, 'hold')).toBe(true)
  expect(field(sidecar, 'reason')).toBe(reason)
  expect(field(sidecar, 'originPath')).toBe(f.origin)
  expect(field(sidecar, 'heldPath')).toBe(res.path)
  expect(field(sidecar, 'guardHash')).toBe(guardHash)
  const pm = field(sidecar, 'postMoveTreeHash')
  expect(pm === null || HEX64.test(String(pm))).toBe(true)
  expect(typeof field(sidecar, 'createdAt')).toBe('string')
  expect(field(sidecar, 'client')).toBe(CLIENT)
  expect(field(sidecar, 'kind')).toBe(KIND)
  expect(isSuccess(res)).toBe(false)
  return { f, run, guardHash, opId }
}
const heldAt = (run: HookRun, ...rel: string[]) => path.join(String(run.result.path), ...rel)

describe('post-hash mutations are held, never parked (R1-R4)', () => {
  it('R1 append: held, the copy carries the append, and the detail names restore, path and origin', () => {
    const { f, run, guardHash, opId } = heldCase({
      mutate: (fx) => fs.appendFileSync(path.join(fx.target, 'orig-f1'), '-late'),
    })
    expect(readText(heldAt(run, 'target', 'orig-f1'))).toBe('original-content-f1-late')
    const res = run.result
    const d = String(res.detail)
    expect(d.includes(`skillsmith restore ${opId}`)).toBe(true)
    expect(d.includes(String(res.path))).toBe(true)
    expect(d.includes(f.origin)).toBe(true)
    expect(res.sidecarPath).toBe(`${res.path}.json`)
    expect(res.opId).toBe(opId)
    expect(res.entry).toBe('tree')
    expect(res.errno).toBe(null)
    expect(res.treeHash !== null && res.treeHash !== guardHash).toBe(true)
  })

  it('R2 chmod: held, the copy carries the mode change', () => {
    const { run } = heldCase({
      mutate: (fx) => fs.chmodSync(path.join(fx.target, 'orig-f1'), 0o600),
    })
    expect((fs.lstatSync(heldAt(run, 'target', 'orig-f1')).mode & 0o777).toString(8)).toBe('600')
  })

  it('R3 create: held, the copy carries the new file', () => {
    const { run } = heldCase({
      mutate: (fx) => fs.writeFileSync(path.join(fx.target, 'new-user-file.txt'), 'created-late'),
    })
    expect(readText(heldAt(run, 'target', 'new-user-file.txt'))).toBe('created-late')
  })

  it('R4a rename-over: held with the atomic save', () => {
    const { run } = heldCase({
      mutate: (fx) => {
        fs.writeFileSync(path.join(fx.target, '.orig-f1.tmp'), 'atomic-save')
        fs.renameSync(path.join(fx.target, '.orig-f1.tmp'), path.join(fx.target, 'orig-f1'))
      },
    })
    expect(readText(heldAt(run, 'target', 'orig-f1'))).toBe('atomic-save')
  })

  it('R4b symlink retarget: held with the new link text', () => {
    const { run } = heldCase({
      mutate: (fx) => {
        fs.unlinkSync(path.join(fx.origin, 'link'))
        fs.symlinkSync('substituted-link-target', path.join(fx.origin, 'link'))
      },
    })
    expect(fs.readlinkSync(heldAt(run, 'link'))).toBe('substituted-link-target')
  })

  it('R4c rm and rewrite: held with the rewrite', () => {
    const { run } = heldCase({
      mutate: (fx) => {
        fs.rmSync(path.join(fx.target, 'orig-f1'))
        fs.writeFileSync(path.join(fx.target, 'orig-f1'), 'rewritten')
      },
    })
    expect(readText(heldAt(run, 'target', 'orig-f1'))).toBe('rewritten')
  })

  it('R4d interior directory swap: held with both the replacement and the original', () => {
    const { run } = heldCase({
      mutate: (fx) => {
        fs.renameSync(fx.target, `${fx.target}.aside`)
        fs.mkdirSync(fx.target)
        fs.writeFileSync(path.join(fx.target, 'orig-f1'), 'replacement-dir-bytes')
      },
    })
    expect(readText(heldAt(run, 'target', 'orig-f1'))).toBe('replacement-dir-bytes')
    expect(readText(heldAt(run, 'target.aside', 'orig-f1'))).toBe('original-content-f1')
  })
})

describe('verification failures other than a changed hash', () => {
  it('R5: a file the destination walk cannot read is held with guard-unreadable and no hash', () => {
    // A stub, not chmod 000, so the case also runs as root (root reads mode 000).
    const { run } = withFsStub(
      'readFileSync',
      (orig) =>
        (...args: unknown[]) => {
          const p = String(args[0])
          if (p.includes(`${path.sep}${PARKED}${path.sep}`) && p.endsWith('orig-f1')) {
            throw errnoError('EACCES')
          }
          return orig(...args)
        },
      () => heldCase({ mutate: () => {} })
    )
    expect(String(run.result.detail).includes('guard-unreadable')).toBe(true)
    expect(String(run.result.detail).includes('EACCES')).toBe(true)
    expect(run.result.treeHash).toBe(null)
  })

  it('R6: a hash-identical whole-tree substitute at the rename is held by identity; the original is untouched', () => {
    let aside = ''
    let asideIno = 0
    let substituteHash: string | null = null
    const { run, guardHash } = heldCase({
      window: 'at-rename',
      mutate: (fx) => {
        aside = path.join(fx.root, 'user-original-aside')
        asideIno = fs.lstatSync(fx.origin).ino
        fs.renameSync(fx.origin, aside)
        populate(fx.origin)
        const h = computePathTreeHash(fx.origin)
        substituteHash = h.ok ? h.treeHash : null
      },
    })
    expect(substituteHash).toBe(guardHash)
    expect(String(run.result.detail).includes('identity')).toBe(true)
    expect(readText(path.join(aside, 'target', 'orig-f1'))).toBe('original-content-f1')
    expect(fs.lstatSync(aside).ino).toBe(asideIno)
  })
})

describe('a clean guarded park is verified at its destination (S12)', () => {
  it('records postMoveVerified and the hash of the tree now at its path', () => {
    const f = buildFixture()
    roots.push(f.root)
    const guardHash = guardOf(f.origin)
    const originalBytes = readText(path.join(f.target, 'orig-f1'))
    const run = runWithHooks({
      parentAbs: f.parent,
      name: f.name,
      options: { client: CLIENT, caller: CALLER, kind: KIND, opId: 'pm-clean', guardHash },
    })
    const res = run.result
    expect(res.status).toBe('parked')
    expect(exists(f.origin)).toBe(false)
    expect(readText(path.join(String(res.path), 'target', 'orig-f1'))).toBe(originalBytes)
    const sidecar = readJson(res.sidecarPath)
    expect(field(sidecar, 'postMoveVerified')).toBe(true)
    expect(field(sidecar, 'postMoveTreeHash')).toBe(guardOf(String(res.path)))
    expect(field(sidecar, 'postMoveTreeHash')).toBe(guardHash)
    expect(field(sidecar, 'hold')).toBe(undefined)
    expect(res.heldPath).toBe(null)
  })
})

describe('a held park whose byte count fails still writes its hold sidecar', () => {
  it('held sidecar: hold true, bytes null, bytesError set, no sidecarError', () => {
    const f = buildFixture()
    roots.push(f.root)
    let destPath = ''
    let destListings = 0
    // The walk lists destPath once (verification); the second listing is the
    // byte count, which fails (a stub, since the container runs as root).
    const run = withFsStub(
      'readdirSync',
      (orig) =>
        (...args: unknown[]) => {
          if (destPath !== '' && args[0] === destPath && ++destListings === 2) {
            throw errnoError('EACCES')
          }
          return orig(...args)
        },
      () =>
        runWithHooks({
          parentAbs: f.parent,
          name: f.name,
          options: {
            client: CLIENT,
            caller: CALLER,
            kind: KIND,
            opId: 'pm-held-bytes',
            guardHash: guardOf(f.origin),
          },
          onRecheck: () => fs.appendFileSync(path.join(f.target, 'orig-f1'), '-late'),
          onAfterRename: (x) => {
            destPath = x.destPath
          },
        })
    )
    expect(run.fired.recheck && run.fired.afterRename && run.hookErrors.length === 0).toBe(true)
    expect(destListings).toBe(2)
    expect(run.result.status).toBe('held')
    expect('sidecarError' in run.result).toBe(false)
    const sidecar = readJson(run.result.sidecarPath)
    expect(field(sidecar, 'hold')).toBe(true)
    expect(field(sidecar, 'bytes')).toBe(null)
    expect(field(sidecar, 'bytesError')).toBe('EACCES')
  })
})

describe('D-8 plumbing', () => {
  it('shapeResult accepts held; RESULT_FIELDS declares originPath and heldPath; held is not success', () => {
    expect(shapeResult({ status: 'held' }).status).toBe('held')
    expect(RESULT_FIELDS.includes('originPath')).toBe(true)
    expect(RESULT_FIELDS.includes('heldPath')).toBe(true)
    expect(isSuccess({ status: 'held' })).toBe(false)
    expect(isSuccess({ status: 'parked' })).toBe(true)
  })
})
