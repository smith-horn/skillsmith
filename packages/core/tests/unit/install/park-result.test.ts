/**
 * SMI-6531: the result shape and option resolution, ported from the SMI-6676
 * spike's `harness/test-result-shape-parity.mjs` (the native-path and
 * dispatcher halves are not ported: the product has one path). Key sets are
 * compared against a contract written out literally, never against
 * RESULT_FIELDS itself (spike R5-7: both sides from one array is a tautology).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkTree } from '../../../src/install/park-tree.js'
import {
  RESULT_FIELDS,
  isSuccess,
  resolveParkOptions,
  shapeResult,
} from '../../../src/install/park-result.js'
import type { ParkOptions, PartialParkResult } from '../../../src/install/park-result.js'
import {
  CLIENT,
  cleanup,
  errnoError,
  exists,
  guardOf,
  park,
  simpleFixture,
  KIND,
  withAllFsTrapped,
  withFsStub,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-shape-', 'bytes')
  roots.push(f.root)
  return f
}
const keys = (o: object) => Object.keys(o).sort().join(',')
const CONTRACT_FIELDS = [
  'status',
  'reason',
  'path',
  'entry',
  'treeHash',
  'errno',
  'opId',
  'sidecarPath',
  'detail',
  'originPath',
  'heldPath',
  'misplaced',
  'parkedAreaCreated',
]
/** The constructor name of what `fn` threw, or `ret:<status>`. */
const outcome = (fn: () => { status: string }): string => {
  try {
    return `ret:${fn().status}`
  } catch (e) {
    return (e as Error).constructor.name
  }
}
/** parkTree with an options value the type system would refuse. */
const parkLoose = (parent: string, name: string, options: unknown) =>
  parkTree(parent, name, options as ParkOptions)

/** `opts` refused with TypeError before any fs call, and nothing moved or created. */
const refusedUntouched = (opts: unknown) => {
  const f = fixture()
  const { value, touched, deletes } = withAllFsTrapped(() =>
    outcome(() => parkLoose(f.parent, 'tree', opts))
  )
  expect(value).toBe('TypeError')
  expect(touched).toEqual([])
  expect(deletes).toEqual([])
  expect(exists(f.origin)).toBe(true)
  expect(exists(path.join(f.parent, '.skillsmith-parked'))).toBe(false)
}

describe('the contract', () => {
  it('every declared field is present after shaping, and RESULT_FIELDS matches the written contract', () => {
    expect(keys(shapeResult({ status: 'kept' }))).toBe([...CONTRACT_FIELDS].sort().join(','))
    expect([...RESULT_FIELDS].sort().join(',')).toBe([...CONTRACT_FIELDS].sort().join(','))
  })

  it('absent fields are null, never undefined', () => {
    expect(shapeResult({ status: 'kept' }).reason).toBe(null)
  })

  it('extras named like Object.prototype members survive shaping (spike m-6)', () => {
    for (const k of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(shapeResult({ status: 'kept', [k]: 'carried' } as PartialParkResult)[k]).toBe(
        'carried'
      )
    }
    expect(shapeResult({ status: 'kept', sidecarError: 'carried' }).sidecarError).toBe('carried')
  })

  it('an unknown status, including the spike spelling quarantined, is refused', () => {
    for (const s of ['vanished', 'quarantined']) {
      expect(() => shapeResult({ status: s } as unknown as PartialParkResult)).toThrow(TypeError)
    }
  })

  it('parked and removed are success; kept, stopped and held are not', () => {
    expect(isSuccess({ status: 'parked' }) && isSuccess({ status: 'removed' })).toBe(true)
    for (const s of ['kept', 'stopped', 'held']) expect(isSuccess({ status: s })).toBe(false)
  })

  it('a parked result carries every contract field and its verified treeHash', () => {
    const f = fixture()
    const guardHash = guardOf(f.origin)
    const r = park(f.parent, 'tree', { guardHash })
    expect(keys(r)).toBe([...CONTRACT_FIELDS].sort().join(','))
    expect(r.status).toBe('parked')
    expect(r.treeHash).toBe(guardHash)
  })

  it('a kept result carries every contract field and leaves the tree alone', () => {
    const f = fixture()
    const r = park(f.parent, 'tree', { guardHash: 'deliberately-wrong' })
    expect(r.status).toBe('kept')
    expect(keys(r)).toBe([...CONTRACT_FIELDS].sort().join(','))
    expect(exists(f.origin)).toBe(true)
  })

  it('3h: a sidecar failure is still parked, reports it, and keeps the verified treeHash and entry', () => {
    const f = fixture()
    const guardHash = guardOf(f.origin)
    const r = withFsStub(
      'writeFileSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).endsWith('.json')) throw errnoError('ENOSPC')
          return orig(...args)
        },
      () => park(f.parent, 'tree', { guardHash })
    )
    expect(r.status).toBe('parked')
    expect(r.sidecarError).toBe('ENOSPC')
    expect(r.treeHash).toBe(guardHash)
    expect(r.entry).toBe('tree')
  })
})

describe('guardHash (ADR-166 D-5)', () => {
  for (const [label, value] of [
    ['null', null],
    ['an empty string', ''],
    ['a number', 42],
  ] as const) {
    it(`guardHash ${label} throws TypeError before any filesystem work`, () => {
      const f = fixture()
      const r = withFsStub(
        'lstatSync',
        () => () => {
          throw new Error('filesystem touched')
        },
        () =>
          outcome(() =>
            parkLoose(f.parent, 'tree', { client: CLIENT, kind: KIND, guardHash: value })
          )
      )
      expect(r).toBe('TypeError')
      expect(exists(f.origin)).toBe(true)
      expect(exists(path.join(f.parent, '.skillsmith-parked'))).toBe(false)
    })
  }

  it('omitting guardHash still parks (the guard is not mandatory)', () => {
    const f = fixture()
    expect(park(f.parent, 'tree').status).toBe('parked')
  })

  it('the deprecated spike alias treeHash is an unknown option, not a guard', () => {
    const f = fixture()
    expect(
      outcome(() => parkLoose(f.parent, 'tree', { client: CLIENT, kind: KIND, treeHash: 'x' }))
    ).toBe('TypeError')
    expect(exists(f.origin)).toBe(true)
  })
})

describe('unknown and invalid options', () => {
  const misspelled: [string, () => object][] = [
    ['an own literal key', () => ({ client: CLIENT, kind: KIND, guardhash: 'WRONG' })],
    [
      'an inherited key',
      () =>
        Object.create(
          { guardhash: 'WRONG' },
          {
            client: { value: CLIENT, enumerable: true },
            kind: { value: KIND, enumerable: true },
          }
        ),
    ],
    [
      'a non-enumerable key',
      () => {
        const o = { client: CLIENT, kind: KIND }
        Object.defineProperty(o, 'guardhash', { value: 'WRONG', enumerable: false })
        return o
      },
    ],
  ]
  for (const [label, make] of misspelled) {
    it(`a misspelled guard as ${label} is refused, so it cannot run unguarded`, () => {
      const f = fixture()
      expect(outcome(() => parkLoose(f.parent, 'tree', make()))).toBe('TypeError')
      expect(exists(f.origin)).toBe(true)
    })
  }

  it('a missing or empty client is refused (no default)', () => {
    const f = fixture()
    expect(outcome(() => parkLoose(f.parent, 'tree', { kind: KIND }))).toBe('TypeError')
    expect(outcome(() => parkLoose(f.parent, 'tree', { client: '', kind: KIND }))).toBe('TypeError')
    expect(outcome(() => parkLoose(f.parent, 'tree', undefined))).toBe('TypeError')
    expect(exists(f.origin)).toBe(true)
  })

  for (const [label, opts] of [
    ['a missing kind', { client: CLIENT }],
    ['an empty kind', { client: CLIENT, kind: '' }],
  ] as const) {
    it(`${label} throws TypeError before any filesystem work (kind is required)`, () => {
      refusedUntouched(opts)
    })
  }

  // Review round 1, F1: a guard under a symbol key was invisible to the key scan.
  const symbolShapes: [string, (h: string) => object][] = [
    ['an own symbol key', (h) => ({ client: CLIENT, kind: KIND, [Symbol('guardHash')]: h })],
    [
      'an inherited symbol key',
      (h) =>
        Object.assign(Object.create({ [Symbol('guardHash')]: h }), { client: CLIENT, kind: KIND }),
    ],
    [
      'a non-enumerable symbol key',
      (h) => {
        const o = { client: CLIENT, kind: KIND }
        Object.defineProperty(o, Symbol('guardHash'), { value: h, enumerable: false })
        return o
      },
    ],
  ]
  for (const [label, make] of symbolShapes) {
    it(`${label} throws TypeError before any filesystem work`, () => {
      refusedUntouched(make('DELIBERATELY-WRONG'))
    })
  }

  it('maxBirthtimeNs null or a number is refused rather than guessed at', () => {
    const f = fixture()
    for (const v of [null, 5]) {
      expect(
        outcome(() =>
          parkLoose(f.parent, 'tree', { client: CLIENT, kind: KIND, maxBirthtimeNs: v })
        )
      ).toBe('TypeError')
    }
    expect(exists(f.origin)).toBe(true)
  })

  it('expectIdentity null is refused; a relative indexPath is refused', () => {
    const f = fixture()
    expect(
      outcome(() =>
        parkLoose(f.parent, 'tree', { client: CLIENT, kind: KIND, expectIdentity: null })
      )
    ).toBe('TypeError')
    expect(
      outcome(() =>
        parkLoose(f.parent, 'tree', { client: CLIENT, kind: KIND, indexPath: 'idx.jsonl' })
      )
    ).toBe('TypeError')
    expect(exists(f.origin)).toBe(true)
  })
})

describe('opId and name are single segments (spike F6)', () => {
  it('opId traversal into a pre-created directory is refused and nothing lands there', () => {
    const f = fixture()
    const loot = path.join(f.root, 'loot')
    fs.mkdirSync(loot)
    expect(outcome(() => park(f.parent, 'tree', { opId: '../../loot' }))).toBe('TypeError')
    expect(fs.readdirSync(loot)).toEqual([])
    expect(exists(f.origin)).toBe(true)
  })

  it('opId .., a/b and a leading dot are refused; name traversal is refused', () => {
    const f = fixture()
    for (const bad of ['..', 'a/b', '.prune-x']) {
      expect(outcome(() => park(f.parent, 'tree', { opId: bad }))).toBe('TypeError')
    }
    expect(outcome(() => park(f.parent, '../escape'))).toBe('TypeError')
    expect(exists(f.origin)).toBe(true)
  })
})

describe('options are plain data, read without running caller code (review rounds 1 and 2)', () => {
  it('resolveParkOptions returns plain data with every known key', () => {
    const r = resolveParkOptions({ client: CLIENT, kind: KIND })
    expect(Object.keys(r).sort()).toEqual(
      [
        'client',
        'expectIdentity',
        'guardHash',
        'indexPath',
        'kind',
        'maxBirthtimeNs',
        'opId',
        'rootKey',
      ].sort()
    )
    expect(r.rootKey).toBe(null)
  })

  class WithOwnFields {
    client = CLIENT
    kind = KIND
    guardHash = 'DELIBERATELY-WRONG'
  }
  const refusedShapes: [string, () => unknown][] = [
    [
      'an accessor that adds a hidden symbol key after the keys were listed',
      () => {
        const sym = Symbol('guardHash')
        return {
          kind: KIND,
          get client() {
            Object.defineProperty(this, sym, { value: 'X', enumerable: false })
            return CLIENT
          },
        }
      },
    ],
    [
      'a Proxy whose ownKeys trap hides a symbol key',
      () => {
        const sym = Symbol('guardHash')
        const target = { client: CLIENT, kind: KIND, [sym]: 'X' }
        return new Proxy(target, {
          ownKeys: (t) => Reflect.ownKeys(t).filter((k) => typeof k !== 'symbol'),
        })
      },
    ],
    [
      'a Proxy with no traps around a valid literal',
      () => new Proxy({ client: CLIENT, kind: KIND }, {}),
    ],
    [
      'a getter on client',
      () => ({
        kind: KIND,
        get client() {
          return CLIENT
        },
      }),
    ],
    [
      'a getter on guardHash',
      () => ({
        client: CLIENT,
        kind: KIND,
        get guardHash() {
          return 'DELIBERATELY-WRONG'
        },
      }),
    ],
    [
      // A getter-only accessor check would read this guard as absent and park unguarded.
      'a setter-only guardHash',
      () => ({
        client: CLIENT,
        kind: KIND,
        set guardHash(_v: string) {},
      }),
    ],
    [
      'a revoked Proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({ client: CLIENT, kind: KIND }, {})
        revoke()
        return proxy
      },
    ],
    ['a class instance with own fields', () => new WithOwnFields()],
    [
      'Object.create({ guardHash }) with own client and kind',
      () =>
        Object.assign(Object.create({ guardHash: 'DELIBERATELY-WRONG' }), {
          client: CLIENT,
          kind: KIND,
        }),
    ],
  ]
  for (const [label, make] of refusedShapes) {
    it(`${label} is refused before any filesystem work`, () => {
      refusedUntouched(make())
    })
  }

  it('a non-enumerable own guardHash data property is honoured as the guard', () => {
    const f = fixture()
    const o = { client: CLIENT, kind: KIND }
    Object.defineProperty(o, 'guardHash', { value: 'DELIBERATELY-WRONG', enumerable: false })
    const r = parkLoose(f.parent, 'tree', o)
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(exists(f.origin)).toBe(true)
  })

  it('a polluted Object.prototype.guardHash is ignored: the literal parks unguarded', () => {
    const f = fixture()
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto.guardHash = 'wrong'
      const r = park(f.parent, 'tree')
      expect(r.status).toBe('parked')
      expect(r.treeHash).toBe(null)
      const sidecar = JSON.parse(fs.readFileSync(String(r.sidecarPath), 'utf8')) as Record<
        string,
        unknown
      >
      expect(Object.prototype.hasOwnProperty.call(sidecar, 'guardHash')).toBe(false)
      expect(sidecar.treeHash).toBe(null)
      expect(sidecar.postMoveVerified).toBe(undefined)
    } finally {
      delete proto.guardHash
    }
  })

  it('Object.create(null) with valid own keys parks', () => {
    const f = fixture()
    const o = Object.assign(Object.create(null), {
      client: CLIENT,
      kind: KIND,
      guardHash: guardOf(f.origin),
    }) as ParkOptions
    expect(parkTree(f.parent, 'tree', o).status).toBe('parked')
  })
})

describe('expectIdentity is plain data too, copied once (UD24, SMI-7130)', () => {
  const ID = { dev: 1n, ino: 2n, birthtimeNs: 3n, fmt: 0o040000n }
  const withId = (expectIdentity: unknown) => ({ client: CLIENT, kind: KIND, expectIdentity })

  it('a getter on fmt is refused before any filesystem work, and the getter never runs', () => {
    let reads = 0
    const id = {
      dev: 1n,
      ino: 2n,
      birthtimeNs: 3n,
      get fmt() {
        reads += 1
        return 0o040000n
      },
    }
    refusedUntouched(withId(id))
    expect(reads).toBe(0)
  })

  const refused: [string, () => unknown][] = [
    ['a Proxy', () => new Proxy({ ...ID }, {})],
    ['a missing field', () => ({ dev: 1n, ino: 2n, birthtimeNs: 3n })],
    ['a number field', () => ({ ...ID, ino: 2 })],
    ['an extra key', () => ({ ...ID, mode: 1n })],
    ['a symbol key', () => ({ ...ID, [Symbol('fmt')]: 1n })],
    ['a class instance', () => Object.assign(new (class Id {})(), ID)],
  ]
  for (const [label, make] of refused) {
    it(`${label} is refused before any filesystem work`, () => {
      refusedUntouched(withId(make()))
    })
  }

  it('a valid plain identity is returned as a fresh, frozen, null-prototype copy', () => {
    const caller = { ...ID }
    const r = resolveParkOptions(withId(caller))
    const copy = r.expectIdentity as unknown as Record<string, bigint>
    expect(copy).not.toBe(caller)
    expect(Object.getPrototypeOf(copy)).toBe(null)
    expect(Object.isFrozen(copy)).toBe(true)
    expect({ ...copy }).toEqual(ID)
    caller.ino = 99n
    expect(copy.ino).toBe(2n)
  })
})
