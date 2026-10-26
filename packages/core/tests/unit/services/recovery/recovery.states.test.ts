/**
 * SMI-6531 (A1 step 6a-i): the classifier's rows (plan §3.3 state table and
 * the post-keep table), T-J5 (identity), T-L15 (a moved or copied root) and
 * T-J9/T-J10's state halves.
 *
 * Every state is a real `swapInPlace` crash or the transaction's own moves
 * (see `recovery.helpers.ts`). Each negative sits beside the positive that
 * proves the classifier could have said otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecoveryClass, RowState } from '../../../../src/services/skill-recovery.types.js'
import { makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { opDirOf, opIdN } from '../skill-swap.scan.helpers.js'
import {
  copyTree,
  keepTree,
  opReport,
  report,
  s0,
  s1,
  s2,
  s3,
  un1,
  un2,
  writeEntry,
} from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

function stateOf(cls: RecoveryClass): { state: RowState; postKeep: boolean } {
  if (cls.kind !== 'state')
    throw new Error(`expected a row, got ${cls.kind}: ${JSON.stringify(cls).slice(0, 400)}`)
  return { state: cls.state, postKeep: cls.postKeep }
}

describe('the rows of the state table', () => {
  const builders: Array<[string, RowState, (fx: ReturnType<typeof file>) => Promise<State>]> = [
    ['S0', 'S0', (fx) => s0(fx)],
    ['S1', 'S1', (fx) => s1(fx)],
    ['S2', 'S2', (fx) => s2(fx)],
    ['S3', 'S3', (fx) => s3(fx)],
    ['UN1', 'UN1', (fx) => un1(fx)],
    ['UN2', 'UN2', (fx) => un2(fx)],
  ]
  for (const [name, want, build] of builders) {
    it(`${name}: a real crash classifies as ${want}, with roles resolved from their sources`, async () => {
      const fx = file()
      const st = await build(fx)
      const op = await opReport(st)
      expect(stateOf(op.cls)).toEqual({ state: want, postKeep: false })
      expect(op.label).toContain(want)
    })
  }

  it('the roles each row resolves are the trees it has: S1 has O and N in OP, S2 has O only', async () => {
    const fx = file()
    const one = await s1(fx)
    const c1 = (await opReport(one)).cls
    if (c1.kind !== 'state') throw new Error('S1 expected')
    expect(c1.facts.roles.O.kind).toBe('source')
    expect(c1.facts.roles.N.kind).toBe('source')
    expect(c1.facts.roles.U.kind).toBe('absent')
    expect(c1.facts.tState).toBe('absent')
    expect(c1.facts.manifest).toBe('pre')

    const fx2 = file()
    const two = await s2(fx2)
    const c2 = (await opReport(two)).cls
    if (c2.kind !== 'state') throw new Error('S2 expected')
    expect(c2.facts.roles.O.kind).toBe('source')
    expect(c2.facts.roles.N.kind).toBe('absent')
    expect(c2.facts.tState).toBe('new')
  })

  it("S2': the manifest entry neither planned nor updated", async () => {
    const fx = file()
    const st = await s2(fx)
    expect(stateOf((await opReport(st)).cls).state).toBe('S2')
    writeEntry(fx, { version: '9.9.9' })
    expect(stateOf((await opReport(st)).cls).state).toBe('S2prime')
  })

  it('S2x: the live folder removed, or replaced by a directory with neither identity nor hash', async () => {
    const removed = file()
    const a = await s2(removed)
    fs.rmSync(removed.realDir, { recursive: true })
    expect(stateOf((await opReport(a)).cls)).toEqual({ state: 'S2x', postKeep: false })

    const replaced = file()
    const b = await s2(replaced)
    fs.rmSync(replaced.realDir, { recursive: true })
    fs.mkdirSync(replaced.realDir)
    fs.writeFileSync(path.join(replaced.realDir, 'SKILL.md'), '# someone else wrote this\n')
    const op = await opReport(b)
    expect(stateOf(op.cls).state).toBe('S2x')
    if (op.cls.kind === 'state') expect(op.cls.facts.tState).toBe('foreign')
  })

  it('an empty directory claimed at T is a claim: UN1 and S1 still classify with it', async () => {
    const fx = file()
    const st = await s1(fx)
    fs.mkdirSync(fx.realDir)
    const op = await opReport(st)
    expect(stateOf(op.cls).state).toBe('S1')
    if (op.cls.kind === 'state') expect(op.cls.facts.tState).toBe('claim')
  })

  it('a manifest that cannot be read is anything else, not a row', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(fx.stateRoot, 'manifest.json'), '{ not json')
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
    if (op.cls.kind === 'anything-else') expect(op.cls.reason).toContain('manifest')
    // The same state with a readable manifest is a row.
    const ok = file()
    expect(stateOf((await opReport(await s2(ok))).cls).state).toBe('S2')
  })

  it('a stray new/ beside a swapped T matches no row', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.mkdirSync(path.join(st.opDir, 'new'))
    fs.writeFileSync(path.join(st.opDir, 'new', 'x'), 'x')
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
  })
})

describe('the post-keep rows resume only what is left', () => {
  it('S2 after its keep: O is kept as backup, manifest pre', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup')
    const op = await opReport(st)
    expect(stateOf(op.cls)).toEqual({ state: 'S2', postKeep: true })
    if (op.cls.kind === 'state') expect(op.cls.facts.roles.O.kind).toBe('kept')
  })

  it('S3 after its keep, and S2′ after its keep', async () => {
    const fx = file()
    const st = await s3(fx)
    keepTree(st, 'old', 'backup')
    expect(stateOf((await opReport(st)).cls)).toEqual({ state: 'S3', postKeep: true })

    const fx2 = file()
    const prime = await s2(fx2)
    keepTree(prime, 'old', 'backup')
    writeEntry(fx2, { version: '9.9.9' })
    expect(stateOf((await opReport(prime)).cls)).toEqual({ state: 'S2prime', postKeep: true })
  })

  it('S0 or S1 --undo after the keep: N kept, T old, manifest pre', async () => {
    const fx = file()
    const st = await s0(fx)
    keepTree(st, 'new', 'unused-new')
    const op = await opReport(st)
    expect(stateOf(op.cls)).toEqual({ state: 'S0', postKeep: true })
    if (op.cls.kind === 'state') expect(op.cls.facts.roles.N.kind).toBe('kept')
  })

  it('UN2 after its keep: U kept, T old', async () => {
    const fx = file()
    const st = await un2(fx)
    keepTree(st, 'undone', 'undone')
    expect(stateOf((await opReport(st)).cls)).toEqual({ state: 'UN2', postKeep: true })
  })

  it('control: the same states with the keep not made are the plain rows', async () => {
    const fx = file()
    expect(stateOf((await opReport(await un2(fx))).cls)).toEqual({ state: 'UN2', postKeep: false })
  })
})

describe('T-J5: identity is part of what makes a tree its role', () => {
  it("(a) T replaced by a copy with the new tree's content is identity-changed, not S2", async () => {
    const fx = file()
    const st = await s2(fx)
    expect(stateOf((await opReport(st)).cls).state).toBe('S2')
    const tmpCopy = `${fx.realDir}.copy`
    copyTree(fx.realDir, tmpCopy)
    fs.rmSync(fx.realDir, { recursive: true })
    fs.renameSync(tmpCopy, fx.realDir)
    const op = await opReport(st)
    expect(op.cls.kind).toBe('identity-changed')
    if (op.cls.kind === 'identity-changed') expect(op.cls.positions).toEqual(['T'])
  })

  it('(b) O replaced by a copy of the old content is identity-changed, not S2', async () => {
    const fx = file()
    const st = await s2(fx)
    const old = path.join(st.opDir, 'old')
    copyTree(old, `${old}.copy`)
    fs.rmSync(old, { recursive: true })
    fs.renameSync(`${old}.copy`, old)
    const op = await opReport(st)
    expect(op.cls.kind).toBe('identity-changed')
    if (op.cls.kind === 'identity-changed') expect(op.cls.positions).toEqual(['O'])
  })

  it('a stat that matches dev, ino and birthtime but not the file type is not the role', async () => {
    const fx = file()
    const st = await s2(fx)
    expect(stateOf((await opReport(st)).cls).state).toBe('S2')
    const op = await opReport(st, {
      reader: {
        statOverride: (p, real) =>
          p === fx.realDir && real.ok
            ? { ...real, identity: { ...real.identity, fmt: '40960' } }
            : real,
      },
    })
    expect(op.cls.kind).toBe('identity-changed')
  })

  it('with --accept-identity the same copies classify by hash (S2)', async () => {
    const fx = file()
    const st = await s2(fx)
    const tmpCopy = `${fx.realDir}.copy`
    copyTree(fx.realDir, tmpCopy)
    fs.rmSync(fx.realDir, { recursive: true })
    fs.renameSync(tmpCopy, fx.realDir)
    expect((await opReport(st)).cls.kind).toBe('identity-changed')
    expect(stateOf((await opReport(st, { acceptIdentity: true })).cls).state).toBe('S2')
  })

  it('a copy with other content has neither identity nor hash: foreign, not identity-changed', async () => {
    const fx = file()
    const st = await s1(fx)
    // O is a directory with neither the old identity nor the old hash.
    const old = path.join(st.opDir, 'old')
    fs.rmSync(old, { recursive: true })
    fs.mkdirSync(old)
    fs.writeFileSync(path.join(old, 'SKILL.md'), '# a different folder\n')
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
  })
})

describe('T-L15: a moved or copied root is recovery-moved, whichever of path and identity changed', () => {
  it('a copy at the original path: same path, another identity', async () => {
    const fx = file()
    const st = await s2(fx)
    expect(stateOf((await opReport(st)).cls).state).toBe('S2')
    const orig = `${fx.skillsDir}.orig`
    fs.renameSync(fx.skillsDir, orig)
    fs.cpSync(orig, fx.skillsDir, { recursive: true })
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'moved', why: 'root-identity' })
  })

  it('the root moved: the same identity at another path', async () => {
    const fx = file()
    const st = await s2(fx)
    const moved = `${fx.skillsDir}.moved`
    fs.renameSync(fx.skillsDir, moved)
    const root = await report(st, {})
    expect(root.staging).toBe('unsafe') // the recorded path no longer resolves
    const now = await report({ fx: { ...fx, skillsDir: moved } })
    expect(now.ops).toHaveLength(1)
    expect(now.ops[0]!.cls).toMatchObject({ kind: 'moved', why: 'foreign-root' })
  })

  it('a record copied into another op dir names another op: foreign-op-dir, beside the original row', async () => {
    const fx = file()
    const st = await s2(fx)
    const other = opIdN('9')
    fs.mkdirSync(opDirOf(fx, other))
    fs.copyFileSync(
      path.join(st.opDir, 'record.json'),
      path.join(opDirOf(fx, other), 'record.json')
    )
    const root = await report(st)
    const byId = new Map(root.ops.map((o) => [o.opId, o.cls]))
    expect(byId.get(OP_ID)?.kind).toBe('state')
    expect(byId.get(other)).toMatchObject({ kind: 'moved', why: 'foreign-op-dir' })
  })

  it('the op dir replaced by a copy: the same root, another op dir identity', async () => {
    const fx = file()
    const st = await s2(fx)
    const copy = `${st.opDir}.copy`
    copyTree(st.opDir, copy)
    fs.rmSync(st.opDir, { recursive: true })
    fs.renameSync(copy, st.opDir)
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'moved', why: 'op-dir-identity' })
  })
})
