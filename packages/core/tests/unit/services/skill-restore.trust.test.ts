/**
 * SMI-6531 (A1 step 6d-ii, governance confirmation round): a plan is not
 * trusted. The area is re-derived from the copy and the copy must follow the
 * parked layout; a swapped op folder, area folder or state root stops the
 * restore at the re-plan; the public entry takes no seams; messages print the
 * record's own spelling of the origin.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeRestore, executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { replanUnderLock } from '../../../src/services/skill-restore.js'
import type { RestorePlan } from '../../../src/services/skill-restore.types.js'
import { indexKind, mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => fs.rmSync(env.base, { recursive: true, force: true }))

describe('a hand-built plan is checked against the parked layout', () => {
  it('a copyPath that does not follow from the area, op id and name is refused', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const bad: RestorePlan = {
      ...plan,
      copy: { ...plan.copy, copyPath: `${plan.copy.copyPath}-x` },
    }
    const r = await replanUnderLock(bad)
    expect(r.status === 'refused' && r.message).toMatch(/does not describe a set-aside copy/)
    const e = await executeRestoreWith(bad)
    expect(e.status).toBe('refused')
    expect(fs.existsSync(m.origin)).toBe(false)
  })

  it('a consistent plan for a folder that is not a parked area is refused, nothing written', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    // The same op folder, made reachable under another name: every field agrees with every other.
    const area = path.join(env.root, '.skillsmith-parked')
    const fake = path.join(env.root, 'fake-area')
    fs.renameSync(area, fake)
    const opDir = path.join(fake, plan.copy.opId)
    const copyPath = path.join(opDir, plan.copy.name)
    const crafted: RestorePlan = {
      ...plan,
      copyPath,
      copy: {
        ...plan.copy,
        copyPath,
        sidecarPath: `${copyPath}.json`,
        stagingRoot: fake,
        opDir,
        parentDir: opDir,
      },
    }
    const r = await replanUnderLock(crafted, { discovery: env.opts.discovery! })
    expect(r.status === 'refused' && r.message).toMatch(/does not describe a set-aside copy/)
    const e = await executeRestoreWith(crafted)
    expect(e.status).toBe('refused')
    if (e.status !== 'restored') expect(e.reason).toBe('plan-changed')
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(copyPath)).toBe(true)
  })
})

describe('the public executeRestore takes no test seams', () => {
  it('passing hooks is a type error', () => {
    const never = (p: RestorePlan): void => {
      // @ts-expect-error -- the test seams belong to executeRestoreWith, which is not exported
      void executeRestore(p, { lockTimeoutMs: 1 })
    }
    expect(typeof never).toBe('function')
    expect(executeRestore.length).toBe(1)
  })
})

describe('messages print the record spelling of the origin, not the bound real path', () => {
  function viaAlias(): { spelled: string; real: string; copy: string } {
    const m = parkEntry(env.root, 'thing', { type: 'file' })
    const alias = path.join(env.base, 'alias')
    fs.symlinkSync(env.root, alias)
    const spelled = path.join(alias, 'thing')
    const s = JSON.parse(fs.readFileSync(m.sidecarPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(m.sidecarPath, JSON.stringify({ ...s, originPath: spelled }))
    return { spelled, real: path.join(env.root, 'thing'), copy: m.copyPath }
  }

  it('occupied: names the spelled origin', async () => {
    env = mkEnv()
    const a = viaAlias()
    const plan = await planOk(a.copy, env.opts)
    const r = await executeRestoreWith(plan, { beforeClaim: () => fs.writeFileSync(a.real, 'x') })
    expect(r.status).toBe('refused')
    if (r.status === 'restored') return
    expect(r.message).toContain(a.spelled)
    expect(r.message).not.toContain(a.real)
  })

  it('stopped after the link: names the spelled origin and the copy', async () => {
    env = mkEnv()
    const a = viaAlias()
    const plan = await planOk(a.copy, env.opts)
    const r = await executeRestoreWith(plan, {
      afterLink: () => {
        fs.unlinkSync(a.copy)
        fs.writeFileSync(a.copy, 'another file')
      },
    })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.message).toContain(a.spelled)
    expect(r.message).toContain(a.copy)
    expect(r.message).not.toContain(a.real)
  })
})

describe('what changes between the plan and the lock stops the restore at the re-plan', () => {
  const expectPlanChanged = (r: Awaited<ReturnType<typeof executeRestoreWith>>): void => {
    expect(r.status).toBe('refused')
    if (r.status !== 'restored') expect(r.reason).toBe('plan-changed')
  }

  it('(a) the op folder swapped for a new one holding the same copy and record', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const opDir = path.dirname(m.copyPath)
    fs.renameSync(opDir, `${opDir}.aside`)
    fs.mkdirSync(opDir)
    fs.renameSync(path.join(`${opDir}.aside`, path.basename(m.copyPath)), m.copyPath)
    fs.renameSync(path.join(`${opDir}.aside`, path.basename(m.sidecarPath)), m.sidecarPath)
    expectPlanChanged(await executeRestoreWith(plan))
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })

  it('(a) the parked area swapped for a new one holding the same op folder', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const opDir = path.dirname(m.copyPath)
    const area = path.dirname(opDir)
    fs.renameSync(area, `${area}.aside`)
    fs.mkdirSync(area)
    fs.renameSync(path.join(`${area}.aside`, path.basename(opDir)), opDir)
    expectPlanChanged(await executeRestoreWith(plan))
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })

  it('(b) lock 1prime: the state root that names the copy changed: plan-changed (the lock path differs)', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-outside')
    const m = parkEntry(p, 'thing', { caller: 'init-rollback', type: 'file' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.lock.kind).toBe('lock1prime')
    // Rediscovery now finds the home state root (not the explicit one), and its index names the copy.
    const second = path.join(env.base, '.skillsmith')
    indexKind(second, m.copyPath, m.opId, 'init-rollback')
    const { stateRoot: _explicit, ...rest } = plan.options
    expectPlanChanged(await executeRestoreWith({ ...plan, options: rest }))
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })
})
