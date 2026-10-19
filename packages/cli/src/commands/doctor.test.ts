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

  it('refuses --unsafe-unverified-owner without --release, exit 1', async () => {
    await runDoctorLocks({ stateRoot: root, unsafeUnverifiedOwner: true })
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([])
  })
})
