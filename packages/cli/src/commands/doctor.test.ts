/**
 * @fileoverview `skillsmith doctor locks` (SMI-7143, A1 plan §3.9).
 *
 * Core's `lock-doctor.test.ts` holds T-M2's release rules. These tests pin
 * the command: `--release` accepts only a path the listing shows, the unsafe
 * flag prints the claim and why its owner can't be verified before releasing,
 * and refusals exit 1. Every case uses a temporary `--state-root`, so nothing
 * here reaches a real home.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ release: [] as Array<{ path: string; opts: unknown }> }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    releaseLock: (path: string, opts: Parameters<typeof actual.releaseLock>[1]) => {
      calls.release.push({ path, opts })
      return actual.releaseLock(path, opts)
    },
  }
})

import { runDoctorLocks } from './doctor.js'

let root = ''
let lockPath = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-locks-')))
  lockPath = path.join(root, 'manifest.json.lock')
  out = []
  err = []
  calls.release = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  expect(r.status).toBe(0)
  return r.pid!
}

const v1 = (pid: number): string =>
  JSON.stringify({ v: 1, pid, token: 'abcdef0123456789', host: os.hostname(), acquiredAt: 1 })

describe('skillsmith doctor locks', () => {
  it('lists the manifest lock and its reclaim lock, with the claim and how to release it', async () => {
    fs.writeFileSync(lockPath, String(deadPid()))

    await runDoctorLocks({ stateRoot: root })

    const text = out.join('\n')
    expect(text).toContain(lockPath)
    expect(text).toContain('bare-PID claim (older Skillsmith)')
    expect(text).toContain('host: not recorded')
    expect(text).toContain('release needs --unsafe-unverified-owner')
    expect(text).toContain(`${lockPath}.reclaim: not present`)
    expect(process.exitCode).toBeUndefined()
  })

  it('refuses to release a path the listing does not show, exit 1, file untouched', async () => {
    const manifest = path.join(root, 'manifest.json')
    fs.writeFileSync(manifest, '{}')

    await runDoctorLocks({ stateRoot: root, release: manifest, unsafeUnverifiedOwner: true })

    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('is not a lock doctor lists')
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{}')
  })

  it('releases a same-host claim with a dead pid', async () => {
    fs.writeFileSync(lockPath, v1(deadPid()))

    await runDoctorLocks({ stateRoot: root, release: lockPath })

    expect(process.exitCode).toBeUndefined()
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(out.join('\n')).toContain(`Released ${lockPath}.`)
  })

  it('refuses a bare-PID claim without the flag, exit 1, naming the flag', async () => {
    const text = String(deadPid())
    fs.writeFileSync(lockPath, text)

    await runDoctorLocks({ stateRoot: root, release: lockPath })

    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('--unsafe-unverified-owner')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(text)
  })

  it('with the flag, prints the claim and why its owner is unverified before releasing', async () => {
    fs.writeFileSync(lockPath, String(deadPid()))

    await runDoctorLocks({ stateRoot: root, release: lockPath, unsafeUnverifiedOwner: true })

    expect(fs.existsSync(lockPath)).toBe(false)
    const claimAt = out.findIndex((l) => l.includes('bare-PID claim'))
    const whyAt = out.findIndex((l) => l.includes("Its owner can't be verified"))
    const releasedAt = out.findIndex((l) => l.includes(`Released ${lockPath}.`))
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(whyAt).toBeGreaterThan(claimAt)
    expect(releasedAt).toBeGreaterThan(whyAt)
  })

  it('with the flag, releases only the claim it printed (passes it as expected)', async () => {
    fs.writeFileSync(lockPath, String(deadPid()))
    const ino = BigInt(fs.statSync(lockPath).ino)

    await runDoctorLocks({ stateRoot: root, release: lockPath, unsafeUnverifiedOwner: true })

    expect(calls.release).toHaveLength(1)
    const opts = calls.release[0]!.opts as { expected?: { ino: bigint; bytes: Buffer } }
    expect(opts.expected?.ino).toBe(ino)
    expect(opts.expected?.bytes.toString()).toMatch(/^[0-9]+$/)
  })

  it('a symlinked state root lists and releases the real files', async () => {
    const link = path.join(os.tmpdir(), `doctor-locks-link-${process.pid}-${Date.now()}`)
    fs.symlinkSync(root, link)
    try {
      fs.writeFileSync(lockPath, v1(deadPid()))
      await runDoctorLocks({ stateRoot: link })
      expect(out.join('\n')).toContain(`Locks under ${root}`)

      await runDoctorLocks({ stateRoot: link, release: path.join(link, 'manifest.json.lock') })
      expect(process.exitCode).toBeUndefined()
      expect(calls.release[0]!.path).toBe(lockPath)
      expect(fs.existsSync(lockPath)).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  it('refuses a path whose folder is a symlink to somewhere else, file untouched', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-elsewhere-')))
    try {
      const theirs = path.join(elsewhere, 'manifest.json.lock')
      fs.writeFileSync(theirs, v1(deadPid()))
      fs.symlinkSync(elsewhere, path.join(root, 'sub'))

      await runDoctorLocks({
        stateRoot: root,
        release: path.join(root, 'sub', 'manifest.json.lock'),
      })

      expect(process.exitCode).toBe(1)
      expect(fs.existsSync(theirs)).toBe(true)
      expect(calls.release).toEqual([])
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses --unsafe-unverified-owner without --release, exit 1', async () => {
    await runDoctorLocks({ stateRoot: root, unsafeUnverifiedOwner: true })
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([])
  })
})
