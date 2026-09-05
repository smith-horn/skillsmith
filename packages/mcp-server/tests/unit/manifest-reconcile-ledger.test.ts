/**
 * Unit tests for SMI-6343 Wave 4 — manifest-reconcile ledger (C7).
 * Mirrors namespace-overrides.test.ts's coverage shape for the sibling
 * ledger this one is modeled on.
 *
 * Coverage:
 *   1. Read empty / missing file returns an empty ledger.
 *   2. Append + read round-trip preserves entries.
 *   3. `version > CURRENT_LEDGER_VERSION` returns typed
 *      `manifest.reconcile.ledger_version_unsupported` (NOT silently empty).
 *   4. Malformed JSON returns the typed
 *      `manifest.reconcile.ledger_malformed` discriminator (readLedger
 *      warns + degrades to empty).
 *   5. Atomic write semantics — no `.tmp` file remains after success.
 *   6. removeReconcileLedgerEntry is idempotent (removing twice is a no-op).
 *   7. findReconcileLedgerEntriesFor filters by (name, client, manifestPath)
 *      and sorts most-recent-first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  appendReconcileLedgerEntry,
  findReconcileLedgerEntriesFor,
  readReconcileLedger,
  readReconcileLedgerResult,
  removeReconcileLedgerEntry,
  writeReconcileLedger,
} from '../../src/tools/manifest-reconcile-ledger.js'
import { CURRENT_LEDGER_VERSION } from '../../src/tools/manifest-reconcile-ledger.types.js'

let TEST_HOME: string
let LEDGER_PATH: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-reconcile-ledger-'))
  LEDGER_PATH = path.join(TEST_HOME, '.skillsmith', 'manifest-reconcile-ledger.json')
})

afterEach(() => {
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function makeAppendInput(
  overrides: Partial<Parameters<typeof appendReconcileLedgerEntry>[0]> = {}
) {
  return {
    manifestPath: '/home/test/.skillsmith/manifest.json',
    manifestKey: 'my-skill',
    name: 'my-skill',
    client: 'claude-code',
    action: 'mark_local' as const,
    beforeState: { id: 'author/my-skill', name: 'my-skill', source: 'github:author/my-skill' },
    afterState: { id: 'author/my-skill', name: 'my-skill', source: 'unknown', provenance: 'local' },
    reason: 'test',
    ...overrides,
  }
}

describe('readReconcileLedger / readReconcileLedgerResult', () => {
  it('returns an empty ledger when the file does not exist (case 1)', async () => {
    expect(fs.existsSync(LEDGER_PATH)).toBe(false)
    const ledger = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(ledger.version).toBe(CURRENT_LEDGER_VERSION)
    expect(ledger.entries).toEqual([])
  })

  it('readReconcileLedgerResult also returns ok+empty for a missing file', async () => {
    const result = await readReconcileLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.ledger.entries).toEqual([])
    }
  })

  it('returns typed version_unsupported when version > CURRENT_LEDGER_VERSION (case 3)', async () => {
    await fsp.mkdir(path.dirname(LEDGER_PATH), { recursive: true })
    await fsp.writeFile(LEDGER_PATH, JSON.stringify({ version: 99, entries: [] }))

    const result = await readReconcileLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(result.kind).toBe('manifest.reconcile.ledger_version_unsupported')
    if (result.kind === 'manifest.reconcile.ledger_version_unsupported') {
      expect(result.found).toBe(99)
      expect(result.expected).toBe(CURRENT_LEDGER_VERSION)
    }

    // readReconcileLedger: throws (does NOT silently degrade to empty).
    await expect(readReconcileLedger({ ledgerPath: LEDGER_PATH })).rejects.toMatchObject({
      kind: 'manifest.reconcile.ledger_version_unsupported',
      found: 99,
      expected: CURRENT_LEDGER_VERSION,
    })
  })

  it('returns malformed discriminator for invalid JSON; readReconcileLedger warns + degrades (case 4)', async () => {
    await fsp.mkdir(path.dirname(LEDGER_PATH), { recursive: true })
    await fsp.writeFile(LEDGER_PATH, '{not json at all')

    const typedResult = await readReconcileLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(typedResult.kind).toBe('manifest.reconcile.ledger_malformed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ledger = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(ledger.entries).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/ledger malformed/)
  })
})

describe('appendReconcileLedgerEntry + read round-trip', () => {
  it('round-trips a single appended entry (case 2)', async () => {
    const entry = await appendReconcileLedgerEntry(makeAppendInput(), { ledgerPath: LEDGER_PATH })
    expect(entry.id).toMatch(/^mrc_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    const restored = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(restored.entries).toHaveLength(1)
    expect(restored.entries[0]!.name).toBe('my-skill')
    expect(restored.entries[0]!.action).toBe('mark_local')
    expect(restored.entries[0]!.beforeState).toEqual(makeAppendInput().beforeState)
    expect(restored.entries[0]!.afterState).toEqual(makeAppendInput().afterState)
  })

  it('supports a null afterState (drop_entry has no post-write entry)', async () => {
    await appendReconcileLedgerEntry(makeAppendInput({ action: 'drop_entry', afterState: null }), {
      ledgerPath: LEDGER_PATH,
    })
    const restored = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(restored.entries[0]!.afterState).toBeNull()
  })

  it('atomic write — no .tmp file remains after success (case 5)', async () => {
    await appendReconcileLedgerEntry(makeAppendInput(), { ledgerPath: LEDGER_PATH })
    const dir = path.dirname(LEDGER_PATH)
    const stragglers = fs.readdirSync(dir).filter((e) => e.endsWith('.tmp'))
    expect(stragglers).toEqual([])
    expect(fs.existsSync(LEDGER_PATH)).toBe(true)
  })
})

describe('removeReconcileLedgerEntry', () => {
  it('removes the matching entry and is idempotent on a second call (case 6)', async () => {
    const entry = await appendReconcileLedgerEntry(makeAppendInput(), { ledgerPath: LEDGER_PATH })
    await removeReconcileLedgerEntry(entry.id, { ledgerPath: LEDGER_PATH })

    const afterFirst = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(afterFirst.entries).toEqual([])

    // Second removal of the same (now-gone) id must not throw or corrupt
    // the ledger — this is what makes revert idempotent.
    await expect(
      removeReconcileLedgerEntry(entry.id, { ledgerPath: LEDGER_PATH })
    ).resolves.toBeUndefined()
    const afterSecond = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(afterSecond.entries).toEqual([])
  })

  it('leaves other entries untouched', async () => {
    const a = await appendReconcileLedgerEntry(makeAppendInput({ name: 'skill-a' }), {
      ledgerPath: LEDGER_PATH,
    })
    await appendReconcileLedgerEntry(makeAppendInput({ name: 'skill-b' }), {
      ledgerPath: LEDGER_PATH,
    })
    await removeReconcileLedgerEntry(a.id, { ledgerPath: LEDGER_PATH })

    const restored = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    expect(restored.entries).toHaveLength(1)
    expect(restored.entries[0]!.name).toBe('skill-b')
  })
})

describe('findReconcileLedgerEntriesFor', () => {
  it('filters by (name, client, manifestPath) and sorts most-recent-first (case 7)', async () => {
    await appendReconcileLedgerEntry(
      makeAppendInput({ name: 'skill-a', manifestPath: '/home/a/.skillsmith/manifest.json' }),
      { ledgerPath: LEDGER_PATH }
    )
    await new Promise((r) => setTimeout(r, 2))
    await appendReconcileLedgerEntry(
      makeAppendInput({ name: 'skill-a', manifestPath: '/home/a/.skillsmith/manifest.json' }),
      { ledgerPath: LEDGER_PATH }
    )
    // Different manifestPath — must NOT be matched (workspace vs. global scope).
    await appendReconcileLedgerEntry(
      makeAppendInput({
        name: 'skill-a',
        manifestPath: '/home/a/project/.skillsmith/manifest.json',
      }),
      { ledgerPath: LEDGER_PATH }
    )
    // Different name — must NOT be matched.
    await appendReconcileLedgerEntry(
      makeAppendInput({ name: 'skill-b', manifestPath: '/home/a/.skillsmith/manifest.json' }),
      { ledgerPath: LEDGER_PATH }
    )

    const ledger = await readReconcileLedger({ ledgerPath: LEDGER_PATH })
    const matches = findReconcileLedgerEntriesFor(
      ledger,
      'skill-a',
      'claude-code',
      '/home/a/.skillsmith/manifest.json'
    )
    expect(matches).toHaveLength(2)
    // Most-recent-first.
    expect(new Date(matches[0]!.appliedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(matches[1]!.appliedAt).getTime()
    )
  })
})

describe('writeReconcileLedger', () => {
  it('normalizes the written version to CURRENT_LEDGER_VERSION', async () => {
    await writeReconcileLedger(
      { version: CURRENT_LEDGER_VERSION, entries: [] },
      { ledgerPath: LEDGER_PATH }
    )
    const raw = JSON.parse(await fsp.readFile(LEDGER_PATH, 'utf-8'))
    expect(raw.version).toBe(CURRENT_LEDGER_VERSION)
  })
})
