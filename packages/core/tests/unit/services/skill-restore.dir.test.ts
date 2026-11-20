/**
 * SMI-6531 (A1 step 6d-ii): `planRestore` / `executeRestoreWith` over folders and
 * the refusals (design note §9.1, §9.4). Each row has a declared red mutation
 * recorded in the 6d-ii PR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import { parkedLockPath } from '../../../src/config/file-lock.parked.js'
import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { planRestore } from '../../../src/services/skill-restore.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'
import { mkEnv, parkEntry, planOk, snapshot, indexKind, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => fs.rmSync(env.base, { recursive: true, force: true }))

const hashOf = (p: string): string => {
  const h = computePathTreeHash(p)
  if (!h.ok) throw new Error('hash')
  return h.treeHash
}

describe('restoring a folder', () => {
  it('RS1-parked: a parked uninstall copy comes back byte-identical, sidecar gone, says untracked', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const before = fs.existsSync(m.origin)
    expect(before).toBe(false)
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.lock.kind).toBe('lock1')
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('restored')
    if (r.status !== 'restored') return
    expect(r.notes.join(' ')).toContain('not tracked')
    expect(fs.readFileSync(path.join(m.origin, 'SKILL.md'), 'utf8')).toBe('skill skill-a\n')
    expect(fs.existsSync(m.copyPath)).toBe(false)
    expect(fs.existsSync(m.sidecarPath)).toBe(false)
  })

  it('RS1-held: a held copy restores, differs, and is tracked again', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-h', { held: true })
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.held).toBe(true)
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('restored')
    if (r.status !== 'restored') return
    expect(r.notes.join(' ')).toContain('differs')
    expect(r.notes.join(' ')).toContain('tracked again')
    expect(fs.existsSync(path.join(m.origin, 'late.txt'))).toBe(true)
    expect(hashOf(m.origin)).toBeTruthy()
  })

  it('RS1-ambig: two copies of one opId refuse, naming both; nothing changes', async () => {
    env = mkEnv()
    const a = parkEntry(env.root, 'skill-a', { opId: 'shared-op' })
    const b = parkEntry(env.root2, 'skill-b', { opId: 'shared-op' })
    const before = [...snapshot(env.root), ...snapshot(env.root2)]
    const r = await planRestore('shared-op', env.opts)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toBe('restore-ambiguous')
    expect(r.message).toContain(a.copyPath)
    expect(r.message).toContain(b.copyPath)
    expect([...snapshot(env.root), ...snapshot(env.root2)]).toEqual(before)
  })

  it('RS1-name: <opId>/<name> picks exactly the named copy', async () => {
    env = mkEnv()
    const a = parkEntry(env.root, 'skill-a', { opId: 'shared-op' })
    parkEntry(env.root2, 'skill-b', { opId: 'shared-op' })
    const id = `shared-op/${path.basename(a.copyPath)}`
    const plan = await planOk(id, env.opts)
    expect(plan.copyPath).toBe(a.copyPath)
  })

  it('RS1-path: a symlinked spelling of the absolute path picks the same copy', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const alias = path.join(env.base, 'alias')
    fs.symlinkSync(env.root, alias)
    const plan = await planOk(
      path.join(alias, '.skillsmith-parked', m.opId, path.basename(m.copyPath)),
      env.opts
    )
    expect(plan.copyPath).toBe(m.copyPath)
  })

  it('RS1-empty-occupant: an empty folder created before the claim is refused and left in place', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    let ino = 0n
    const r = await executeRestoreWith(plan, {
      beforeClaim: () => {
        fs.mkdirSync(m.origin)
        ino = fs.lstatSync(m.origin, { bigint: true }).ino
      },
    })
    expect(r.status).toBe('refused')
    if (r.status === 'restored') return
    expect(r.reason).toBe('origin-occupied')
    expect(fs.lstatSync(m.origin, { bigint: true }).ino).toBe(ino)
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('RS1-occupied-plan: an occupant before planning refuses before any lock file exists', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    fs.mkdirSync(m.origin)
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-occupied')
    expect(fs.existsSync(path.join(env.root, '.skillsmith-writes.lock'))).toBe(false)
  })

  it('R-busy: another holder of lock 1 gives restore-busy and nothing changes', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let acquired!: () => void
    const got = new Promise<void>((r) => (acquired = r))
    const holder = withSkillWriteLock(env.root, 'test holder', async () => {
      acquired()
      await held
    })
    await got
    const r = await executeRestoreWith(plan, { lockTimeoutMs: 200 })
    release()
    await holder
    expect(r.status).toBe('refused')
    if (r.status !== 'restored') expect(r.reason).toBe('restore-busy')
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.origin)).toBe(false)
  })

  it('R-zero-mutation: planning writes nothing, not even a lock directory', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const before = snapshot(env.base)
    await planOk(m.copyPath, env.opts)
    expect(snapshot(env.base)).toEqual(before)
    expect(fs.existsSync(path.join(env.stateRoot, 'locks'))).toBe(false)
  })
})

describe('refusals', () => {
  it('RS1-abort-new: an internal-origin kind has nothing to restore into', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'staged', { caller: 'abort-cleanup' })
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('nothing-to-restore-into')
  })

  it('RS1-fanout: staging and backup refuse, symlink restores', async () => {
    env = mkEnv()
    const st = parkEntry(env.root, 'stg', { caller: 'fan-out-staging' })
    const bk = parkEntry(env.root, 'bak', { caller: 'fan-out-backup' })
    const sl = parkEntry(env.root, 'lnk', { caller: 'fan-out-symlink', type: 'symlink' })
    expect((await planRestore(st.copyPath, env.opts)).status).toBe('refused')
    const b = await planRestore(bk.copyPath, env.opts)
    expect(b.status === 'refused' && b.reason).toBe('nothing-to-restore-into')
    const s = await planRestore(st.copyPath, env.opts)
    expect(s.status === 'refused' && s.reason).toBe('nothing-to-restore-into')
    const plan = await planOk(sl.copyPath, env.opts)
    expect(plan.type).toBe('symlink')
    expect((await executeRestoreWith(plan)).status).toBe('restored')
  })

  it('RS1-legacy-kind: a sidecar still carrying fan-out-overwrite is refused as unknown', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'lnk', { caller: 'fan-out-symlink', type: 'symlink' })
    const text = fs.readFileSync(m.sidecarPath, 'utf8')
    expect(text).toContain('"fan-out-symlink"')
    fs.writeFileSync(m.sidecarPath, text.replace('"fan-out-symlink"', '"fan-out-overwrite"'))
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toBe('restore-kind-unknown')
  })

  it('R-strict: a held sidecar with one extra key is refused as origin-unknown', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-h', { held: true })
    expect((await planRestore(m.copyPath, env.opts)).status).toBe('planned')
    const s = JSON.parse(fs.readFileSync(m.sidecarPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(m.sidecarPath, JSON.stringify({ ...s, extra: 1 }))
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-unknown')
    expect(fs.existsSync(m.origin)).toBe(false)
  })

  it('R-mismatch: an origin that is not beside the area is refused with no lock file', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const s = JSON.parse(fs.readFileSync(m.sidecarPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(
      m.sidecarPath,
      JSON.stringify({ ...s, originPath: path.join(env.root2, 'skill-a') })
    )
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-mismatch')
    expect(fs.existsSync(path.join(env.root2, '.skillsmith-writes.lock'))).toBe(false)
  })

  it('RS1-bad-id and not-found', async () => {
    env = mkEnv()
    for (const bad of ['a/b/c', '..', 'a/..', './x', '']) {
      const r = await planRestore(bad, env.opts)
      expect(r.status === 'refused' && r.reason, bad).toBe('restore-bad-id')
    }
    const r = await planRestore('nope', env.opts)
    expect(r.status === 'refused' && r.reason).toBe('restore-not-found')
  })
})

describe('the lock follows the origin', () => {
  it('RS1-init-outside: an init-rollback copy outside every root restores under lock 1prime', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-outside')
    const m = parkEntry(p, 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.lock.kind).toBe('lock1prime')
    expect(plan.lock.path).toBe(
      parkedLockPath(env.stateRoot, fs.realpathSync.native(path.join(p, '.skillsmith-parked')))
    )
    expect((await executeRestoreWith(plan)).status).toBe('restored')
    expect(fs.existsSync(path.join(m.origin, 'SKILL.md'))).toBe(true)
  })

  it('RS1-reclassified (b): a lock choice that changed after the plan stops plan-changed, zero mutation', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-outside')
    const m = parkEntry(p, 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, env.opts)
    const changed = { ...plan, options: { ...plan.options, roots: [p] } }
    const r = await executeRestoreWith(changed)
    expect(r.status).toBe('refused')
    if (r.status !== 'restored') expect(r.reason).toBe('plan-changed')
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })

  it('RS1-reclassified (a2) and R-lock-note: an ancestor that became a skills root locks restore, and the plan says prune would differ', async () => {
    env = mkEnv()
    const r = path.join(env.base, 'rproj')
    const proj = path.join(r, 'proj')
    const m = parkEntry(proj, 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const opts = { ...env.opts, roots: [r] }
    const plan = await planOk(m.copyPath, opts)
    expect(plan.lock.kind).toBe('lock1')
    expect(plan.lock.path).toBe(path.join(r, '.skillsmith-writes.lock'))
    // assignLocks scans only <root>/.skillsmith-parked, so it names lock 1prime for this copy.
    expect(plan.lockNote).toContain('skillsmith doctor backups --prune')
    expect(plan.lockNote).toContain(plan.lock.path)
    let release!: () => void
    const held = new Promise<void>((res) => (release = res))
    let acquired!: () => void
    const got = new Promise<void>((res) => (acquired = res))
    const holder = withSkillWriteLock(r, 'test writer', async () => {
      acquired()
      await held
    })
    await got
    const busy = await executeRestoreWith(plan, { lockTimeoutMs: 200 })
    expect(busy.status).toBe('refused')
    if (busy.status !== 'restored') expect(busy.reason).toBe('restore-busy')
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
    release()
    await holder
    expect((await executeRestoreWith(plan)).status).toBe('restored')
    expect(fs.existsSync(path.join(m.origin, 'SKILL.md'))).toBe(true)
  })

  it('RS1-undiscovered: a staging folder above the origin refuses and names --root', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-outside')
    const m = parkEntry(p, 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    fs.mkdirSync(path.join(p, '.skillsmith-staging'))
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-root-undiscovered')
    if (r.status === 'refused') expect(r.message).toContain(`--root ${p}`)
  })
})
