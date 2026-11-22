/**
 * @fileoverview After a refused `--undo` of a swapped update (S2), the next
 * `skillsmith doctor recovery` finishes it (SMI-6531 #3283).
 *
 * The race is planted through core's `executeRecovery` test hook (`afterClaim`,
 * which the CLI does not expose): the old folder is edited, or replaced by a
 * copy, after the undo set the new folder aside and claimed the skill path.
 * Doctor refuses (`staging-unsafe`, nothing published). The re-run is the CLI
 * command a user would type, through the same harness as the other doctor
 * action tests: an edited old folder keeps its identity, so the state is UN1
 * and `--apply` finishes it; a replaced one is a copy, so plain `--apply` is
 * refused `recovery-identity-changed` (exit 1, nothing changed) and
 * `--apply --accept-identity` finishes it. Each end: exit 0, the old folder
 * (as the race left it) at the skill path, the set-aside folder kept, the
 * record and the op dir gone.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ discovery: {} as Record<string, unknown> }))
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    discoverRoots: (o: Parameters<typeof actual.discoverRoots>[0]) =>
      actual.discoverRoots({ ...o, ...calls.discovery }),
  }
})

import { executeRecovery, planRecovery, treeHashOf } from '@skillsmith/core'
import { runRecoveryAction } from './doctor.recovery.action.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rerun-')))
  calls.discovery = hermeticDiscovery(base, true)
  process.env['SKILLSMITH_JOURNAL_DIR'] = path.join(base, 'journal')
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  delete process.env['SKILLSMITH_JOURNAL_DIR']
  fs.rmSync(base, { recursive: true, force: true })
})

const hashOf = (p: string): string => {
  const h = treeHashOf(p)
  if (!h.ok) throw new Error(`cannot hash ${p}`)
  return h.hash
}

describe('a refused S2 --undo, then the CLI re-run', () => {
  for (const race of ['edit', 'replace'] as const) {
    it(`${race}: the CLI --apply finishes the undo`, async () => {
      const u = plantCrashedUpdate(base)
      const old = path.join(u.opDir, 'old')
      const planned = await planRecovery({
        action: 'undo',
        opId: u.opId,
        roots: [u.root],
        euid: process.geteuid?.() ?? 0,
        journalFile: path.join(base, 'journal', 'journal.jsonl'),
        stateRoots: [fs.realpathSync(u.stateRoot)],
      })
      if (planned.status !== 'planned') throw new Error(`not planned: ${JSON.stringify(planned)}`)
      const first = await executeRecovery(planned, {
        swap: {
          hooks: {
            afterClaim: () => {
              if (race === 'edit') {
                fs.writeFileSync(path.join(old, 'SKILL.md'), '# raced\n')
              } else {
                const away = path.join(base, 'old-away')
                fs.renameSync(old, away)
                fs.cpSync(away, old, { recursive: true })
              }
            },
          },
        },
      })
      expect(first).toMatchObject({ status: 'stopped', reason: 'staging-unsafe' })
      const oHash = hashOf(old)
      const uHash = hashOf(path.join(u.opDir, 'undone'))

      if (race === 'replace') {
        await runRecoveryAction({ apply: u.opId, yes: true })
        expect(process.exitCode).toBe(1)
        expect([...out, ...err].join('\n')).toContain('recovery-identity-changed')
        expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(true)
        process.exitCode = undefined
        out = []
      }
      await runRecoveryAction({
        apply: u.opId,
        yes: true,
        ...(race === 'replace' ? { acceptIdentity: true } : {}),
      })
      expect(process.exitCode).toBeUndefined()
      const text = out.join('\n')
      expect(text).toContain(`(UN1 undo, set aside)`)
      expect(text).toContain('Done: apply')
      expect(hashOf(u.skillDir)).toBe(oHash)
      const area = path.dirname(u.backupDest)
      const kept = fs
        .readdirSync(area)
        .filter((n) => n.startsWith(`${u.opId}.`) && !n.endsWith('.json'))
        .map((n) => hashOf(path.join(area, n)))
      expect(kept).toContain(uHash)
      expect(fs.existsSync(path.join(u.opDir, 'record.json'))).toBe(false)
      expect(fs.existsSync(u.opDir)).toBe(false)
    })
  }
})
