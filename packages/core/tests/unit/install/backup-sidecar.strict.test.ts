/**
 * SMI-6531 (A1 step 6c-i, owner decision 2026-11-05): the one shared strict
 * parser of a backup-area sidecar accepts exactly what the writer writes. Real
 * `sidecarOf` output for every `PublishKind`, with each kind's extras, is
 * round-tripped through JSON and parsed; the key table is checked against what
 * the writer emits; and edits the writer never makes are refused.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NULL_HASH_KINDS,
  PUBLISH_KIND_TABLE,
  SIDECAR_KEYS,
  parseBackupSidecarStrict,
} from '../../../src/install/backup-sidecar.strict.js'
import { sidecarOf } from '../../../src/services/skill-swap.sidecar.js'
import type { PublishKind } from '../../../src/services/skill-swap.sidecar.js'
import type { SwapState } from '../../../src/services/skill-swap.ops.js'
import type { TreeHashResult } from '../../../src/services/skill-tree.js'
import type { BoundIdentity } from '../../../src/install/park-tree.identity.js'

const ID: BoundIdentity = { ok: true, dev: 1n, ino: 2n, birthtimeNs: 3n, fmt: 0o040000n }
const OP_ID: BoundIdentity = { ok: true, dev: 1n, ino: 9n, birthtimeNs: 4n, fmt: 0o040000n }
const HASHED = { ok: true, hash: 'a'.repeat(64), record: new Map() } as TreeHashResult
const UNHASHED = { ok: false, reason: 'unreadable', path: '/x/y' } as unknown as TreeHashResult

/** The parts of a swap's state `sidecarOf` reads, and nothing else. */
const state = (withOp: boolean, dirName = 'foo'): SwapState =>
  ({
    opId: 'op-0123',
    input: { dirName, client: 'claude-code', scope: 'global', manifestKey: 'foo' },
    binding: { root: '/home/u/.claude/skills' },
    op: withOp ? { identity: OP_ID } : null,
  }) as unknown as SwapState

const KINDS = Object.keys(PUBLISH_KIND_TABLE) as PublishKind[]

/** Each kind with every extra the writer can attach to it. */
function variants(kind: PublishKind) {
  const out = [{ label: 'hashed', sc: sidecarOf(state(false), kind, HASHED, ID) }]
  // Only the kinds kept when unhashable ever record a null hash (F7).
  if (NULL_HASH_KINDS[kind]) {
    out.push({ label: 'unhashed', sc: sidecarOf(state(false), kind, UNHASHED, ID) })
  }
  // dirName is basename(comparedPath): a dot-leading folder is one component.
  out.push({
    label: 'dot-leading dirName',
    sc: sidecarOf(state(false, '.hidden-skill'), kind, HASHED, ID),
  })
  if (kind === 'partial-copy') {
    for (const partialCause of ['enospc', 'mismatch', 'copy-failed'] as const) {
      out.push({
        label: `partial ${partialCause}`,
        sc: sidecarOf(state(false), kind, HASHED, ID, { sourceUnchanged: true, partialCause }),
      })
    }
  }
  if (kind.startsWith('abandoned-')) {
    out.push({ label: 'with op identity', sc: sidecarOf(state(true), kind, HASHED, ID) })
  }
  return out
}

describe('the shared strict parser accepts what sidecarOf writes', () => {
  for (const kind of KINDS) {
    for (const { label, sc } of variants(kind)) {
      it(`${kind} (${label}) round-trips`, () => {
        const back: unknown = JSON.parse(JSON.stringify(sc, null, 2))
        const r = parseBackupSidecarStrict(back)
        expect(r.ok ? 'ok' : r.detail).toBe('ok')
        expect(r.ok && r.sidecar).toEqual(back)
      })
    }
  }

  it('the key table covers every key the writer emitted across the variants', () => {
    const seen = new Set<string>()
    for (const kind of KINDS)
      for (const { sc } of variants(kind)) Object.keys(sc).forEach((k) => seen.add(k))
    expect([...seen].sort()).toEqual(Object.keys(SIDECAR_KEYS).sort())
  })
})

describe('the shared strict parser refuses what the writer never writes', () => {
  const good = () =>
    JSON.parse(JSON.stringify(sidecarOf(state(false), 'backup', HASHED, ID))) as Record<
      string,
      unknown
    >
  for (const [label, edit] of [
    ['an extra key', (s: Record<string, unknown>) => ({ ...s, extra: 1 })],
    ['a missing key', ({ scope: _s, ...s }: Record<string, unknown>) => s],
    ['an unknown kind', (s: Record<string, unknown>) => ({ ...s, kind: 'mystery' })],
    ['a non-hex treeHash', (s: Record<string, unknown>) => ({ ...s, treeHash: 'abc' })],
    ['treeHashError beside a hash', (s: Record<string, unknown>) => ({ ...s, treeHashError: 'x' })],
    [
      'sourceUnchanged on a backup',
      (s: Record<string, unknown>) => ({ ...s, sourceUnchanged: true }),
    ],
    [
      'opDirIdentity on a backup',
      (s: Record<string, unknown>) => ({ ...s, opDirIdentity: s.identity }),
    ],
    [
      'a non-decimal identity',
      (s: Record<string, unknown>) => ({
        ...s,
        identity: { dev: 'x', ino: '2', birthtimeNs: '3', fmt: '4' },
      }),
    ],
    ['a relative skillsDir', (s: Record<string, unknown>) => ({ ...s, skillsDir: 'skills' })],
    ['a traversing opId', (s: Record<string, unknown>) => ({ ...s, opId: '../op' })],
    ['a dirName with a slash', (s: Record<string, unknown>) => ({ ...s, dirName: 'a/b' })],
    [
      'a date that does not round-trip',
      (s: Record<string, unknown>) => ({ ...s, createdAt: '2026-11-05' }),
    ],
  ] as const) {
    it(label, () => {
      expect(parseBackupSidecarStrict(good()).ok).toBe(true)
      expect(parseBackupSidecarStrict(edit(good())).ok).toBe(false)
    })
  }
})

describe('F7: which kinds may record a null tree hash', () => {
  it("the table's HASH_OPTIONAL half is skill-swap.publish.ts's own set, plus partial-copy", () => {
    const src = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/services/skill-swap.publish.ts'
      ),
      'utf8'
    )
    const m = /const HASH_OPTIONAL[^=]*= new Set\(\[([^\]]*)\]\)/.exec(src)
    expect(m).not.toBeNull()
    const publish = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    expect(publish.length).toBeGreaterThan(0)
    const nullable = Object.entries(NULL_HASH_KINDS)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
    expect(nullable).toEqual([...publish, 'partial-copy'].sort())
  })

  for (const kind of KINDS.filter((k) => !NULL_HASH_KINDS[k])) {
    it(`a null treeHash on ${kind} is refused`, () => {
      const sc = JSON.parse(JSON.stringify(sidecarOf(state(false), kind, UNHASHED, ID))) as unknown
      expect(parseBackupSidecarStrict(sc).ok).toBe(false)
    })
  }

  it('a dirName of ., .., empty, or with a slash, backslash or NUL is refused', () => {
    for (const dirName of ['.', '..', '', 'a/b', 'a\\b', 'a\u0000b']) {
      const sc = JSON.parse(
        JSON.stringify(sidecarOf(state(false, dirName), 'backup', HASHED, ID))
      ) as unknown
      expect(parseBackupSidecarStrict(sc).ok, JSON.stringify(dirName)).toBe(false)
    }
  })
})
