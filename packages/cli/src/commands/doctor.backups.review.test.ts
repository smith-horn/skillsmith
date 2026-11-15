/**
 * @fileoverview The governance round-2 findings on `skillsmith doctor backups`
 * (SMI-6531 step 6c-ii-a): what `--client` left out is counted and said (F2), a
 * kept tree's protection reads unknown when its records could not be read and
 * not "no record" (F4), and a root whose real path could not be resolved is not
 * labelled "mounted" (F10).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupsListing } from '@skillsmith/core'
import { runDoctorBackups } from './doctor.backups.js'
import { renderListing } from './doctor.backups.render.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'

let base = ''
let out: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-backups-rev-')))
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

const claude = (): string => path.join(base, 'clients', 'claude-code')
const run = (o: Parameters<typeof runDoctorBackups>[0] = {}) =>
  runDoctorBackups({ discovery: hermeticDiscovery(base, true), ...o })

const planted = (): string => {
  const state = path.join(base, '.skillsmith')
  for (const c of ['claude-code', 'cursor']) {
    fs.mkdirSync(path.join(state, 'backups', 'update', c, 'rk', 'foo', 'op-1'), {
      recursive: true,
    })
  }
  return state
}

describe('F2: --client says what it left out', () => {
  it('the text names the excluded trees, and --json carries the counts', async () => {
    const state = planted()
    await run({ stateRoot: state, client: 'cursor' })
    const text = out.join('\n')
    expect(text).not.toContain('claude-code: foo')
    expect(text).toContain('Excluded by --client')
    expect(text).toContain('1 kept backup tree')
    out = []
    await run({ stateRoot: state, client: 'cursor', json: true })
    const doc = JSON.parse(out.join('\n')) as { excludedByClient: Record<string, number> | null }
    expect(doc.excludedByClient).toEqual({ parkedCopies: 0, backupTrees: 1, otherEntries: 0 })
  })

  it('an anomaly in a hidden area is counted, and the text names every kind it counts', async () => {
    const state = planted()
    fs.writeFileSync(path.join(state, 'backups', 'update', 'claude-code', 'rk', 'foo', '.x'), 'x')
    await run({ stateRoot: state, client: 'cursor' })
    expect(out.join('\n')).toContain(
      '1 kept backup tree, 1 temp, leftover, orphan sidecar, anomaly or refused area.'
    )
  })

  it('no --client: no such line, and the json field is null', async () => {
    const state = planted()
    await run({ stateRoot: state })
    expect(out.join('\n')).not.toContain('Excluded by --client')
    out = []
    await run({ stateRoot: state, json: true })
    expect(
      (JSON.parse(out.join('\n')) as { excludedByClient: unknown }).excludedByClient
    ).toBeNull()
  })
})

describe('the ledger: what could not be measured is named', () => {
  it('an unreadable parked index: the text names it with its reason, and --json lists it', async () => {
    const state = planted()
    const idx = path.join(state, 'parked-index.jsonl')
    fs.mkdirSync(idx)
    await run({ stateRoot: state })
    const text = out.join('\n')
    expect(text).toContain('1 entry could not be measured.')
    expect(text).toContain(`  ${idx}: parked index unreadable (EISDIR)`)
    out = []
    await run({ stateRoot: state, json: true })
    const doc = JSON.parse(out.join('\n')) as {
      accounting: { unmeasured: { path: string }[]; exempt: { path: string; reason: string }[] }
    }
    expect(doc.accounting.unmeasured.map((u) => u.path)).toEqual([idx])
    expect(doc.accounting.exempt.every((e) => e.reason === 'absent')).toBe(true)
  })

  it('control: a readable index names nothing unmeasured', async () => {
    const state = planted()
    await run({ stateRoot: state, json: true })
    const doc = JSON.parse(out.join('\n')) as { accounting: { unmeasured: unknown[] } }
    expect(doc.accounting.unmeasured).toEqual([])
  })
})

describe('F4: protection that cannot be established is unknown', () => {
  it('the text and the json say unknown, with the reason', async () => {
    const state = planted()
    fs.mkdirSync(claude(), { recursive: true })
    fs.writeFileSync(path.join(claude(), '.skillsmith-staging'), 'not a directory')
    await run({ stateRoot: state })
    expect(out.join('\n')).toMatch(/protection unknown: records under .* could not be read/)
    out = []
    await run({ stateRoot: state, json: true })
    const doc = JSON.parse(out.join('\n')) as {
      backups: { areas: { trees: { protection: { status: string; reason?: string } }[] }[] }[]
    }
    const trees = doc.backups.flatMap((s) => s.areas.flatMap((a) => a.trees))
    expect(trees.length).toBeGreaterThan(0)
    for (const t of trees) {
      expect(t.protection.status).toBe('unknown')
      expect(t.protection.reason).toMatch(/could not be read/)
    }
  })

  it('with every record read and none naming the tree, the line says nothing is protecting it', async () => {
    const state = planted()
    await run({ stateRoot: state })
    expect(out.join('\n')).not.toContain('protection unknown')
    expect(out.join('\n')).toContain('no update record protects it')
  })
})

/** A listing with one parked row whose classification is given. */
function withParkedRow(klass: string, reason: string | null): BackupsListing {
  const row = {
    copy: { copyPath: '/r/.skillsmith-parked/op/x-12345678', name: 'x-12345678', opId: 'op' },
    classification: { klass, reason, detail: null, sidecar: null },
    kind: null,
    origin: null,
    createdMs: null,
    ageDays: null,
    index: 'missing',
    allocatedBytes: 0,
    apparentBytes: 0,
    unmeasured: 0,
  }
  return {
    discovery: { stateRoots: ['/s'], roots: [], skipped: [] },
    parked: [
      {
        ref: { root: '/r', areaDir: '/r/.skillsmith-parked', origin: 'root', skillsRoot: '/r' },
        absent: false,
        refused: null,
        rows: [row],
        leftovers: [],
        orphanSidecars: [],
        anomalies: [],
      },
    ],
    backups: [],
    legacy: [],
    mcpStores: [],
    index: { facts: { reads: [], lines: [], rejected: [], unreadable: [] }, stale: [] },
    records: { live: new Map(), unreadable: [], scanFailures: [] },
    accounting: { rows: [], duplicates: [] },
    usageEntries: [],
    warning: { warn: false, perVolume: [], message: null },
    unmeasured: 0,
    client: null,
    narrowedTo: null,
    excludedByRoot: null,
    excludedByClient: null,
  } as unknown as BackupsListing
}

describe('F10: a root that could not be resolved is not called mounted', () => {
  it('realpath-failed reads "could not be resolved"; a real mount still reads mounted', () => {
    const lost = renderListing(withParkedRow('mounted', 'realpath-failed')).join('\n')
    expect(lost).toContain('could not be resolved')
    expect(lost).not.toMatch(/\bmounted\b/)
    const real = renderListing(withParkedRow('mounted', 'mount-point')).join('\n')
    expect(real).toContain('mounted (mount-point)')
  })
})
