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

  it('the deleting marker parses exactly', () => {
    expect(
      parseDeletingStrict(JSON.stringify({ pruneId: '0123456789abcdef', pid: 1 }))
    ).not.toBeNull()
    expect(
      parseDeletingStrict(JSON.stringify({ pruneId: '0123456789abcdef', pid: 1, x: 1 }))
    ).toBeNull()
    expect(parseDeletingStrict(JSON.stringify({ pruneId: 'x', pid: 1 }))).toBeNull()
  })
})

describe('removeIfIdentical', () => {
  it('removes the exact recorded file, by a random name', () => {
    f = makeParent('prune-meta-')
    const p = path.join(f.root, 'intent.json')
    fs.writeFileSync(p, 'ours')
    const rec = recordOf(p, 'ours')
    expect(removeIfIdentical(p, rec)).toEqual({ removed: true })
    expect(fs.readdirSync(f.root)).toEqual(['parent'])
  })

  it('keeps a file whose bytes or inode differ from the record, untouched where it is', () => {
    f = makeParent('prune-meta-')
    const p = path.join(f.root, 'intent.json')
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
    const p = path.join(f.root, 'deleting')
    fs.writeFileSync(p, 'x')
    expect(removeIfIdentical(p, undefined)).toEqual({
      removed: false,
      kept: `${p}: not written or inspected by this run`,
    })
    expect(removeIfIdentical(path.join(f.root, 'gone'), undefined)).toEqual({
      removed: false,
      kept: null,
    })
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

  it('a staged sidecar without its copy is unknown', () => {
    f = makeParent('prune-left-')
    const S = mk(f)
    fs.writeFileSync(path.join(S, 'intent.json'), JSON.stringify(intent()))
    fs.writeFileSync(path.join(S, 'sidecar.json'), '{}')
    expect(at(f, S).state).toBe('unknown')
  })
})

describe('the job', () => {
  it('round-trips through JSON', () => {
    f = makeParent('prune-job-')
    const c = parkCopy(f.parent, 'tree')
    const job = jobFor(c)
    const back = decodeJob(JSON.parse(JSON.stringify(encodeJob(job))))
    expect(back.rootIdentity).toEqual(job.rootIdentity)
    expect(back.sidecarRead?.bytes.equals(job.sidecarRead?.bytes ?? Buffer.alloc(0))).toBe(true)
    expect(back.sidecarRead?.ino).toBe(job.sidecarRead?.ino)
  })

  it('a malformed job is a TypeError, never a walk', () => {
    f = makeParent('prune-job-')
    const enc = encodeJob(jobFor(parkCopy(f.parent, 'tree'))) as unknown as Record<string, unknown>
    for (const bad of [
      { ...enc, klass: 'mounted' },
      { ...enc, authorization: 'yes' },
      { ...enc, stagingRoot: undefined },
      { ...enc, rootIdentity: { dev: '1', ino: 'x', birthtimeNs: '3' } },
      { ...enc, sidecarRead: undefined },
      { ...enc, resume: 'yes' },
    ]) {
      expect(() => decodeJob(bad)).toThrow(TypeError)
    }
  })
})
