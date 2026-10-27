/**
 * SMI-6531 (A1 step 7b, governance round): the planner's refusals before any
 * write, by the reason each gets and so the remedy A2 prints.
 *
 * - A quarantined registry skill is `scan-rejected` (a security verdict;
 *   `fetch-failed` would tell the user to retry).
 * - Install's confirmation gate is `confirmation-required` until `confirmed`.
 * - A skill ID that does not parse is `manifest-key-conflict`, not
 *   `fetch-failed`.
 * - A throw from a stage becomes `fetch-failed` carrying install's sanitized
 *   message; a `LockOrderError` propagates.
 *
 * Every refusal is paired with a control on the same fixture that plans.
 */
import { describe, expect, it } from 'vitest'
import { LockOrderError } from '../../../src/config/lock-tracker.js'
import type { RegistrySkillInfo } from '../../../src/services/skill-installation.types.js'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import type { UpdateTarget } from '../../../src/services/skill-update.types.js'
import {
  changedBetween,
  skillMd,
  UPSTREAM_REPO,
  updateFixture,
  useTmpCleanup,
  useUpstream,
  useUpstreamCleanup,
  walk,
} from './skill-update.helpers.js'
import type { UpdateFixture } from './skill-update.helpers.js'

useTmpCleanup()
useUpstreamCleanup()

const REGISTRY_ID = `acme/${UPSTREAM_REPO}`

async function targetOf(fx: UpdateFixture): Promise<UpdateTarget> {
  const r = await buildUpdateTarget({
    skillsDir: fx.skillsDir,
    client: fx.client,
    scope: 'global',
    manifestPath: fx.manifestPath,
    comparedPath: fx.comparedPath,
  })
  if (!r.ok) throw new Error(`target refused: ${r.reason}: ${r.detail}`)
  return r.target
}

/** A registry that resolves `REGISTRY_ID` to the fake upstream, with `info` over the defaults. */
function registry(info: Partial<RegistrySkillInfo> = {}) {
  return {
    lookup: async (): Promise<RegistrySkillInfo> => ({
      repoUrl: `https://github.com/acme/${UPSTREAM_REPO}`,
      name: UPSTREAM_REPO,
      trustTier: 'verified',
      ...info,
    }),
  }
}

/** A registry whose lookup throws `err`. */
function throwingRegistry(err: Error) {
  return {
    lookup: async (): Promise<RegistrySkillInfo> => {
      throw err
    },
  }
}

function setup() {
  const upstream = useUpstream()
  upstream['SKILL.md'] = skillMd('v2')
  return updateFixture({ 'SKILL.md': skillMd('v1') })
}

describe('a quarantined registry skill', () => {
  it('is scan-rejected (QUARANTINED), with nothing written; the same skill unquarantined plans', async () => {
    const fx = setup()
    const target = await targetOf(fx)
    const before = walk(fx.skillsDir)
    const r = await planSkillUpdate({
      target,
      skillId: REGISTRY_ID,
      registryLookup: registry({ quarantined: true }),
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'scan-rejected',
      install: { errorCode: 'QUARANTINED' },
    })
    expect(changedBetween(before, walk(fx.skillsDir))).toEqual([])

    const control = await planSkillUpdate({
      target,
      skillId: REGISTRY_ID,
      registryLookup: registry({ quarantined: false }),
    })
    expect(control).toMatchObject({ ok: true, trustTier: 'verified' })
  })
})

describe('install’s confirmation gate', () => {
  it('a registry skill of an unreviewed tier is confirmation-required until confirmed', async () => {
    const fx = setup()
    const target = await targetOf(fx)
    const lookup = registry({ trustTier: 'unknown' })
    const r = await planSkillUpdate({ target, skillId: REGISTRY_ID, registryLookup: lookup })
    expect(r).toMatchObject({
      ok: false,
      reason: 'confirmation-required',
      install: { errorCode: 'CONFIRMATION_REQUIRED', requiresConfirmation: true },
    })
    const confirmed = await planSkillUpdate({
      target,
      skillId: REGISTRY_ID,
      registryLookup: lookup,
      confirmed: true,
    })
    expect(confirmed).toMatchObject({ ok: true, trustTier: 'unknown' })
  })
})

describe('an invalid skill ID', () => {
  it('is manifest-key-conflict naming the ID, not the retryable fetch-failed', async () => {
    const fx = setup()
    const target = await targetOf(fx)
    const r = await planSkillUpdate({ target, skillId: 'not-a-skill-id' })
    expect(r).toMatchObject({ ok: false, reason: 'manifest-key-conflict' })
    expect(r.ok ? '' : r.detail).toContain('"not-a-skill-id"')
    // The control: a GitHub URL parses and plans.
    const control = await planSkillUpdate({
      target,
      skillId: `https://github.com/acme/${UPSTREAM_REPO}`,
    })
    expect(control.ok).toBe(true)
  })
})

describe('a throw from a stage', () => {
  it('becomes fetch-failed with install’s sanitized message, never the raw one', async () => {
    const fx = setup()
    const target = await targetOf(fx)
    const raw = 'connect ECONNREFUSED 10.0.0.7:5432 token=sk_live_SECRET at /home/someone/.cfg'
    const r = await planSkillUpdate({
      target,
      skillId: REGISTRY_ID,
      registryLookup: throwingRegistry(new Error(raw)),
    })
    expect(r).toMatchObject({
      ok: false,
      reason: 'fetch-failed',
      detail: 'Installation failed due to an internal error',
    })
    expect(r.ok ? raw : r.detail).not.toContain('sk_live_SECRET')
    // The control: the same lookup without the throw plans.
    expect(
      (await planSkillUpdate({ target, skillId: REGISTRY_ID, registryLookup: registry() })).ok
    ).toBe(true)
  })

  it('a LockOrderError propagates instead of becoming a refusal', async () => {
    const fx = setup()
    const target = await targetOf(fx)
    const refusal = new LockOrderError('held-while-planning', 'x')
    await expect(
      planSkillUpdate({ target, skillId: REGISTRY_ID, registryLookup: throwingRegistry(refusal) })
    ).rejects.toBe(refusal)
  })
})
