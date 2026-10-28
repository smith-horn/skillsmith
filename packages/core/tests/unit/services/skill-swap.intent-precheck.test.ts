/**
 * SMI-6531 (#3202 retro, round 2, owner decision): the update refuses up front,
 * on any device, when the worst case of a park intent it could write would not
 * read back (`intentPrecheck` before `createOp`). A cross-device backup learns
 * it crosses devices only from `EXDEV` after the commit, so the update cannot
 * wait to know. Also the dominance the precheck rests on: a real intent's bytes
 * are never more than its worst case's.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INTENT_CAP } from '../../../src/services/skill-swap.intent-schema.js'
import { longestKeptName, WORST_OP_IDENTITY } from '../../../src/services/skill-swap.intent.js'
import { jsonBytes } from '../../../src/services/skill-swap.staging.js'
import { deepSnapshot } from './skill-swap.scan.helpers.js'
import {
  areaOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import { parkedCopies, useOtherDeviceCleanup, xdevFixture } from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

/** `fx` with its state root moved `len` characters deep (components of at most 200). */
function deepen(fx: Fixture, len: number): Fixture {
  let p = fx.stateRoot
  while (p.length < len)
    p = path.join(p, 'd'.repeat(Math.min(200, Math.max(1, len - p.length - 1))))
  fs.mkdirSync(p, { recursive: true })
  return { ...fx, stateRoot: p }
}

/** Deep enough that even this process's move-source intent reaches the cap. */
const DEEP = 3790

/** What the refusal must leave untouched: the skill folder, the state root (manifest, area), the journal. */
const untouched = (fx: Fixture): string =>
  [fx.realDir, fx.stateRoot, path.join(fx.base, 'journal')]
    .map((d) => deepSnapshot(d))
    .join('\n--\n')

async function refusesUntouched(fx: Fixture): Promise<void> {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const before = untouched(fx)
  const r = await run(p)
  expect(r.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe', staged: 'none' })
  const detail = (r.result as { detail: string }).detail
  // The worst case's size, and only what is true: ST (and a missing root) may already exist.
  expect(detail).toMatch(
    /^the park intent could be up to \d+ bytes, at or over the reader's 4096-byte cap; the update was not started$/
  )
  expect(fs.existsSync(fx.opDir)).toBe(false)
  const staged = fs.existsSync(fx.staging) ? fs.readdirSync(fx.staging) : []
  expect(staged.filter((n) => n.startsWith(OP_ID))).toEqual([])
  expect(fs.existsSync(areaOf(fx))).toBe(false)
  expect(untouched(fx)).toBe(before)
  // Nothing ran past the precheck: no op dir was made, so no mkdir of it is traced.
  expect(r.trace.some((t) => t.op === 'mkdir' && t.path === fx.opDir)).toBe(false)
}

describe('the update refuses a state root whose park intent could not read back', () => {
  it('across devices: staging-unsafe, with no op dir, record, backup or manifest change', async () => {
    const fx = deepen(xdevFixture(FILES), DEEP)
    expect(fs.statSync(fx.stateRoot).dev).not.toBe(fs.statSync(fx.skillsDir).dev)
    await refusesUntouched(fx)
  })

  it('on one device too (the owner’s choice: whether the backup crosses is learned after the commit)', async () => {
    const fx = deepen(makeFixture(FILES), DEEP)
    expect(fs.statSync(fx.stateRoot).dev).toBe(fs.statSync(fx.skillsDir).dev)
    await refusesUntouched(fx)
  })
})

describe('a normal state root still updates, and its real intent is within the worst case', () => {
  it('across devices: committed and parked; the real intent’s bytes <= the worst case the precheck sized', async () => {
    const fx = xdevFixture(FILES)
    const r = await run(plan(fx, [modify('SKILL.md', '# v2\n')]))
    expect(r.result).toMatchObject({ status: 'committed' })
    expect(r.result).not.toHaveProperty('incomplete')
    // The presence the refusals' "no mkdir of OP" assertion pairs with.
    expect(r.trace.some((t) => t.op === 'mkdir' && t.path === fx.opDir)).toBe(true)
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    const real = fs.readFileSync(path.join(copies[0]!, 'park-intent.json'))
    const intent = JSON.parse(real.toString('utf8')) as Record<string, unknown>
    expect(intent.backupPath).toBe(path.join(areaOf(fx), OP_ID))
    // Each bound alone: the worst identity with the real path, then the longest kept name too.
    const worstId = jsonBytes({ ...intent, opIdentity: WORST_OP_IDENTITY })
    expect(real.length).toBeLessThanOrEqual(worstId.length)
    // The worst case the precheck sizes: the longest identity and the longest kept name.
    const worst = jsonBytes({
      ...intent,
      opIdentity: WORST_OP_IDENTITY,
      backupPath: path.join(areaOf(fx), longestKeptName(OP_ID)),
    })
    expect(real.length).toBeLessThanOrEqual(worst.length)
    expect(worst.length).toBeLessThan(INTENT_CAP)
    // Field by field: no real identity number has more digits than its worst case.
    const id = intent.opIdentity as Record<string, string>
    for (const k of ['dev', 'ino', 'birthtimeNs', 'fmt'] as const) {
      expect(id[k]!.length, k).toBeLessThanOrEqual(WORST_OP_IDENTITY[k].length)
    }
  })
})

describe('this process is read once per update: owner.json, the record and the intent name one host', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a host name that changes on every call does not split them', async () => {
    const fx = xdevFixture(FILES)
    let calls = 0
    vi.spyOn(os, 'hostname').mockImplementation(() => `host-${++calls}`)
    // Stopped right after the intent is durable: owner.json, record.json and the intent are all in OP.
    const r = await run(plan(fx, [modify('SKILL.md', '# v2\n')]), {
      hooks: {
        afterIntent: () => {
          throw new Error('killed at afterIntent')
        },
      },
    })
    expect(r.result).toMatchObject({ status: 'committed', incomplete: { step: 'cleanup' } })
    const read = (n: string) =>
      JSON.parse(fs.readFileSync(path.join(fx.opDir, n), 'utf8')) as Record<string, unknown>
    const owner = read('owner.json')
    const record = read('record.json')
    const intent = read('park-intent.json') as { owner: { host: string } }
    // Presence: the stub is what named the owner (every call returns a new name).
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(owner.host).toMatch(/^host-\d+$/)
    expect(intent.owner.host).toBe(owner.host)
    expect(record.host).toBe(owner.host)
  })
})
