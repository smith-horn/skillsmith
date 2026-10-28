/**
 * SMI-6531 (A1 step 6a-i): the write-path changes 6a-i makes: record schema 1's
 * `op`, `target.scope` and `target.dirName`; the `swapInPlace` input check; the
 * write path's advice for a record naming another root (design Q6); and
 * `readRecordFile`, extracted from the scan's `judge`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSwapRecord,
  MAX_RECORD_BYTES,
  parseRecordBytes,
  readRecordFile,
  scanStagingRecords,
  verifyRecordBytes,
} from '../../../../src/services/skill-swap.records.js'
import { TARGET_KEYS, TOP_KEYS } from '../../../../src/services/skill-swap.record-schema.js'
import {
  crashStopped,
  attempt,
  opDirOf,
  opIdN,
  otherSkill,
  plantRecordText,
} from '../skill-swap.scan.helpers.js'
import {
  makeFixture,
  modify,
  OP_ID,
  plan,
  readRecord,
  run,
  tmp,
  useTmpCleanup,
} from '../skill-swap.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

/** A record a real run wrote, as its parsed JSON and its bytes. */
async function realRecord(): Promise<{
  json: Record<string, unknown>
  bytes: Buffer
  root: string
  opId: string
}> {
  const fx = file()
  const crashed = await crashStopped(fx)
  const recPath = path.join(crashed.opDir, 'record.json')
  return {
    json: readRecord(recPath) as unknown as Record<string, unknown>,
    bytes: fs.readFileSync(recPath),
    root: fs.realpathSync(fx.skillsDir),
    opId: OP_ID,
  }
}

describe('record schema 1 carries op, target.scope and target.dirName', () => {
  it('a record a real update wrote has all three, verifies, and says what they are', async () => {
    const r = await realRecord()
    expect(r.json.op).toBe('update')
    const target = r.json.target as Record<string, unknown>
    expect(target.scope).toBe('global')
    expect(target.dirName).toBe('my-skill')
    expect(verifyRecordBytes(r.bytes, r.root, r.opId)).toMatchObject({ ok: true })
    expect(parseRecordBytes(r.bytes)).toMatchObject({ ok: true })
    expect(isSwapRecord(r.json)).toBe(true)
  })

  it('removing any one key of the record, or of its target, makes it malformed', async () => {
    const r = await realRecord()
    const cases: Array<[string, Record<string, unknown>]> = []
    for (const k of TOP_KEYS) {
      const copy = { ...r.json }
      delete copy[k]
      cases.push([`top-level ${k}`, copy])
    }
    for (const k of TARGET_KEYS) {
      const target = { ...(r.json.target as Record<string, unknown>) }
      delete target[k]
      cases.push([`target.${k}`, { ...r.json, target }])
    }
    // The table covers the three keys this step added, and the whole of each list.
    expect(cases.map(([n]) => n)).toEqual(
      expect.arrayContaining(['top-level op', 'target.scope', 'target.dirName'])
    )
    expect(cases).toHaveLength(TOP_KEYS.length + TARGET_KEYS.length)
    for (const [name, body] of cases) {
      expect(isSwapRecord(body), name).toBe(false)
      expect(verifyRecordBytes(Buffer.from(JSON.stringify(body)), r.root, r.opId), name).toEqual({
        ok: false,
        why: 'malformed',
      })
    }
    // The control: the same JSON, untouched, verifies.
    expect(verifyRecordBytes(Buffer.from(JSON.stringify(r.json)), r.root, r.opId).ok).toBe(true)
  })

  it('a key of the wrong type, or an unknown key, is malformed; a changed new field breaks the hash', async () => {
    const r = await realRecord()
    const target = r.json.target as Record<string, unknown>
    const verdict = (body: unknown) =>
      verifyRecordBytes(Buffer.from(JSON.stringify(body)), r.root, r.opId)
    expect(verdict({ ...r.json, op: 7 })).toEqual({ ok: false, why: 'malformed' })
    expect(verdict({ ...r.json, target: { ...target, scope: 5 } })).toEqual({
      ok: false,
      why: 'malformed',
    })
    expect(verdict({ ...r.json, target: { ...target, extra: 'x' } })).toEqual({
      ok: false,
      why: 'malformed',
    })
    expect(verdict({ ...r.json, extra: 'x' })).toEqual({ ok: false, why: 'malformed' })
    // Right shape, but the hash no longer matches: the new fields are inside it.
    expect(verdict({ ...r.json, op: 'install' })).toEqual({ ok: false, why: 'hash-mismatch' })
    expect(verdict({ ...r.json, target: { ...target, scope: 'workspace' } })).toEqual({
      ok: false,
      why: 'hash-mismatch',
    })
    expect(verdict({ ...r.json, target: { ...target, dirName: 'other' } })).toEqual({
      ok: false,
      why: 'hash-mismatch',
    })
    expect(verdict(r.json).ok).toBe(true)
  })

  it('the key order of the written record is fixed: op follows schema, scope and dirName end the target', async () => {
    const r = await realRecord()
    expect(Object.keys(r.json).slice(0, 3)).toEqual(['schema', 'op', 'opId'])
    expect(Object.keys(r.json.target as object)).toEqual([...TARGET_KEYS])
  })
})

describe('swapInPlace checks its input before it writes anything', () => {
  it("a stateRoot that is not the manifest's directory throws and touches nothing", async () => {
    const fx = file()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    await expect(run({ ...p, input: { ...p.input, stateRoot: fx.outside } })).rejects.toThrow(
      TypeError
    )
    await expect(run({ ...p, input: { ...p.input, stateRoot: fx.outside } })).rejects.toThrow(
      /stateRoot/
    )
    expect(fs.existsSync(fx.staging)).toBe(false)
    expect(fs.readdirSync(fx.stateRoot)).toEqual([])
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
  })

  it('a dirName that is not the name of comparedPath throws and touches nothing', async () => {
    const fx = file()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    await expect(run({ ...p, input: { ...p.input, dirName: 'other-name' } })).rejects.toThrow(
      /dirName/
    )
    expect(fs.existsSync(fx.staging)).toBe(false)
  })

  it('control: the same input, consistent, commits', async () => {
    const fx = file()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    expect((await run(p)).result.status).toBe('committed')
  })

  it('a spelling of the same state root (a trailing slash, a dot segment) is accepted', async () => {
    const fx = file()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const spelled = `${fx.stateRoot}${path.sep}.${path.sep}`
    expect((await run({ ...p, input: { ...p.input, stateRoot: spelled } })).result.status).toBe(
      'committed'
    )
  })
})

describe('the write path names `skillsmith doctor recovery` for a record naming another root (Q6)', () => {
  it('a foreign op dir is advised as the listing; an unreadable one as --park; both in one refusal', async () => {
    const fx = file()
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const crashed = await crashStopped(fx)
    const moved = opIdN('9')
    fs.mkdirSync(opDirOf(fx, moved))
    fs.copyFileSync(
      path.join(crashed.opDir, 'record.json'),
      path.join(opDirOf(fx, moved), 'record.json')
    )
    const garbage = opIdN('8')
    plantRecordText(fx, garbage, 'not a record')

    const r = await attempt(other, opIdN('c'))
    if (r.result.status !== 'refused') throw new Error(`expected a refusal, got ${r.result.status}`)
    expect(r.result.reason).toBe('recovery-record-unreadable')
    expect(r.result.detail).toContain(`skillsmith doctor recovery --park ${garbage}`)
    expect(r.result.detail).toContain(`Run \`skillsmith doctor recovery\` for ${moved}.`)
    expect(r.result.detail).not.toContain(`--park ${moved}`)
    expect(r.result.detail).not.toContain(`--park ${garbage}, ${moved}`)
  })
})

describe("readRecordFile: the scan's bounded no-follow read, shared", () => {
  it('none for a missing file; not-a-file for a directory; open-failed (ELOOP) for a link; bytes for a file', async () => {
    const dir = tmp('recovery-readrecord-')
    fs.writeFileSync(path.join(dir, 'f'), 'bytes')
    fs.mkdirSync(path.join(dir, 'd'))
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'link'))
    expect(await readRecordFile(path.join(dir, 'nope'))).toEqual({ ok: false, kind: 'none' })
    expect(await readRecordFile(path.join(dir, 'd'))).toEqual({
      ok: false,
      kind: 'unreadable',
      why: 'not-a-file',
    })
    expect(await readRecordFile(path.join(dir, 'link'))).toEqual({
      ok: false,
      kind: 'unreadable',
      why: 'open-failed',
      errno: 'ELOOP',
    })
    const ok = await readRecordFile(path.join(dir, 'f'))
    expect(ok.ok && ok.bytes.toString()).toBe('bytes')
  })

  it('reads at most MAX_RECORD_BYTES + 1 bytes, and the scan calls such a record too-large', async () => {
    const root = tmp('recovery-readrecord-')
    const st = path.join(root, '.skillsmith-staging')
    const big = path.join(st, opIdN('a'), 'record.json')
    fs.mkdirSync(path.dirname(big), { recursive: true })
    fs.writeFileSync(big, Buffer.alloc(MAX_RECORD_BYTES + 100, 0x20))
    const read = await readRecordFile(big)
    expect(read.ok && read.bytes.length).toBe(MAX_RECORD_BYTES + 1)
    const scan = await scanStagingRecords(root, st)
    expect(scan).toMatchObject({ ok: true, unreadable: [{ opId: opIdN('a'), why: 'too-large' }] })
  })
})
