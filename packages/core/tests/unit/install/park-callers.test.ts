/**
 * SMI-6531 (A1 step 3a): the per-caller `held` detail (A1 plan §3.8, "held
 * message" column). The expected table is written out here from the plan, not
 * imported, so a change to the source's table must also change this file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PARK_CALLERS } from '../../../src/install/park-callers.js'
import { parkTree } from '../../../src/install/park-tree.js'
import {
  CLIENT,
  PARKED,
  cleanup,
  exists,
  guardOf,
  runWithHooks,
  simpleFixture,
  withAllFsTrapped,
  withFsStub,
  writeAfterRename,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-callers-')
  roots.push(f.root)
  return f
}

/** §3.8: caller, its kind, and whether its held detail names `skillsmith restore`. */
const PLAN: [string, string, boolean][] = [
  ['abort-cleanup', 'abort-new', false],
  ['move-source', 'move-source', false],
  ['uninstall', 'uninstall', true],
  ['fan-out-cleanup', 'fan-out-cleanup', true],
  ['fan-out-undo', 'fan-out-undo', true],
  ['fan-out-staging', 'fan-out-overwrite', false],
  ['fan-out-symlink', 'fan-out-overwrite', true],
  ['fan-out-backup', 'fan-out-overwrite', false],
  ['install-rollback', 'install-rollback', true],
  ['activation-undo', 'activation-undo', true],
  ['init-rollback', 'init-rollback', true],
  ['agent-uninstall', 'agent-uninstall', true],
  ['companion-rollback', 'install-rollback', true],
  ['doctor-park', 'unreadable-record', false],
]
const BACKUP = '/abs/backups/old'
/** The closing sentence of each internal-origin caller's held detail. */
const INTERNAL: Record<string, string> = {
  'abort-cleanup':
    'The staged copy may have changed while it was set aside. Its origin is a staging ' +
    'directory, so there is nothing to restore.',
  'move-source': `may not have it; the extra copy is at`,
  'fan-out-staging': 'Its origin is a temporary staging folder, so there is nothing to restore.',
  'fan-out-backup': 'Its origin is a backup folder, so there is nothing to restore.',
  'doctor-park':
    'Its origin is an op directory in the staging area, so there is nothing to restore.',
}
const optsFor = (caller: string, kind: string) =>
  ({
    client: CLIENT,
    caller,
    kind,
    ...(caller === 'move-source' ? { backupPath: BACKUP } : {}),
  }) as never

/** A guarded park of `tree` that ends held, with `caller` and its kind. */
const heldPark = (caller: string, kind: string) => {
  const f = fixture()
  const r = withFsStub('renameSync', writeAfterRename(f.origin), () =>
    parkTree(f.parent, 'tree', {
      ...(optsFor(caller, kind) as object),
      guardHash: guardOf(f.origin),
    } as never)
  )
  return { f, r }
}

describe('the caller table matches the plan', () => {
  it('one caller per §3.8 row (10 and 11 share one) plus doctor --park, in row order', () => {
    expect(PARK_CALLERS).toEqual(PLAN.map(([c]) => c))
  })
})

describe('each caller parks with its own kind and gets its own held detail', () => {
  for (const [caller, kind, restore] of PLAN) {
    it(`${caller}: kind ${kind}, ${restore ? 'names' : 'does not name'} skillsmith restore`, () => {
      const { f, r } = heldPark(caller, kind)
      expect(r.status).toBe('held')
      const detail = String(r.detail)
      expect(detail.includes('skillsmith restore')).toBe(restore)
      if (restore) {
        expect(detail).toContain(`If something now exists at '${f.origin}', move it aside first`)
        expect(detail).toContain(`\`skillsmith restore ${String(r.opId)}\``)
      } else {
        const closing = INTERNAL[caller] ?? 'MISSING'
        // move-source's sentence names the parked path, so it is not the very end
        // of the detail; its exact wording has its own test below.
        if (caller === 'move-source') expect(detail).toContain(closing)
        else expect(detail.endsWith(closing)).toBe(true)
      }
    })
  }

  it('move-source names the backup and the extra copy, as the plan words it', () => {
    const { r } = heldPark('move-source', 'move-source')
    expect(String(r.detail)).toContain(
      `A write may have landed in the old folder while it was being backed up. The backup at ` +
        `'${BACKUP}' may not have it; the extra copy is at '${String(r.heldPath)}'.`
    )
  })

  // SMI-7134: when the post-move check cannot confirm the location, an
  // internal-origin sentence must not assert one either.
  for (const caller of [
    'abort-cleanup',
    'move-source',
    'fan-out-staging',
    'fan-out-backup',
    'doctor-park',
  ]) {
    it(`${caller}, location not confirmed: the closing asserts no location`, () => {
      const kind = PLAN.find(([c]) => c === caller)?.[1] ?? 'MISSING'
      const f = fixture()
      const opDir = path.join(f.parent, PARKED, 'op-u')
      const outside = path.join(f.root, 'elsewhere')
      const run = runWithHooks({
        parentAbs: f.parent,
        name: 'tree',
        options: {
          ...(optsFor(caller, kind) as object),
          opId: 'op-u',
          guardHash: guardOf(f.origin),
        } as never,
        onAfterRename: () => {
          fs.renameSync(opDir, outside)
          fs.symlinkSync(outside, opDir)
        },
      })
      const detail = String(run.result.detail)
      expect(run.result.status).toBe('held')
      expect(detail).toMatch(/could not be confirmed/)
      expect(detail.includes('skillsmith restore')).toBe(false)
      if (caller === 'move-source') {
        expect(detail).toContain(`the extra copy was reported at '${String(run.result.path)}'.`)
        expect(detail).not.toContain('the extra copy is at')
      } else {
        expect(detail.endsWith(INTERNAL[caller] ?? 'MISSING')).toBe(true)
      }
      expect(detail).not.toContain('kept there')
    })
  }

  it('move-source, located but in a directory that is not private: "was reported at", not "is at"', () => {
    const f = fixture()
    const opDir = path.join(f.parent, PARKED, 'op-p')
    const run = runWithHooks({
      parentAbs: f.parent,
      name: 'tree',
      options: {
        ...(optsFor('move-source', 'move-source') as object),
        opId: 'op-p',
        guardHash: guardOf(f.origin),
      } as never,
      onAfterRename: () => fs.chmodSync(opDir, 0o777),
    })
    const detail = String(run.result.detail)
    expect(run.result.status).toBe('held')
    expect(detail).toMatch(/is not private/)
    expect(detail).toContain(`the extra copy was reported at '${String(run.result.path)}'.`)
    expect(detail).not.toContain('the extra copy is at')
    fs.chmodSync(opDir, 0o700)
  })

  it('a parked (not held) result is unaffected by the caller', () => {
    const f = fixture()
    const r = parkTree(f.parent, 'tree', optsFor('fan-out-backup', 'fan-out-overwrite'))
    expect(r.status).toBe('parked')
    expect(r.detail).toBe(null)
  })
})

describe('caller, kind and backupPath are validated before any filesystem work', () => {
  for (const [label, opts, message] of [
    ['a missing caller', { client: CLIENT, kind: 'uninstall' }, 'caller must be one of'],
    ['an unknown caller', { client: CLIENT, caller: 'spike', kind: 'uninstall' }, 'got "spike"'],
    [
      'a kind that is not the caller’s',
      { client: CLIENT, caller: 'fan-out-backup', kind: 'uninstall' },
      'caller fan-out-backup parks with kind "fan-out-overwrite", got "uninstall"',
    ],
    [
      'move-source without backupPath',
      { client: CLIENT, caller: 'move-source', kind: 'move-source' },
      'caller move-source requires backupPath',
    ],
    [
      'a relative backupPath',
      { client: CLIENT, caller: 'move-source', kind: 'move-source', backupPath: 'backups/old' },
      'caller move-source requires backupPath, the absolute path',
    ],
    [
      'a caller named like an Object.prototype member',
      { client: CLIENT, caller: 'toString', kind: 'uninstall' },
      'got "toString"',
    ],
    [
      'backupPath for another caller',
      { client: CLIENT, caller: 'uninstall', kind: 'uninstall', backupPath: BACKUP },
      'backupPath is only for caller move-source, not uninstall',
    ],
  ] as const) {
    it(`${label} is a TypeError`, () => {
      const f = fixture()
      const { value, touched } = withAllFsTrapped(() => {
        try {
          parkTree(f.parent, 'tree', opts as never)
          return 'returned'
        } catch (e) {
          return `${(e as Error).constructor.name}: ${(e as Error).message}`
        }
      })
      expect(value).toMatch(/^TypeError: /)
      expect(value).toContain(message)
      expect(touched).toEqual([])
      expect(exists(f.origin)).toBe(true)
    })
  }
})

describe('caller and backupPath are read as plain data, never by running a getter', () => {
  for (const key of ['caller', 'backupPath'] as const) {
    it(`a getter for ${key} is refused and never runs`, () => {
      const f = fixture()
      let reads = 0
      const opts: Record<string, unknown> = {
        client: CLIENT,
        caller: 'move-source',
        kind: 'move-source',
        backupPath: BACKUP,
      }
      Object.defineProperty(opts, key, {
        enumerable: true,
        get: () => {
          reads += 1
          return key === 'caller' ? 'move-source' : BACKUP
        },
      })
      const { value, touched } = withAllFsTrapped(() => {
        try {
          parkTree(f.parent, 'tree', opts as never)
          return 'returned'
        } catch (e) {
          return `${(e as Error).constructor.name}: ${(e as Error).message}`
        }
      })
      expect(value).toContain(`key "${key}" is an accessor`)
      expect(reads).toBe(0)
      expect(touched).toEqual([])
    })
  }
})

describe('the sidecar of a held park records the kind, not the caller', () => {
  it('fan-out-staging writes kind fan-out-overwrite', () => {
    const { r } = heldPark('fan-out-staging', 'fan-out-overwrite')
    const sidecar = JSON.parse(fs.readFileSync(String(r.sidecarPath), 'utf8')) as Record<
      string,
      unknown
    >
    expect(sidecar.kind).toBe('fan-out-overwrite')
    expect('caller' in sidecar).toBe(false)
    expect(path.isAbsolute(String(r.heldPath))).toBe(true)
  })
})
