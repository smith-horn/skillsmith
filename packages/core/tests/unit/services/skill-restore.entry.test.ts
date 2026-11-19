/**
 * SMI-6531 (A1 step 6d-ii): restoring a parked file or symlink never replaces
 * what sits at the origin (design note §9.2, T-RS2). Each row has a declared red
 * mutation recorded in the 6d-ii PR.
 */
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

describe('RS2: no-replace restore of files and symlinks', () => {
  it('RS2-file: link, then both names checked, then the parked name unlinked; never rename', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const order: string[] = []
    const wrap = <K extends 'linkSync' | 'lstatSync' | 'unlinkSync' | 'renameSync'>(k: K): void => {
      const orig = fs[k] as (...a: unknown[]) => unknown
      vi.spyOn(fs, k).mockImplementation(((...a: unknown[]) => {
        order.push(`${k}:${String(a[0])}`)
        return orig.apply(fs, a)
      }) as never)
    }
    wrap('linkSync')
    wrap('lstatSync')
    wrap('unlinkSync')
    wrap('renameSync')
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('restored')
    expect(fs.readFileSync(m.origin, 'utf8')).toBe('file f.txt\n')
    expect(order.some((c) => c.startsWith('renameSync:'))).toBe(false)
    const link = order.indexOf(`linkSync:${m.copyPath}`)
    const unlink = order.indexOf(`unlinkSync:${m.copyPath}`)
    expect(link).toBeGreaterThanOrEqual(0)
    expect(unlink).toBeGreaterThan(link)
    const between = order.slice(link + 1, unlink)
    expect(between.filter((c) => c === `lstatSync:${m.origin}`)).toHaveLength(1)
    expect(between.filter((c) => c === `lstatSync:${m.copyPath}`)).toHaveLength(1)
    expect(fs.existsSync(m.copyPath)).toBe(false)
    expect(fs.existsSync(m.sidecarPath)).toBe(false)
  })

  it('RS2-symlink and RS2-dangling: readlink then symlink, never link', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'lnk', { type: 'symlink', linkText: 'does-not-exist' })
    const plan = await planOk(m.copyPath, env.opts)
    const link = vi.spyOn(fs, 'linkSync')
    const sym = vi.spyOn(fs, 'symlinkSync')
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('restored')
    expect(link).not.toHaveBeenCalled()
    expect(sym).toHaveBeenCalledWith('does-not-exist', m.origin)
    expect(fs.readlinkSync(m.origin)).toBe('does-not-exist')
    expect(fs.existsSync(m.copyPath)).toBe(false)
  })

  for (const type of ['file', 'symlink'] as const) {
    it(`RS2-eexist-${type}: an entry created first is refused and left intact`, async () => {
      env = mkEnv()
      const m = parkEntry(env.root, 'thing', { type })
      const plan = await planOk(m.copyPath, env.opts)
      let ino = 0n
      const r = await executeRestoreWith(plan, {
        beforeClaim: () => {
          fs.writeFileSync(m.origin, 'occupant')
          ino = fs.lstatSync(m.origin, { bigint: true }).ino
        },
      })
      expect(r.status).toBe('refused')
      if (r.status !== 'restored') expect(r.reason).toBe('origin-occupied')
      expect(fs.readFileSync(m.origin, 'utf8')).toBe('occupant')
      expect(fs.lstatSync(m.origin, { bigint: true }).ino).toBe(ino)
      expect(fs.lstatSync(m.copyPath, { throwIfNoEntry: false })).toBeDefined()
      expect(fs.existsSync(m.sidecarPath)).toBe(true)
    })
  }

  it('RS2-swapped: the parked name replaced after the link stops, exit 4 shape, record kept', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestoreWith(plan, {
      afterLink: () => {
        fs.unlinkSync(m.copyPath)
        fs.writeFileSync(m.copyPath, 'a different file')
      },
    })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.changed).toBe(true)
    expect(r.message).toContain(m.origin)
    expect(r.message).toContain(m.copyPath)
    expect(fs.readFileSync(m.copyPath, 'utf8')).toBe('a different file')
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
    const listing = await listBackups(env.opts)
    const paths = listing.parked.flatMap((v) => v.rows.map((x) => x.copy.copyPath))
    expect(paths).toContain(m.copyPath)
  })

  it('RS2-unlink-fails: a parked name that cannot be removed is reported with both paths, record kept', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const orig = fs.unlinkSync.bind(fs)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === m.copyPath) {
        throw Object.assign(new Error('forced'), { code: 'EACCES' })
      }
      return orig(p)
    }) as never)
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('unlink-failed')
    expect(r.message).toContain('EACCES')
    expect(r.message).toContain(m.copyPath)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
    expect(fs.existsSync(m.origin)).toBe(true)
  })
})
