/**
 * SMI-6531 (A1 step 5) / SMI-6532: the dry run and the write agree.
 *
 * The probe (`probeUpdateTarget`, A2) and the transaction's step 3
 * (`swapInPlace`) read the same record scan, so a dry run says
 * `recovery-pending` for exactly the skills the write would refuse, and the
 * unreadable-record rule (row 0b) matches the write's whole-root refusal.
 * Both halves run on one real crash-kept record, written by the real writer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeUpdateTarget } from '../../../src/services/update-target.probe.js'
import { stagingRecordsUnreadable } from '../../../src/services/update-target.probe.recovery.js'
import {
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const SECOND_OP = 'e'.repeat(32)

/** A second skill folder in the fixture's skills root, as a fixture of its own. */
function secondSkill(fx: Fixture): Fixture {
  const dirName = 'other-skill'
  const realDir = path.join(fx.skillsDir, dirName)
  fs.mkdirSync(realDir)
  fs.writeFileSync(path.join(realDir, 'SKILL.md'), '# other v1\n')
  return { ...fx, dirName, realDir, opDir: path.join(fx.staging, SECOND_OP) }
}

/** The first skill's update stops after rename 1 with its record kept (a crash). */
async function crashFirst(fx: Fixture): Promise<string> {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  p.manifest.preCommitError = new Error('manifest lock lost')
  const { result } = await run(p)
  expect(result).toMatchObject({ status: 'stopped', opId: OP_ID })
  const recordPath = path.join(fx.opDir, 'record.json')
  expect(fs.existsSync(recordPath)).toBe(true)
  return recordPath
}

describe('the dry run and the write agree', () => {
  it('a crash-kept record: the probe says recovery-pending and the write refuses it, for that skill only', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = secondSkill(fx)
    const recordPath = await crashFirst(fx)

    // The crashed skill: the dry run and the write both stop, naming the record.
    const probed = await probeUpdateTarget({
      dir: fx.realDir,
      skillsDir: fx.skillsDir,
      dirName: fx.dirName,
      writeSet: [],
    })
    const recordBefore = fs.readFileSync(recordPath, 'utf8')
    const crashedBefore = hashOf(fx.realDir)
    const again = await run(plan(fx, [modify('SKILL.md', '# v3\n')]), { opId: SECOND_OP })
    expect(probed).toEqual({ kind: 'recovery-pending' })
    expect(again.result).toMatchObject({
      status: 'refused',
      reason: 'recovery-pending',
      blockedBy: [OP_ID],
    })
    // The refusal changed nothing of the crash: record, folder and old copy as it left them.
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(recordBefore)
    expect(hashOf(fx.realDir)).toBe(crashedBefore)

    // The other skill in the same root: the dry run lets it through and the write commits.
    const otherProbed = await probeUpdateTarget({
      dir: other.realDir,
      skillsDir: other.skillsDir,
      dirName: other.dirName,
      writeSet: [],
    })
    const otherRun = await run(plan(other, [modify('SKILL.md', '# other v2\n')]), {
      opId: SECOND_OP,
    })
    expect(otherProbed.kind).not.toBe('recovery-pending')
    expect(otherProbed.kind).toBe('ok')
    expect(otherRun.result).toMatchObject({ status: 'committed', opId: SECOND_OP })
    expect(fs.readFileSync(path.join(other.realDir, 'SKILL.md'), 'utf8')).toBe('# other v2\n')
    // And the crash is still exactly as it was.
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(recordBefore)
  })

  it('a corrupted record blocks the whole root: row 0b is true and the write refuses recovery-record-unreadable', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = secondSkill(fx)
    const recordPath = await crashFirst(fx)
    // Control: with the record intact nothing in the root is unreadable.
    expect(await stagingRecordsUnreadable(fx.skillsDir)).toBe(false)

    fs.writeFileSync(recordPath, '{ corrupted by a bad disk')

    const otherBefore = hashOf(other.realDir)
    const refused = await run(plan(other, [modify('SKILL.md', '# other v2\n')]), {
      opId: SECOND_OP,
    })
    expect(await stagingRecordsUnreadable(fx.skillsDir)).toBe(true)
    expect(refused.result).toMatchObject({
      status: 'refused',
      reason: 'recovery-record-unreadable',
      blockedBy: [OP_ID],
    })
    expect(hashOf(other.realDir)).toBe(otherBefore)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('{ corrupted by a bad disk')
  })
})
