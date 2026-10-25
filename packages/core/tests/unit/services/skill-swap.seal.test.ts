/**
 * SMI-6531 (PR #3162 retro): step 5 writes exactly the bytes it sealed.
 *
 * `sealRecord` serializes the record once, runs the scan's checks on those
 * bytes, and `writeRecord` publishes them. A second serialization at publish
 * would agree with the seal for plain data, so the test uses an entry whose
 * JSON changes only after the seal's own calls: the record on disk must hold
 * the sealed value.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapRecord } from '../../../src/services/skill-swap.js'
import { scanStagingRecords } from '../../../src/services/skill-swap.records.js'
import { sealRecord } from '../../../src/services/skill-swap.staging.js'
import { makeFixture, modify, plan, readRecord, run, useTmpCleanup } from './skill-swap.helpers.js'
import { opDirOf, opIdN } from './skill-swap.scan.helpers.js'

useTmpCleanup()

/** A run whose pre-commit check fails after the swap, so its record is kept. */
async function keptRun(preEntry: unknown, opId: string) {
  const fx = makeFixture({ 'SKILL.md': '# v1\n' })
  const p = plan(fx, [modify('SKILL.md', '# next\n')])
  p.input = { ...p.input, preEntry }
  p.manifest.preCommitError = new Error('manifest lock lost')
  return { fx, p, opId }
}

/**
 * How many times `sealRecord` serializes an entry, measured on a real
 * record body (from a control run) rather than assumed, so the threshold
 * below follows the seal if it is refactored.
 */
async function sealCallCount(): Promise<number> {
  const k = await keptRun(null, opIdN('h'))
  expect((await run(k.p, { opId: k.opId })).result.status).toBe('stopped')
  const kept = readRecord(path.join(opDirOf(k.fx, k.opId), 'record.json'))
  const { recordSha256: _h, ...body } = kept
  let n = 0
  // Counts each serialization but always serializes the same, so the seal accepts it.
  const stable = {
    toJSON: () => {
      n++
      return 'same'
    },
  }
  const counted: Omit<SwapRecord, 'recordSha256'> = { ...body, preEntry: stable }
  sealRecord(counted, fs.realpathSync(k.fx.skillsDir), k.opId)
  expect(n).toBeGreaterThan(0)
  return n
}

describe('step 5 publishes the sealed bytes', () => {
  it('an entry whose JSON changes after the seal is recorded as the seal saw it', async () => {
    const sealCalls = await sealCallCount()
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    let calls = 0
    let atRecord = -1
    // The seal's own calls see 'early'; any later serialization sees 'late'.
    p.input = {
      ...p.input,
      preEntry: { toJSON: () => ({ n: ++calls > sealCalls ? 'late' : 'early' }) },
    }
    // Keep the record: the commit's pre-commit check fails after the swap.
    p.manifest.preCommitError = new Error('manifest lock lost')
    const op = opIdN('g')
    const r = await run(p, {
      opId: op,
      hooks: {
        afterRecord: () => {
          atRecord = calls
        },
      },
    })
    expect(r.result.status).toBe('stopped')

    const text = fs.readFileSync(path.join(opDirOf(fx, op), 'record.json'), 'utf8')
    expect((JSON.parse(text) as { preEntry: unknown }).preEntry).toEqual({ n: 'early' })
    // By the time the record is published, the seal is the only caller so far.
    expect(atRecord).toBe(sealCalls)
    const scan = await scanStagingRecords(fs.realpathSync(fx.skillsDir), fx.staging)
    expect(scan).toMatchObject({ ok: true, unreadable: [] })
    expect(scan.ok && scan.pending.map((x) => x.opId)).toEqual([op])
  })
})
