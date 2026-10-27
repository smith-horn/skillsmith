/**
 * SMI-6531 (A1 step 7b): `SkillInstallationService.updateInPlace`, the
 * delegate to `updateInPlace`. The progress callback defaults to the service's
 * and an explicit one overrides it; every other option (`swap`, `wrapPort`)
 * reaches `updateInPlace` unchanged. The plan is authoritative: the service is
 * built with a different skills root and manifest, and the update still lands
 * on the plan's folder.
 */
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/db/database-interface.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import type { ManifestPort } from '../../../src/services/skill-swap.js'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import type { UpdatePlan } from '../../../src/services/skill-update.types.js'
import { createTestDatabase } from '../../helpers/database.js'
import {
  OP_ID,
  readInstalled,
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

let db: Database
beforeEach(async () => {
  db = await createTestDatabase()
})
afterEach(() => {
  db.close()
})

async function planOf(fx: UpdateFixture): Promise<UpdatePlan> {
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
  return plan
}

function serviceWith(fx: UpdateFixture, onProgress: (stage: string) => void) {
  return new SkillInstallationService({
    db,
    skillRepo: new SkillRepository(db),
    skillDependencyRepo: new SkillDependencyRepository(db),
    // Deliberately not the plan's: the plan is authoritative.
    skillsDir: path.join(fx.base, 'unrelated-skills'),
    manifestPath: path.join(fx.base, 'unrelated-manifest.json'),
    onProgress: (stage) => onProgress(stage),
  })
}

/** Counts the lock-3 holds through the real port. */
function counting() {
  const c = { holds: 0 }
  const wrap = (real: ManifestPort): ManifestPort => ({
    withManifestLock: (fn) =>
      real.withManifestLock((m) => {
        c.holds++
        return fn(m)
      }),
  })
  return { c, wrap }
}

describe('SkillInstallationService.updateInPlace', () => {
  it('uses the service’s onProgress by default and passes swap and wrapPort through', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const plan = await planOf(fx)
    const serviceStages: string[] = []
    const { c, wrap } = counting()
    const rec = recorded()
    const result = await serviceWith(fx, (s) => serviceStages.push(s)).updateInPlace(plan, {
      swap: rec.swap,
      wrapPort: wrap,
    })
    expect(result).toMatchObject({ status: 'committed', opId: OP_ID })
    expect(serviceStages).toContain('write')
    expect(c.holds).toBe(2)
    expect(rec.trace.length).toBeGreaterThan(0)
    // The plan's manifest was written, at the plan's key.
    expect(readInstalled(fx.manifestPath)[fx.manifestKey]).toMatchObject({
      originalContentHash: plan.postEntry.originalContentHash,
    })
  })

  it('an explicit onProgress overrides the service’s', async () => {
    const upstream = useUpstream()
    upstream['SKILL.md'] = skillMd('v2')
    const fx = updateFixture({ 'SKILL.md': skillMd('v1') })
    const plan = await planOf(fx)
    const serviceStages: string[] = []
    const callerStages: string[] = []
    const result = await serviceWith(fx, (s) => serviceStages.push(s)).updateInPlace(plan, {
      swap: recorded().swap,
      onProgress: (s) => callerStages.push(s),
    })
    expect(result.status).toBe('committed')
    expect(callerStages).toContain('write')
    expect(serviceStages).toEqual([])
  })
})
