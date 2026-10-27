/**
 * SMI-6531 (A1 step 7b): `UpdateResult.next` (the requirement carried from the
 * #3192 retro). A commit whose backup publish stopped on a full state root
 * carries `next: skillsmith doctor recovery --apply <opId>`; no other result
 * carries `next`.
 *
 * End to end, the state root is on another device (`/dev/shm`), so the backup
 * is a verified copy, and the space check's `statfs` of the backup area is
 * stubbed to report too little room: the run commits and stops at the publish
 * with `state-root-full`. The control runs the same fixture without the stub.
 * The mapper is then checked over every other result shape.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapResult } from '../../../src/services/skill-swap.js'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import { toUpdateResult, updateInPlace } from '../../../src/services/skill-update.js'
import type { UpdateResult } from '../../../src/services/skill-update.types.js'
import { otherDevice, useOtherDeviceCleanup, useStubs } from './skill-swap.xdev.helpers.js'
import {
  areaRel,
  OP_ID,
  recorded,
  SKILL_ID,
  skillMd,
  updateFixture,
  useTmpCleanup,
  useUpstream,
  useUpstreamCleanup,
} from './skill-update.helpers.js'
import type { UpdateFixture } from './skill-update.helpers.js'

useTmpCleanup()
useUpstreamCleanup()
useOtherDeviceCleanup()
const stub = useStubs()

const NEXT = `skillsmith doctor recovery --apply ${OP_ID}`

async function runUpdate(fx: UpdateFixture): Promise<UpdateResult> {
  const t = await buildUpdateTarget({
    skillsDir: fx.skillsDir,
    client: fx.client,
    scope: 'global',
    manifestPath: fx.manifestPath,
    comparedPath: fx.comparedPath,
  })
  if (!t.ok) throw new Error(t.detail)
  const plan = await planSkillUpdate({ target: t.target, skillId: SKILL_ID })
  if (!plan.ok) throw new Error(plan.detail)
  return updateInPlace(plan, { swap: recorded().swap })
}

/** `statfs` of the backup area reports 16 free blocks; counts the calls that hit it. */
function tooLittleRoom(fx: UpdateFixture): { asked: number } {
  const area = path.join(fs.realpathSync.native(fx.stateRoot), areaRel(fx))
  const hit = { asked: 0 }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    if (a[0] !== area) return s
    hit.asked++
    return { ...s, bsize: 4096n, bavail: 16n, bfree: 1n << 40n }
  })
  return hit
}

describe('next: a commit stopped on a full state root', () => {
  it('carries the exact doctor command; the control run on the same fixture carries none', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')

    const full = updateFixture({ 'SKILL.md': skillMd('v1') }, { stateRoot: otherDevice() })
    const hit = tooLittleRoom(full)
    const r = await runUpdate(full)
    expect(hit.asked).toBe(1)
    expect(r).toMatchObject({
      status: 'committed',
      opId: OP_ID,
      incomplete: { step: 'publish', reason: 'state-root-full' },
    })
    expect(r.next).toBe(NEXT)
    expect(fs.readFileSync(path.join(full.realDir, 'SKILL.md'), 'utf8')).toBe(skillMd('v2'))

    const roomy = updateFixture({ 'SKILL.md': skillMd('v1') }, { stateRoot: otherDevice() })
    const ok = await runUpdate(roomy)
    expect(ok.status).toBe('committed')
    expect(ok).not.toHaveProperty('incomplete')
    expect(ok).not.toHaveProperty('next')
  })
})

describe('toUpdateResult: no other result carries next', () => {
  const committed = {
    status: 'committed' as const,
    opId: OP_ID,
    backupDest: '/b',
    warnings: [],
  }
  const others: SwapResult[] = [
    committed,
    { ...committed, incomplete: { step: 'audit', reason: 'journal-append-failed', detail: 'd' } },
    { ...committed, incomplete: { step: 'publish', reason: 'write-failed', detail: 'd' } },
    { ...committed, incomplete: { step: 'cleanup', reason: 'op-not-empty', detail: 'd' } },
    {
      status: 'stopped',
      opId: OP_ID,
      reason: 'state-root-full',
      detail: 'd',
      warnings: [],
    },
    {
      status: 'refused',
      reason: 'changed-since-plan',
      staged: 'parked',
      opDir: null,
      cleanStagingHint: null,
      detail: 'd',
      warnings: [],
    },
    {
      status: 'undone',
      opId: OP_ID,
      reason: 'changed-since-plan',
      keptAs: 'undone',
      keptPath: '/k',
      warnings: [],
    },
  ]

  it('leaves every other result unchanged, and adds next only to the state-root-full commit', () => {
    for (const r of others) {
      const mapped = toUpdateResult(r)
      expect(mapped).not.toHaveProperty('next')
      expect(mapped).toEqual(r)
    }
    const fullStop = toUpdateResult({
      ...committed,
      incomplete: { step: 'publish', reason: 'state-root-full', detail: 'd' },
    })
    expect(fullStop.next).toBe(NEXT)
  })
})
