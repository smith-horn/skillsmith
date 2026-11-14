/**
 * SMI-6531 (A1 step 6c-i): prune's own metadata is removed only when it is
 * provably ours, a leftover is classified read-only, and a job is validated
 * before any filesystem work. Ported from the SMI-6676 spike's
 * `harness/test-w5-metadata.mjs`, with the job's per-item verdict added.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTENT_VERSION,
  parseDeletingStrict,
  parseIntentStrict,
  recordOf,
  removeIfIdentical,
} from '../../../src/install/prune.metadata.js'
import { inspectLeftover } from '../../../src/install/prune.leftovers.js'
import { decodeJob, encodeJob } from '../../../src/install/prune.job.js'
import type { FreshJob } from '../../../src/install/prune.job.js'
import { jobFor, makeParent, parkCopy, removeFixture, snapshotTree } from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

const intent = (over: Record<string, unknown> = {}) => ({
  pruneId: '0123456789abcdef',
  copyPath: '/p/.skillsmith-parked/op1/tree-00000000',
  sidecarPath: '/p/.skillsmith-parked/op1/tree-00000000.json',
  leaf: 'tree-00000000',
  approvedHash: 'a'.repeat(64),
  approvedSidecarSha256: null,
  class: 'clean',
  authorization: 'batch',
  createdAt: '2026-11-04T01:02:03.004Z',
  pid: 42,
  host: null,
  version: INTENT_VERSION,
  ...over,
})

describe('the strict metadata schemas', () => {
  it('the intent parses exactly, and nothing else does', () => {
    expect(parseIntentStrict(JSON.stringify(intent()))).not.toBeNull()
    for (const bad of [
      intent({ extra: 1 }),
      intent({ version: 'smi-7123-spike' }),
      intent({ leaf: '../x' }),
      intent({ copyPath: 'relative' }),
      intent({ pruneId: 'short' }),
      intent({ createdAt: 'yesterday' }),
    ]) {
      expect(parseIntentStrict(JSON.stringify(bad))).toBeNull()
    }
    expect(parseIntentStrict('{')).toBeNull()
  })

  it('the deleting marker parses exactly: run ID, inventory digest, pid', () => {
    const good = { pruneId: '0123456789abcdef', inventorySha256: 'a'.repeat(64), pid: 1 }
    expect(parseDeletingStrict(JSON.stringify(good))).toEqual(good)
    for (const bad of [
      { ...good, x: 1 },
      { pruneId: good.pruneId, pid: 1 },
      { ...good, pruneId: 'x' },
      { ...good, inventorySha256: 'A'.repeat(64) },
      { ...good, inventorySha256: 'a'.repeat(63) },
    ]) {
      expect(parseDeletingStrict(JSON.stringify(bad))).toBeNull()
    }
  })
})

describe('removeIfIdentical', () => {
  /** A `.prune-<16 hex>` directory: the only place removeIfIdentical acts. */
  const stagingDir = (fx: PruneFixture): string => {
    const S = path.join(fx.root, '.prune-0123456789abcdef')
    fs.mkdirSync(S, { mode: 0o700 })
    return S
  }

  it('removes the exact recorded file and leaves nothing behind', () => {
    f = makeParent('prune-meta-')
    const S = stagingDir(f)
    const p = path.join(S, 'intent.json')
    fs.writeFileSync(p, 'ours')
    const rec = recordOf(p, 'ours')
    expect(removeIfIdentical(p, rec)).toEqual({ removed: true })
    expect(fs.readdirSync(S)).toEqual([])
  })

  it('keeps a file whose bytes or inode differ from the record, untouched where it is', () => {
    f = makeParent('prune-meta-')
    const S = stagingDir(f)
    const p = path.join(S, 'intent.json')
    fs.writeFileSync(p, 'ours')
    const rec = recordOf(p, 'ours')
    fs.writeFileSync(p, 'THEIRS')
    expect(removeIfIdentical(p, rec)).toEqual({
      removed: false,
      kept: `${p}: not the inode and bytes recorded`,
    })
    // Same bytes at a new inode: the old file is kept alive aside, so its inode can't be reused.
    fs.renameSync(p, path.join(f.root, 'aside'))
    fs.writeFileSync(p, 'ours')
    expect(String(fs.lstatSync(p, { bigint: true }).ino)).not.toBe(rec.ino)
    expect(removeIfIdentical(p, rec)).toMatchObject({ removed: false })
    expect(fs.readFileSync(p, 'utf8')).toBe('ours')
  })

  it('keeps a file it has no record for, and reports an absent one as nothing kept', () => {
    f = makeParent('prune-meta-')
    const S = stagingDir(f)
    const p = path.join(S, 'deleting')
    fs.writeFileSync(p, 'x')
    expect(removeIfIdentical(p, undefined)).toEqual({
      removed: false,
      kept: `${p}: not written or inspected by this run`,
    })
    expect(removeIfIdentical(path.join(S, 'intent.json'), undefined)).toEqual({
      removed: false,
      kept: null,
    })
  })

  it('(c) refuses any name but prune metadata, and any directory but a .prune-<16 hex> one', () => {
    f = makeParent('prune-meta-')
    const S = stagingDir(f)
    const user = path.join(S, 'SKILL.md')
    fs.writeFileSync(user, 'user bytes')
    const rec = recordOf(user, 'user bytes')
    expect(() => removeIfIdentical(user, rec)).toThrow(TypeError)
    const outside = path.join(f.root, 'intent.json')
    fs.writeFileSync(outside, 'ours')
    expect(() => removeIfIdentical(outside, recordOf(outside, 'ours'))).toThrow(TypeError)
    const foreign = path.join(f.root, '.prune-nothex')
    fs.mkdirSync(foreign)
    fs.writeFileSync(path.join(foreign, 'deleting'), 'x')
    expect(() =>
      removeIfIdentical(
        path.join(foreign, 'deleting'),
        recordOf(path.join(foreign, 'deleting'), 'x')
      )
    ).toThrow(TypeError)
    expect([fs.existsSync(user), fs.existsSync(outside)]).toEqual([true, true])
  })
})

describe('inspectLeftover is read-only and fails closed', () => {
  const mk = (fx: PruneFixture): string => {
    const S = path.join(fx.parent, '.skillsmith-parked', '.prune-0123456789abcdef')
    fs.mkdirSync(S, { recursive: true, mode: 0o700 })
    fs.chmodSync(S, 0o700)
    return S
  }
  const at = (fx: PruneFixture, S: string) =>
    inspectLeftover({ S, stagingRoot: path.join(fx.parent, '.skillsmith-parked') })

  it('an intent that is not Skillsmith’s exact schema makes the leftover unknown, untouched', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.writeFileSync(path.join(S, 'intent.json'), JSON.stringify(intent({ extra: 1 })))
    fs.mkdirSync(path.join(S, 'tree-00000000'))
    const before = snapshotTree(S)
    expect(at(f, S).state).toBe('unknown')
    expect(snapshotTree(S)).toBe(before)
  })

  it('a staging directory open to others is unusable', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.chmodSync(S, 0o755)
    expect(at(f, S)).toMatchObject({ state: 'staging-unusable' })
  })

  it('two trees without an intent are unknown; one is a staged orphan', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.mkdirSync(path.join(S, 'a'))
    expect(at(f, S)).toMatchObject({ state: 'staged-orphan', leaf: 'a' })
    fs.mkdirSync(path.join(S, 'b'))
    expect(at(f, S).state).toBe('unknown')
  })

  it('F6: prune random names at the top of S are never offered as a staged orphan', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    for (const n of ['.d-0123456789abcdef', '.m-0123456789abcdef']) {
      fs.writeFileSync(path.join(S, n), 'x')
      expect(at(f, S).state).toBe('unknown')
      fs.unlinkSync(path.join(S, n))
    }
  })

  it('an incomplete intent temp is partial-intent with nothing to clean, never unknown', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.writeFileSync(path.join(S, 'intent.json.tmp'), JSON.stringify(intent()).slice(0, 40))
    expect(at(f, S)).toMatchObject({ state: 'partial-intent', cleanup: [] })
  })

  it('a staged sidecar without its copy is unknown', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.writeFileSync(path.join(S, 'intent.json'), JSON.stringify(intent()))
    fs.writeFileSync(path.join(S, 'sidecar.json'), '{}')
    expect(at(f, S).state).toBe('unknown')
  })
})

describe('the job', () => {
  it('a fresh job round-trips through JSON', () => {
    f = makeParent('prune-job-')
    const c = parkCopy(f.parent, 'tree')
    const job = jobFor(c)
    const back = decodeJob(JSON.parse(JSON.stringify(encodeJob(job)))) as FreshJob
    expect(back.rootIdentity).toEqual(job.rootIdentity)
    expect(back.sidecarRead?.bytes.equals(job.sidecarRead?.bytes ?? Buffer.alloc(0))).toBe(true)
    expect(back.sidecarRead?.ino).toBe(job.sidecarRead?.ino)
  })

  it('a malformed fresh job is a TypeError, never a walk', () => {
    f = makeParent('prune-job-')
    const enc = encodeJob(jobFor(parkCopy(f.parent, 'tree'))) as unknown as Record<string, unknown>
    for (const bad of [
      { ...enc, klass: 'mounted' },
      { ...enc, authorization: 'yes' },
      { ...enc, stagingRoot: undefined },
      { ...enc, rootIdentity: { dev: '1', ino: 'x', birthtimeNs: '3' } },
      { ...enc, sidecarRead: undefined },
    ]) {
      expect(() => decodeJob(bad)).toThrow(TypeError)
    }
  })

  it('m1/F4: a fresh job whose paths or names do not relate is a TypeError, each named', () => {
    f = makeParent('prune-job-')
    const c = parkCopy(f.parent, 'tree')
    const enc = encodeJob(jobFor(c)) as unknown as Record<string, unknown>
    for (const [bad, why] of [
      [{ ...enc, leaf: '../x' }, 'single path segment'],
      [
        { ...enc, leaf: 'intent.json', copyPath: path.join(c.opDir, 'intent.json') },
        "prune's own names",
      ],
      [
        { ...enc, leaf: 'inventory.json', copyPath: path.join(c.opDir, 'inventory.json') },
        "prune's own names",
      ],
      [
        {
          ...enc,
          leaf: '.d-0123456789abcdef',
          copyPath: path.join(c.opDir, '.d-0123456789abcdef'),
        },
        "prune's own names",
      ],
      [{ ...enc, leaf: 'other' }, 'leaf must be the copy name'],
      [
        { ...enc, sidecarPath: '/elsewhere/tree.json' },
        'sidecarPath must be <copyPath>.json or null',
      ],
      [{ ...enc, opDir: c.stagingRoot }, "opDir must be the copy's own directory"],
      [{ ...enc, approvedHash: 'A'.repeat(64) }, '64 lowercase hex'],
      [{ ...enc, copyPath: 'relative/tree' }, 'copyPath must be an absolute path'],
      [{ ...enc, inventorySha256: 'a'.repeat(64) }, 'inventorySha256 needs S'],
      [{ ...enc, inheritedMeta: {} }, 'inheritedMeta needs S'],
      [{ ...enc, rootIdentity: { ...(enc.rootIdentity as object), fmt: undefined } }, 'fmt'],
    ] as const) {
      expect(() => decodeJob(bad), why).toThrow(why)
    }
  })

  it('a resume job names S and the inventory digest, and approves nothing new', () => {
    f = makeParent('prune-job-')
    const c = parkCopy(f.parent, 'tree')
    const S = path.join(c.stagingRoot, '.prune-0123456789abcdef')
    const meta = { ino: '1', bytes: 'b3Vycw==' }
    const good = {
      S,
      copyPath: path.join(S, c.name),
      leaf: c.name,
      klass: 'held',
      authorization: 'per-item',
      stagingRoot: c.stagingRoot,
      opDir: c.opDir,
      inventorySha256: 'a'.repeat(64),
      inheritedMeta: { deleting: meta },
    }
    expect(decodeJob(good)).toEqual(good)
    for (const [bad, why] of [
      [{ ...good, S: path.join(c.stagingRoot, '.prune-xyz') }, '.prune-<16 hex> directory'],
      [{ ...good, S: path.join(f.root, '.prune-0123456789abcdef') }, '.prune-<16 hex> directory'],
      [{ ...good, copyPath: path.join(c.stagingRoot, c.name) }, 'copyPath must be S/<leaf>'],
      [{ ...good, inventorySha256: undefined }, 'inventorySha256'],
      [{ ...good, inventorySha256: 'A'.repeat(64) }, 'inventorySha256'],
      [{ ...good, authorization: 'batch' }, 'per item only'],
      [{ ...good, approvedHash: 'a'.repeat(64) }, 'carries no approvedHash'],
      [{ ...good, sidecarPath: null }, 'carries no sidecarPath'],
      [{ ...good, inheritedMeta: { 'SKILL.md': meta } }, 'only intent.json and deleting'],
      [
        { ...good, inheritedMeta: { deleting: { ino: 'x', bytes: '' } } },
        'must be {ino: decimal, bytes: base64}',
      ],
    ] as const) {
      expect(() => decodeJob(bad), why).toThrow(why)
    }
  })
})
