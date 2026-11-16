/**
 * @fileoverview The blank-value rule as a PROPERTY of the command (SMI-6531 step
 * 6c-ii-b, fix round 2): every option `doctor backups` registers that takes a
 * value must refuse an empty or whitespace-only one, in the listing and with
 * `--prune`, and every value of a repeatable option is checked. The options are
 * enumerated from commander's own registered list, never from a list kept here,
 * so a flag added later is covered without anyone remembering to add it.
 *
 * `--state-root ""` once became the current directory and selected a backup the
 * user never named; the earlier hand-written list of six flags had missed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./doctor.backups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./doctor.backups.js')>()
  // The same action without the telemetry wrapper: the rule under test is `runDoctorBackups`.
  return { ...real, doctorBackupsAction: real.runDoctorBackups }
})

import type { Command } from 'commander'
import { createDoctorCommand } from './doctor.js'

let out: string[] = []
let err: string[] = []
beforeEach(() => {
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

function backupsCommand(): Command {
  const found = createDoctorCommand().commands.find((c) => c.name() === 'backups')
  if (found === undefined) throw new Error('doctor backups is not registered')
  return found
}

/** Every registered option that takes a value, and whether it repeats. */
const valued = backupsCommand()
  .options.filter((o) => o.required === true || o.optional === true)
  .map((o) => ({ flag: o.long as string, repeatable: Array.isArray(o.defaultValue) }))

async function refusal(args: string[]): Promise<{ text: string; exit: number | undefined }> {
  const cmd = createDoctorCommand()
  cmd.exitOverride()
  for (const c of cmd.commands) {
    c.exitOverride()
    c.configureOutput({ writeErr: (s) => void err.push(s), writeOut: () => undefined })
  }
  let thrown = ''
  try {
    await cmd.parseAsync(['node', 'doctor', 'backups', ...args])
  } catch (e) {
    thrown = (e as Error).message
  }
  return { text: [thrown, ...err].join('\n'), exit: process.exitCode as number | undefined }
}

describe('every registered option that takes a value refuses a blank one', () => {
  it('the enumeration found the options (presence control: an empty list would pass vacuously)', () => {
    const flags = valued.map((v) => v.flag)
    for (const f of ['--root', '--state-root', '--client', '--path', '--allow-changed', '--keep'])
      expect(flags).toContain(f)
    expect(valued.some((v) => v.repeatable)).toBe(true)
  })

  const cases = valued.flatMap((v) =>
    [[], ['--prune']].flatMap((mode) =>
      ['', '   '].map((blank) => ({ ...v, mode, blank }) as const)
    )
  )
  it.each(cases)(
    '$flag "$blank" with $mode is refused naming the flag, and nothing is listed',
    async ({ flag, mode, blank }) => {
      const r = await refusal([...mode, flag, blank])
      expect(r.text).toContain(flag)
      // Either the action's own refusal (exit 1) or commander's argument parser refusing first.
      if (!r.text.includes('needs a whole number')) {
        expect(r.text).toContain(`${flag} needs a non-empty value.`)
        expect(r.exit).toBe(1)
      }
      expect(out).toEqual([])
    }
  )

  const repeatable = valued.filter((v) => v.repeatable)
  it.each(repeatable.flatMap((v) => ['', '   '].map((blank) => ({ ...v, blank }))))(
    '$flag: a blank SECOND value "$blank" is refused, not only the first',
    async ({ flag, blank }) => {
      const r = await refusal(['--prune', flag, '/somewhere/real', flag, blank])
      expect(r.text).toContain(`${flag} needs a non-empty value.`)
      expect(r.exit).toBe(1)
      expect(out).toEqual([])
    }
  )
})
