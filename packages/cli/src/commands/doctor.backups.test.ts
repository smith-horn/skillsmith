/**
 * @fileoverview `skillsmith doctor backups` (SMI-6531 step 6c-ii-a): the text
 * and JSON of the listing, the older MCP store's own section (owner decision
 * D7), the space warning on stderr in the words UD66 fixes, an unusable
 * `--root`, an unreadable index (D13), and UD70's empty skeletons.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupsListing } from '@skillsmith/core'
import { createDoctorCommand } from './doctor.js'
import { runDoctorBackups } from './doctor.backups.js'
import { renderListing } from './doctor.backups.render.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-backups-')))
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

const claude = (): string => path.join(base, 'clients', 'claude-code')
const run = (o: Parameters<typeof runDoctorBackups>[0] = {}) =>
  runDoctorBackups({ discovery: hermeticDiscovery(base, true), ...o })
const loud = { parkedUsage: { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1 } }

/** A set-aside folder with no sidecar, and an old MCP backup. */
function plant(): { copy: string; mcp: string } {
  const copy = path.join(claude(), '.skillsmith-parked', 'op-1', 'foo-12345678')
  fs.mkdirSync(copy, { recursive: true })
  fs.writeFileSync(path.join(copy, 'SKILL.md'), 's'.repeat(6000))
  const mcp = path.join(claude(), '.backups')
  fs.mkdirSync(path.join(mcp, 'bar', '20260101_edit'), { recursive: true })
  fs.writeFileSync(path.join(mcp, 'bar', '20260101_edit', 'SKILL.md'), 'm'.repeat(30000))
  return { copy, mcp }
}

describe('doctor backups: the listing', () => {
  it('is registered as a subcommand and lists a set-aside folder in the words the plan fixes', async () => {
    expect(createDoctorCommand().commands.map((c) => c.name())).toContain('backups')
    const p = plant()
    await run()
    expect(process.exitCode).toBeUndefined()
    const text = out.join('\n')
    expect(text).toContain(`Set-aside folders in ${path.join(claude(), '.skillsmith-parked')}`)
    expect(text).toContain(`next to your own directory ${claude()}`)
    expect(text).toContain('Nothing here is deleted automatically.')
    expect(text).toContain(`held (sidecar-absent)`)
    expect(text).toContain(p.copy)
    expect(text).toContain('on disk')
    expect(text).toContain('index: missing')
    expect(text).not.toMatch(/trash/i)
  })

  it('reports the older MCP store in its own section, not managed by prune, with its size', async () => {
    const p = plant()
    await run()
    const text = out.join('\n')
    expect(text).toContain(`Older MCP backups, not managed by prune: ${p.mcp}`)
    expect(text).toMatch(
      /Older MCP backups, not managed by prune: .*\.backups {2}\d+(\.\d)? (KB|MB) on disk/
    )
  })

  it('says so when nothing is held, still without error', async () => {
    await run()
    expect(out.join('\n')).toContain('No set-aside folders or kept backups found.')
    expect(process.exitCode).toBeUndefined()
  })

  it('--json is one parseable document with the copies and the older MCP store', async () => {
    const p = plant()
    await run({ json: true })
    const doc = JSON.parse(out.join('\n')) as {
      parked: { copies: { path: string; class: string; index: string }[] }[]
      olderMcpBackups: { path: string; allocatedBytes: number }[]
      warning: { warn: boolean }
    }
    const copies = doc.parked.flatMap((a) => a.copies)
    expect(copies).toEqual([
      expect.objectContaining({ path: p.copy, class: 'held', index: 'missing' }),
    ])
    expect(doc.olderMcpBackups[0]).toMatchObject({ path: p.mcp })
    expect(doc.olderMcpBackups[0]!.allocatedBytes).toBeGreaterThan(30000)
    expect(doc.warning.warn).toBe(false)
  })

  it('an unreadable parked index is a listing line, never silence (D13)', async () => {
    const state = path.join(base, '.skillsmith')
    fs.mkdirSync(path.join(state, 'parked-index.jsonl'), { recursive: true })
    await run({ stateRoot: state })
    expect(out.join('\n')).toContain(
      `Set-aside folders found only through the parked index are not listed: ${path.join(state, 'parked-index.jsonl')} could not be read (EISDIR).`
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('--client narrows the kept backups to one client', async () => {
    const state = path.join(base, '.skillsmith')
    for (const c of ['claude-code', 'cursor']) {
      fs.mkdirSync(path.join(state, 'backups', 'update', c, 'rk', 'foo', 'op-1'), {
        recursive: true,
      })
    }
    await run({ stateRoot: state, client: 'cursor' })
    const text = out.join('\n')
    expect(text).toContain('cursor: foo')
    expect(text).not.toContain('claude-code: foo')
  })
})

const oneUnmeasured = () => ({
  allocatedBytes: 4096,
  apparentBytes: 10,
  unmeasured: 1,
  units: new Map([['1:1', 4096]]),
})

describe('doctor backups: --root narrows as well as adds', () => {
  it("shows only the named root's folders and says what it left out", async () => {
    const other = path.join(base, 'clients', 'cursor', '.skillsmith-parked', 'op-9', 'zed-12345678')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'f'), 'z')
    const p = plant()
    await run({ root: [claude()] })
    const text = out.join('\n')
    expect(text).toContain(p.copy)
    expect(text).not.toContain(other)
    expect(text).toContain(`Narrowed by --root to ${claude()}.`)
    expect(text).toContain('Excluded by --root')
    expect(text).toContain('1 set-aside folder')
  })

  it('--json carries what --root left out', async () => {
    plant()
    fs.mkdirSync(
      path.join(base, 'clients', 'cursor', '.skillsmith-parked', 'op-9', 'zed-12345678'),
      {
        recursive: true,
      }
    )
    await run({ root: [claude()], json: true })
    const doc = JSON.parse(out.join('\n')) as {
      narrowedTo: string[]
      excludedByRoot: { parkedCopies: number }
    }
    expect(doc.narrowedTo).toEqual([claude()])
    expect(doc.excludedByRoot.parkedCopies).toBe(1)
  })
})

describe('doctor backups: entries that could not be measured', () => {
  it('reaches stderr from doctor backups, below the threshold', async () => {
    plant()
    await run({ measure: oneUnmeasured })
    expect(err.join('\n')).toMatch(/\d+ entr(y|ies) could not be measured/)
    expect(out.join('\n')).toMatch(/\d+ entr(y|ies) could not be measured\./)
    expect(process.exitCode).toBeUndefined()
  })
})

describe('doctor backups: the space warning and exit status', () => {
  it('goes to stderr, in the words UD66 fixes, naming the largest copies; stdout stays the listing', async () => {
    const p = plant()
    await run(loud)
    const e = err.join('\n')
    expect(e).toContain("Skillsmith's set-aside folders on this disk hold")
    expect(e).toContain('skillsmith doctor backups')
    expect(e).toContain(p.mcp)
    expect(e).not.toMatch(/trash/i)
    expect(out.join('\n')).not.toContain("Skillsmith's set-aside folders on this disk hold")
    expect(process.exitCode).toBeUndefined()
  })

  it('is silent when nothing is over its threshold', async () => {
    plant()
    await run()
    expect(err).toEqual([])
  })

  it('an unusable --root exits 1 and creates nothing there', async () => {
    const missing = path.join(base, 'no-such-root')
    await run({ root: [missing] })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain(
      `--root ${missing} could not be used (ENOENT); nothing was created there.`
    )
    expect(fs.existsSync(missing)).toBe(false)
  })
})

/** A listing with only what the renderer reads, built by hand. */
function handBuilt(over: Partial<BackupsListing>): BackupsListing {
  return {
    discovery: { stateRoots: ['/s'], roots: [], skipped: [] },
    parked: [],
    backups: [],
    legacy: [],
    mcpStores: [],
    index: { facts: { reads: [], lines: [], rejected: [], unreadable: [] }, stale: [] },
    records: { live: new Map(), unreadable: [], scanFailures: [] },
    usageEntries: [],
    warning: { warn: false, perVolume: [], message: null },
    unmeasured: 0,
    client: null,
    narrowedTo: null,
    excludedByRoot: null,
    ...over,
  } as BackupsListing
}

describe('the renderer', () => {
  it('UD70: a leftover in state skeleton lists each empty folder for removal by hand', () => {
    const l = handBuilt({
      parked: [
        {
          ref: { root: '/r', areaDir: '/r/.skillsmith-parked', origin: 'root', skillsRoot: '/r' },
          absent: false,
          refused: null,
          rows: [],
          leftovers: [
            {
              leftover: {
                S: '/r/.skillsmith-parked/.prune-0123456789abcdef',
                state: 'skeleton',
                unapproved: [],
                skeletons: ['/r/.skillsmith-parked/.prune-0123456789abcdef/a', '/x/b'],
              },
              resumeOffered: false,
            },
          ],
          orphanSidecars: [],
          anomalies: [],
        },
      ],
    })
    const text = renderListing(l).join('\n')
    expect(text).toContain(
      'empty folder a resume left, remove by hand: /r/.skillsmith-parked/.prune-0123456789abcdef/a'
    )
    expect(text).toContain('remove by hand: /x/b')
    expect(text).toContain('unfinished prune (skeleton)')
  })

  it('"N entries could not be measured" prints whenever N > 0', () => {
    expect(renderListing(handBuilt({ unmeasured: 2 })).join('\n')).toContain(
      '2 entries could not be measured.'
    )
    expect(renderListing(handBuilt({ unmeasured: 1 })).join('\n')).toContain(
      '1 entry could not be measured.'
    )
    expect(renderListing(handBuilt({ unmeasured: 0 })).join('\n')).not.toContain(
      'could not be measured'
    )
  })
})
