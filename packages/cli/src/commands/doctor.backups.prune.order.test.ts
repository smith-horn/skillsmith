/**
 * @fileoverview M-ORD end to end (SMI-6531 step 6c-ii-b, UD60): the dry run
 * prints its groups in ascending bytewise order of the lock file's native
 * path, whatever order discovery returned. Two skills roots whose names differ
 * at U+FF5A and U+1F600 order one way by UTF-8 bytes and the other way by
 * UTF-16 code units (the default `sort()` and `localeCompare`), so a reader
 * that orders any other way is caught.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctorBackups } from './doctor.backups.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'
import { mkBase, putParked, stateRootOf } from './doctor.backups.prune.test-helpers.js'
import type { PlanDoc } from './doctor.backups.prune.test-helpers.js'

const FF5A = 'ｚ'
const EMOJI = '\u{1F600}'

let base = ''
let out: string[] = []
beforeEach(() => {
  base = mkBase('doctor-prune-ord-')
  stateRootOf(base)
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

function twoRoots(): { ff5a: string; emoji: string } {
  const make = (n: string): string => {
    const p = path.join(base, n)
    fs.mkdirSync(p)
    return fs.realpathSync(p)
  }
  return { ff5a: make(`r${FF5A}`), emoji: make(`r${EMOJI}`) }
}

describe('M-ORD: groups come in ascending bytewise order of the lock path', () => {
  it('the fixture separates the orders: bytes and UTF-16 disagree about these two roots', () => {
    const r = twoRoots()
    const byBytes = [r.emoji, r.ff5a].sort((a, b) =>
      Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
    )
    expect(byBytes).toEqual([r.ff5a, r.emoji])
    expect([r.ff5a, r.emoji].sort()).toEqual([r.emoji, r.ff5a])
    expect([r.ff5a, r.emoji].sort((a, b) => a.localeCompare(b))).toEqual([r.emoji, r.ff5a])
  })

  it('--json and the text both list the U+FF5A root first, whichever order roots were given in', async () => {
    const r = twoRoots()
    const a = putParked({ root: r.ff5a, name: 'a', opId: 'op-a' })
    const b = putParked({ root: r.emoji, name: 'b', opId: 'op-b' })
    for (const given of [
      [r.emoji, r.ff5a],
      [r.ff5a, r.emoji],
    ]) {
      out = []
      await runDoctorBackups({
        discovery: hermeticDiscovery(base, true),
        prune: true,
        json: true,
        olderThan: '0',
        root: given,
      })
      const doc = JSON.parse(out.join('\n')) as PlanDoc
      expect(doc.groups.map((g) => g.items.map((i) => i.copyPath))).toEqual([
        [a.copyPath],
        [b.copyPath],
      ])
      const paths = doc.groups.map((g) => g.lock.path)
      expect(paths).toEqual(
        [...paths].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))
      )
      out = []
      await runDoctorBackups({
        discovery: hermeticDiscovery(base, true),
        prune: true,
        olderThan: '0',
        root: given,
      })
      const text = out.join('\n')
      expect(text.indexOf(`lock file: ${paths[0]}`)).toBeGreaterThan(-1)
      expect(text.indexOf(`lock file: ${paths[0]}`)).toBeLessThan(
        text.indexOf(`lock file: ${paths[1]}`)
      )
      expect(text.indexOf(a.copyPath)).toBeLessThan(text.indexOf(b.copyPath))
    }
  })
})
