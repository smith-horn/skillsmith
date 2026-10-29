/**
 * SMI-6531 (A1 step 6b-iii): the T-J11 cases a claims-versus-code check found
 * missing.
 *
 *  1. R2 with an empty sidecar temp is refused. Classification cannot produce
 *     it (R2 needs the temp to parse as this op's sidecar, so an empty file is
 *     P0 there), so the plan's own guard is pinned on a real R2 whose temp is
 *     marked empty, and the reachable case (an empty temp with no sidecar is
 *     P0, unlinked and kept fresh) is pinned beside it.
 *  2. `--abandon` stops `plan-changed` with zero mutation when O changes
 *     between confirmation and lock 1.
 *  3. A completed `--abandon`, on one device and across devices, leaves the
 *     skill folder, the manifest, the journal, an unrelated op dir and an
 *     unrelated backup exactly as they were.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { abandonOf } from '../../../../src/services/skill-recovery.plan.abandon.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { areaOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { opIdN } from '../skill-swap.scan.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { contentSnapshot, done, requestOf } from './recovery.act.helpers.js'
import {
  destOf,
  journalOf,
  opReport,
  s2,
  sidecarFor,
  writeJournalLine,
} from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { world } from './recovery.abandon.helpers.js'
import { xfile } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** S2 with a foreign tree at `OP/undone`: anything else, with O and U to keep. */
async function twoSources(fx: Fixture = file()): Promise<State> {
  const st = await s2(fx)
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  expect((await opReport(st)).cls.kind).toBe('anything-else')
  return st
}

describe('1. R2 with an empty sidecar temp is refused (it links the temp and needs its bytes)', () => {
  it('a real R2 of N, its temp marked an empty single-link file: refused naming it; unmarked, offered', async () => {
    const st = await twoSources()
    const tmp = `${destOf(st, 'abandoned-new')}.json.tmp`
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    // N back in OP, with a provable temp (this op's sidecar for it) and no sidecar: R2.
    fs.mkdirSync(path.join(st.opDir, 'new'))
    fs.writeFileSync(path.join(st.opDir, 'new', 'SKILL.md'), '# staged\n')
    const body = sidecarFor(st, path.join(st.opDir, 'new'), 'abandoned-new')
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
    const cls = (await opReport(st)).cls
    if (cls.kind !== 'ab') throw new Error(`expected ab, got ${cls.kind}`)
    const n = cls.facts.roles.N
    if (n.kind !== 'source' || n.started === null) throw new Error('N is not a started source')
    expect(n.started.state).toBe('R2')
    // The presence half: as classified (a provable, non-empty temp), --abandon is offered.
    expect(abandonOf(cls.opId, cls.facts).offered).toBe(true)
    // The guard: the same R2 with an empty temp (shared by the group and the role) is refused.
    const facts = structuredClone(cls.facts)
    const started = facts.roles.N.kind === 'source' ? facts.roles.N.started : null
    started!.sidecarTmp!.emptySingleLink = true
    const plan = abandonOf(cls.opId, facts)
    expect(plan).toMatchObject({ offered: false, reason: 'recovery-not-offered' })
    expect(plan.offered ? '' : plan.detail).toBe(
      `${tmp} is not provably this operation's sidecar temp, so it is not unlinked; ` +
        'move it out of the op dir by hand, and run the command again'
    )
  })

  it('reachable: an empty single-link temp with no sidecar is P0, offered, unlinked, and the keep made fresh', async () => {
    const st = await twoSources()
    const tmp = `${destOf(st, 'abandoned-old')}.json.tmp`
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, '')
    const cls = (await opReport(st)).cls
    const groups = 'facts' in cls && cls.facts !== null ? cls.facts.groups : []
    expect(groups.find((g) => g.base === `${OP_ID}.abandoned-old`)?.state).toBe('P0')
    const a = await done(st, 'abandon')
    expect(a.trace).toContainEqual({ op: 'unlink', path: tmp })
    expect(a.result.kept.find((k) => k.tree === 'O')?.path).toBe(destOf(st, 'abandoned-old'))
  })
})

describe('2. plan-changed for --abandon: O edited between confirmation and lock 1', () => {
  it('stops plan-changed, the world exactly as it was after the edit', async () => {
    const st = await twoSources()
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# edited after the prompt\n')
    const before = world(st)
    const result = await executeRecovery(planned)
    expect(world(st)).toBe(before)
    expect(result).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

/** A file's type, mode, inode, size, mtime and bytes; a directory's whole content snapshot. */
function snap(p: string): string {
  const s = fs.lstatSync(p, { bigint: true })
  if (s.isDirectory()) return contentSnapshot(p)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  return `${p} ${s.mode} ${s.ino} ${s.size} ${s.mtimeNs} ${sha}`
}

describe('3. scope: a finished --abandon touches nothing but its own op dir and its own keeps', () => {
  for (const [name, fixture] of [
    ['one device', file],
    ['across devices', xfile],
  ] as const) {
    it(`${name}: T, the manifest, the journal, an unrelated op dir and an unrelated backup are unchanged`, async () => {
      const st = await twoSources(fixture())
      // An unrelated op dir in the same staging dir, and an unrelated backup in the area.
      const other = path.join(st.fx.staging, opIdN('c'))
      fs.mkdirSync(path.join(other, 'new'), { recursive: true })
      fs.writeFileSync(path.join(other, 'new', 'SKILL.md'), '# another update\n')
      fs.writeFileSync(path.join(other, 'owner.json'), '{}')
      const area = areaOf(st.fx)
      const otherBackup = path.join(area, opIdN('d'))
      fs.mkdirSync(otherBackup, { recursive: true })
      fs.writeFileSync(path.join(otherBackup, 'SKILL.md'), '# an older backup\n')
      fs.writeFileSync(`${otherBackup}.json`, '{"opId":"other"}\n')
      writeJournalLine(st.fx, opIdN('c'))
      const watched = [
        st.fx.realDir,
        path.join(st.fx.stateRoot, 'manifest.json'),
        journalOf(st.fx),
        other,
        otherBackup,
        `${otherBackup}.json`,
      ]
      const before = watched.map(snap)
      const a = await done(st, 'abandon')
      expect(watched.map(snap)).toEqual(before)
      // The presence half: this op's own trees are kept and its op dir is gone.
      expect(a.result.kept.map((k) => `${k.tree}:${k.kind}`)).toEqual([
        'O:abandoned-old',
        'U:abandoned-undone',
      ])
      for (const k of a.result.kept) expect(fs.existsSync(k.path)).toBe(true)
      expect(fs.existsSync(st.opDir)).toBe(false)
    })
  }
})
