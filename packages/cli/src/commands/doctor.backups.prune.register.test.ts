/**
 * @fileoverview The `doctor backups` options as commander registers them
 * (SMI-6531 step 6c-ii-b): what the action receives for each flag, `--keep`
 * having no default (M-KEEP1), and `--apply` not being an option at all, so
 * `doctor backups --prune --apply` is commander's "unknown option" error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }))
vi.mock('./doctor.backups.js', () => ({
  doctorBackupsAction: (o: Record<string, unknown>) => {
    calls.opts.push(o)
    return Promise.resolve()
  },
  printParkedUsageWarning: () => Promise.resolve(),
}))

import { createDoctorCommand } from './doctor.js'

beforeEach(() => {
  calls.opts = []
})

async function parse(...args: string[]): Promise<Record<string, unknown>> {
  const cmd = createDoctorCommand()
  cmd.exitOverride()
  for (const c of cmd.commands) {
    c.exitOverride()
    c.configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  }
  await cmd.parseAsync(['node', 'doctor', 'backups', ...args])
  expect(calls.opts).toHaveLength(1)
  return calls.opts[0] as Record<string, unknown>
}

describe('doctor backups options', () => {
  it('--keep has no commander default: given nothing, the action receives it undefined (M-KEEP1)', async () => {
    const o = await parse('--prune')
    expect(o['prune']).toBe(true)
    expect(o['keep']).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(o, 'keep')).toBe(false)
  })

  it('every selector reaches the action as given, repeatable ones as arrays', async () => {
    const o = await parse(
      '--prune',
      '--older-than',
      '30',
      '--keep',
      '2',
      '--client',
      'cursor',
      '--root',
      '/a',
      '--root',
      '/b',
      '--skill',
      's',
      '--op',
      'op-1',
      '--path',
      '/p1',
      '--path',
      '/p2',
      '--include-kept',
      '--allow-changed',
      '/c1',
      '--allow-changed',
      '/c2',
      '--json',
      '--state-root',
      '/st'
    )
    expect(o).toMatchObject({
      prune: true,
      olderThan: '30',
      keep: '2',
      client: 'cursor',
      root: ['/a', '/b'],
      skill: 's',
      op: 'op-1',
      path: ['/p1', '/p2'],
      includeKept: true,
      allowChanged: ['/c1', '/c2'],
      json: true,
      stateRoot: '/st',
    })
  })

  it('--apply is not registered: --prune --apply is an unknown option', async () => {
    const backups = createDoctorCommand().commands.find((c) => c.name() === 'backups')
    expect(backups?.options.map((o) => o.long)).not.toContain('--apply')
    await expect(parse('--prune', '--apply')).rejects.toMatchObject({
      code: 'commander.unknownOption',
    })
    expect(calls.opts).toEqual([])
  })

  it('--allow-changed says it selects for a per-item confirmation under --apply (6c-iii)', () => {
    const backups = createDoctorCommand().commands.find((c) => c.name() === 'backups')
    const opt = backups?.options.find((o) => o.long === '--allow-changed')
    expect(opt?.description).toContain('select for a per-item confirmation under --apply (6c-iii)')
  })
})
