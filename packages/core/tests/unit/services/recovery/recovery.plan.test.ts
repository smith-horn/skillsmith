/**
 * SMI-6531 (A1 step 6a-i): the pure plan table (plan §3.3 "Dispositions", the
 * post-keep table; §3.9 targeting).
 *
 * The property that matters most is the invariant: every tree ends installed,
 * kept or untouched, in every row of every class and for every action (UD13).
 * The table is exercised on classes built from real crashes, so a row that
 * disagrees with the classifier fails here, not in front of a user.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classLabel,
  planAction,
  plansFor,
  RECOVERY_ACTIONS,
  serializePlan,
} from '../../../../src/services/skill-recovery.plan.js'
import type {
  ActionPlan,
  RecoveryAction,
  RecoveryClass,
} from '../../../../src/services/skill-recovery.types.js'
import { computeRecordSha256 } from '../../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.js'
import { areaOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import {
  keepTree,
  opReport,
  s0,
  s1,
  s2,
  s3,
  un1,
  un2,
  writeEntry,
  writeJournalLine,
} from './recovery.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

async function classOf(
  build: () => Promise<Parameters<typeof opReport>[0]>
): Promise<RecoveryClass> {
  return (await opReport(await build())).cls
}

function offered(plan: ActionPlan) {
  if (!plan.offered) throw new Error(`not offered: ${plan.reason}: ${plan.detail}`)
  return plan
}

const dispositionOf = (plan: ActionPlan, tree: string): string | null => {
  const step = offered(plan).steps.find((s) => s.tree === tree)
  if (step === undefined) return null
  return step.disposition.kind === 'kept' ? `kept:${step.disposition.as}` : step.disposition.kind
}

describe('the invariant: installed, kept or untouched, and nothing else', () => {
  const ALLOWED = new Set(['installed', 'kept', 'untouched'])

  it('holds for every row, every post-keep row and every other class, for every action', async () => {
    const classes: Array<[string, RecoveryClass]> = []
    const add = async (name: string, build: () => Promise<Parameters<typeof opReport>[0]>) =>
      classes.push([name, await classOf(build)])
    await add('S0', () => s0(file()))
    await add('S1', () => s1(file()))
    await add('S2', () => s2(file()))
    await add('S3', () => s3(file()))
    await add('UN1', () => un1(file()))
    await add('UN2', () => un2(file()))
    await add('S2 post-keep', async () => {
      const st = await s2(file())
      keepTree(st, 'old', 'backup')
      return st
    })
    await add('S3 post-keep', async () => {
      const st = await s3(file())
      keepTree(st, 'old', 'backup')
      return st
    })
    await add('S0 post-keep', async () => {
      const st = await s0(file())
      keepTree(st, 'new', 'unused-new')
      return st
    })
    await add('UN2 post-keep', async () => {
      const st = await un2(file())
      keepTree(st, 'undone', 'undone')
      return st
    })
    await add("S2'", async () => {
      const fx = file()
      const st = await s2(fx)
      writeEntry(fx, { version: '9.9.9' })
      return st
    })
    await add('S2x', async () => {
      const fx = file()
      const st = await s2(fx)
      fs.rmSync(fx.realDir, { recursive: true })
      return st
    })
    classes.push(['empty', { kind: 'empty-op-dir', opId: 'x', opDir: '/x' }])
    classes.push([
      'moved',
      { kind: 'moved', opId: 'x', opDir: '/x', why: 'foreign-root', detail: 'd', otherUid: null },
    ])
    classes.push([
      'other-user',
      { kind: 'other-user', opId: 'x', opDir: '/x', ownerUid: 7, errno: 'EACCES' },
    ])

    expect(classes.length).toBeGreaterThanOrEqual(15)
    let steps = 0
    let offeredPlans = 0
    for (const [name, cls] of classes) {
      for (const plan of plansFor(cls)) {
        if (!plan.offered) continue
        offeredPlans++
        for (const step of plan.steps) {
          steps++
          expect(ALLOWED.has(step.disposition.kind), `${name} ${plan.action} ${step.tree}`).toBe(
            true
          )
          expect(['T', 'O', 'N', 'U']).toContain(step.tree)
        }
      }
    }
    // The property ran over real rows, not over an empty table.
    expect(offeredPlans).toBeGreaterThan(15)
    expect(steps).toBeGreaterThan(20)
  })

  it('every class answers every action: offered with steps, or refused with a reason word', async () => {
    const cls = await classOf(() => s2(file()))
    for (const action of RECOVERY_ACTIONS) {
      const plan = planAction(cls, action)
      expect(plan.action).toBe(action)
      if (!plan.offered) expect(plan.reason.startsWith('recovery-')).toBe(true)
    }
  })
})

describe('S1: N installs only if it still hashes to what was built', () => {
  it('unchanged N: --apply installs it and keeps O as backup; --undo installs O and keeps N as unused-new', async () => {
    const cls = await classOf(() => s1(file()))
    const apply = planAction(cls, 'apply')
    expect(dispositionOf(apply, 'N')).toBe('installed')
    expect(dispositionOf(apply, 'O')).toBe('kept:backup')
    expect(offered(apply).manifest).toBe('committed-to-post')
    const undo = planAction(cls, 'undo')
    expect(dispositionOf(undo, 'O')).toBe('installed')
    expect(dispositionOf(undo, 'N')).toBe('kept:unused-new')
    expect(offered(undo).manifest).toBe('untouched')
  })

  it('edited N: --apply refuses recovery-conflict; --undo keeps it as edited-new', async () => {
    const fx = file()
    const st = await s1(fx)
    fs.writeFileSync(path.join(st.opDir, 'new', 'SKILL.md'), '# edited after the crash\n')
    const cls = (await opReport(st)).cls
    expect(cls).toMatchObject({ kind: 'state', state: 'S1' })
    const apply = planAction(cls, 'apply')
    expect(apply).toMatchObject({ offered: false, reason: 'recovery-conflict' })
    expect(dispositionOf(planAction(cls, 'undo'), 'N')).toBe('kept:edited-new')
  })
})

describe('S0: a staged tree is kept by its hash, and a started keep keeps its own kind', () => {
  it('--apply and --undo are the same; unchanged N is unused-new, edited N is edited-new', async () => {
    const plain = await classOf(() => s0(file()))
    expect(dispositionOf(planAction(plain, 'apply'), 'N')).toBe('kept:unused-new')
    expect(JSON.stringify(offered(planAction(plain, 'apply')).steps)).toBe(
      JSON.stringify(offered(planAction(plain, 'undo')).steps)
    )
    const fx = file()
    const st = await s0(fx)
    fs.writeFileSync(path.join(st.opDir, 'new', 'SKILL.md'), '# edited\n')
    expect(dispositionOf(planAction((await opReport(st)).cls, 'apply'), 'N')).toBe(
      'kept:edited-new'
    )
  })

  it('an edited-new keep that started and then N reverted to the built hash stays edited-new', async () => {
    const st = await s0(file())
    keepTree(st, 'new', 'edited-new', { move: false })
    const cls = (await opReport(st)).cls
    // N hashes to postTree now, which alone would say unused-new.
    expect(cls).toMatchObject({ kind: 'state', state: 'S0' })
    expect(dispositionOf(planAction(cls, 'apply'), 'N')).toBe('kept:edited-new')
    expect(offered(planAction(cls, 'apply')).remaining.join('\n')).toContain('resume the keep of')
  })
})

/** The remedy, written out here so a change to it fails these tests (not imported). */
const REMEDY_TEXT =
  'free space on the device that holds the Skillsmith state directory (a prune command, `skillsmith doctor backups --prune`, is planned but not available yet)'

describe('S2 and its neighbours', () => {
  it('S2: --apply commits and keeps O as backup; --undo installs O and keeps T as undone', async () => {
    const cls = await classOf(() => s2(file()))
    const apply = planAction(cls, 'apply')
    expect(dispositionOf(apply, 'T')).toBe('untouched')
    expect(dispositionOf(apply, 'O')).toBe('kept:backup')
    expect(offered(apply).manifest).toBe('committed-to-post')
    expect(offered(apply).notes.join('\n')).not.toContain('live-folder-changed')
    const undo = planAction(cls, 'undo')
    expect(dispositionOf(undo, 'O')).toBe('installed')
    expect(dispositionOf(undo, 'T')).toBe('kept:undone')
  })

  it('S2 with a changed T: the commit says live-folder-changed and undo keeps T as conflict', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# a later edit\n')
    const cls = (await opReport(st)).cls
    expect(offered(planAction(cls, 'apply')).notes.join('\n')).toContain('live-folder-changed')
    expect(dispositionOf(planAction(cls, 'undo'), 'T')).toBe('kept:conflict')
  })

  it('a full-device marker adds a note with the facts and the free-space clause only', async () => {
    const fx = file()
    const st = await s2(fx)
    const recPath = path.join(st.opDir, 'record.json')
    const { recordSha256: _h, ...body } = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
    const marked = {
      ...body,
      fullDevice: {
        cause: 'ENOSPC',
        stage: 'copy',
        area: areaOf(fx),
        opId: st.opId,
        dest: path.join(areaOf(fx), st.opId),
      },
    } as Omit<SwapRecord, 'recordSha256'>
    fs.writeFileSync(
      recPath,
      JSON.stringify({ ...marked, recordSha256: computeRecordSha256(marked) })
    )
    const cls = (await opReport(st)).cls
    expect(cls.kind === 'state' && cls.facts.fullDevice).toMatchObject({ cause: 'ENOSPC' })
    const note = offered(planAction(cls, 'apply')).notes.find((n) =>
      n.includes('stopped on a full device')
    )
    expect(note).toBe(
      'an earlier copy stopped on a full device (ENOSPC at copy); if the copy still cannot fit, ' +
        `this stops with state-root-full: ${REMEDY_TEXT}`
    )
    expect(note).toContain('free space on the device that holds the Skillsmith state directory')
    expect(note).toContain('not available yet')
    // The note is also shown in the read-only listing, where "this command" is ambiguous.
    expect(note).not.toContain('run this command again')
    expect(note).not.toContain('--apply')
    expect(note).not.toContain('run `skillsmith doctor backups --prune`')
    expect(note).not.toContain('finish the update')
  })

  it("S2′: --apply refuses recovery-conflict, --undo is S2's", async () => {
    const fx = file()
    const st = await s2(fx)
    writeEntry(fx, { version: '9.9.9' })
    const cls = (await opReport(st)).cls
    expect(planAction(cls, 'apply')).toMatchObject({ offered: false, reason: 'recovery-conflict' })
    expect(dispositionOf(planAction(cls, 'undo'), 'O')).toBe('installed')
  })

  it('S2x: --apply refuses; --undo keeps a present foreign T as conflict, or has no T step when T is gone', async () => {
    const gone = file()
    const a = await s2(gone)
    fs.rmSync(gone.realDir, { recursive: true })
    const goneCls = (await opReport(a)).cls
    expect(planAction(goneCls, 'apply')).toMatchObject({
      offered: false,
      reason: 'recovery-conflict',
    })
    expect(dispositionOf(planAction(goneCls, 'undo'), 'O')).toBe('installed')
    expect(dispositionOf(planAction(goneCls, 'undo'), 'T')).toBeNull()

    const foreign = file()
    const b = await s2(foreign)
    fs.rmSync(foreign.realDir, { recursive: true })
    fs.mkdirSync(foreign.realDir)
    fs.writeFileSync(path.join(foreign.realDir, 'SKILL.md'), '# someone else\n')
    expect(dispositionOf(planAction((await opReport(b)).cls, 'undo'), 'T')).toBe('kept:conflict')
  })

  it('S3: --undo is not offered (restore by hand); --apply notes whether an audit record exists', async () => {
    const fx = file()
    const st = await s3(fx)
    const cls = (await opReport(st)).cls
    const undo = planAction(cls, 'undo')
    expect(undo).toMatchObject({ offered: false, reason: 'recovery-not-offered' })
    expect(undo.offered ? '' : undo.detail).toContain('by hand')
    expect(offered(planAction(cls, 'apply')).remaining.join('\n')).toContain(
      'append the audit record'
    )
    writeJournalLine(fx, st.opId)
    const cls2 = (await opReport(st)).cls
    expect(offered(planAction(cls2, 'apply')).remaining.join('\n')).toContain(
      'already in the journal'
    )
  })

  it('UN1 and UN2: --apply and --undo finish the undo; a changed U is kept as conflict', async () => {
    const plain = await classOf(() => un1(file()))
    expect(dispositionOf(planAction(plain, 'apply'), 'O')).toBe('installed')
    expect(dispositionOf(planAction(plain, 'apply'), 'U')).toBe('kept:undone')
    expect(dispositionOf(planAction(plain, 'undo'), 'U')).toBe('kept:undone')
    const fx = file()
    const st = await un2(fx)
    fs.writeFileSync(path.join(st.opDir, 'undone', 'SKILL.md'), '# edited after the restore\n')
    const cls = (await opReport(st)).cls
    expect(dispositionOf(planAction(cls, 'apply'), 'U')).toBe('kept:conflict')
    expect(dispositionOf(planAction(cls, 'apply'), 'T')).toBe('untouched')
  })
})

describe('the post-keep rows resume only what is left', () => {
  it('S2 after its keep: commit, audit, finish, with no second keep; --undo is not offered', async () => {
    const st = await s2(file())
    keepTree(st, 'old', 'backup')
    const cls = (await opReport(st)).cls
    const remaining = offered(planAction(cls, 'apply')).remaining.join('\n')
    expect(remaining).toContain('commit the manifest')
    expect(remaining).not.toContain('keep the old folder as backup')
    expect(planAction(cls, 'undo')).toMatchObject({
      offered: false,
      reason: 'recovery-not-offered',
    })
  })

  it('S2′ after its keep: --apply refuses recovery-conflict, --undo is not offered (the old folder is in the backup area)', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup')
    writeEntry(fx, { version: '9.9.9' })
    const cls = (await opReport(st)).cls
    expect(planAction(cls, 'apply')).toMatchObject({ offered: false, reason: 'recovery-conflict' })
    const undo = planAction(cls, 'undo')
    expect(undo).toMatchObject({ offered: false, reason: 'recovery-not-offered' })
  })

  it('S3, S0 and UN2 after their keeps: finish only', async () => {
    const a = await s3(file())
    keepTree(a, 'old', 'backup')
    const aRemaining = offered(planAction((await opReport(a)).cls, 'apply')).remaining.join('\n')
    expect(aRemaining).not.toContain('keep the old folder as backup')

    const b = await s0(file())
    keepTree(b, 'new', 'unused-new')
    const bRemaining = offered(planAction((await opReport(b)).cls, 'undo')).remaining
    expect(bRemaining).toHaveLength(1)
    expect(bRemaining[0]).toContain('unlink the metadata files')

    const c = await un2(file())
    keepTree(c, 'undone', 'undone')
    const cRemaining = offered(planAction((await opReport(c)).cls, 'apply')).remaining
    expect(cRemaining).toHaveLength(1)
  })
})

describe('what every other class says', () => {
  it("another user's record: --apply and --undo refuse recovery-other-user, before any lock", async () => {
    const st = await s2(file())
    const mine = (await opReport(st)).cls
    expect(planAction(mine, 'apply').offered).toBe(true)
    const theirs = (await opReport(st, { euid: (process.geteuid?.() ?? 0) + 1 })).cls
    for (const action of ['apply', 'undo'] as RecoveryAction[]) {
      const plan = planAction(theirs, action)
      expect(plan).toMatchObject({ offered: false, reason: 'recovery-other-user' })
      expect(plan.offered ? '' : plan.detail).toContain(String(process.geteuid?.()))
    }
  })

  it('moved: only --abandon; identity-changed: --abandon, and --accept-identity names the way out', async () => {
    const moved: RecoveryClass = {
      kind: 'moved',
      opId: 'x',
      opDir: '/x',
      why: 'foreign-root',
      detail: '',
      otherUid: null,
    }
    expect(planAction(moved, 'apply')).toMatchObject({ offered: false, reason: 'recovery-moved' })
    expect(planAction(moved, 'abandon').offered).toBe(true)
    const st = await s2(file())
    const copy = path.join(st.opDir, 'old')
    fs.cpSync(copy, `${copy}.c`, { recursive: true })
    fs.rmSync(copy, { recursive: true })
    fs.renameSync(`${copy}.c`, copy)
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('identity-changed')
    const apply = planAction(cls, 'apply')
    expect(apply).toMatchObject({ offered: false, reason: 'recovery-identity-changed' })
    expect(apply.offered ? '' : apply.detail).toContain('--accept-identity')
    expect(planAction(cls, 'abandon').offered).toBe(true)
  })

  it('unreadable: --park only; no record: --clean-staging only; empty: nothing; AB: --abandon finishes it', async () => {
    const unreadable: RecoveryClass = {
      kind: 'unreadable',
      opId: 'x',
      opDir: '/x',
      why: 'not-json',
    }
    expect(planAction(unreadable, 'park').offered).toBe(true)
    expect(planAction(unreadable, 'apply')).toMatchObject({
      offered: false,
      reason: 'recovery-record-unreadable',
    })
    const noRecord: RecoveryClass = {
      kind: 'no-record',
      opId: 'x',
      opDir: '/x',
      owner: null,
      entries: ['new'],
      hasParkIntent: false,
      recordTmp: null,
      otherUid: null,
      intent: null,
    }
    expect(planAction(noRecord, 'clean-staging').offered).toBe(true)
    expect(planAction(noRecord, 'apply').offered).toBe(false)
    const empty: RecoveryClass = { kind: 'empty-op-dir', opId: 'x', opDir: '/x' }
    expect(RECOVERY_ACTIONS.every((a) => !planAction(empty, a).offered)).toBe(true)
    const st = await s2(file())
    keepTree(st, 'old', 'abandoned-old', { move: false })
    const ab = (await opReport(st)).cls
    expect(planAction(ab, 'abandon').offered).toBe(true)
    expect(planAction(ab, 'apply')).toMatchObject({
      offered: false,
      reason: 'recovery-not-offered',
    })
  })

  it('a row refuses --abandon, --clean-staging and --park and names --apply or --undo', async () => {
    const cls = await classOf(() => s2(file()))
    for (const action of ['abandon', 'clean-staging', 'park'] as RecoveryAction[]) {
      const plan = planAction(cls, action)
      expect(plan).toMatchObject({ offered: false, reason: 'recovery-not-offered' })
      expect(plan.offered ? '' : plan.detail).toContain('--apply')
    }
  })
})

describe('the serialized plan is what the digest covers', () => {
  it('is the same for the same class and changes when a disposition changes', async () => {
    const fx = file()
    const st = await s2(fx)
    const a = (await opReport(st)).cls
    expect(serializePlan(a)).toBe(serializePlan((await opReport(st)).cls))
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# a later edit\n')
    const b = (await opReport(st)).cls
    expect(serializePlan(b)).not.toBe(serializePlan(a))
    expect(classLabel(a)).toBe(classLabel(b))
  })
})
