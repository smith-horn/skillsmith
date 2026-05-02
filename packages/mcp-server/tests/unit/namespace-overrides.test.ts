/**
 * Unit tests for SMI-4588 Wave 2 Step 1 — namespace-overrides ledger.
 * PR #1 of the Wave 2 stack.
 *
 * Coverage (8 cases per plan §Step 1 + §Tests `namespace-overrides.test.ts`):
 *   1. Read empty / missing file returns an empty ledger.
 *   2. Append + read round-trip preserves entries.
 *   3. `version > CURRENT_VERSION` returns typed
 *      `namespace.ledger.version_unsupported` (NOT silently empty).
 *   4. Concurrent-write boundary (last-write-wins on a single process).
 *   5. Malformed JSON returns the typed `namespace.ledger.malformed`
 *      discriminator (and `readLedger` warns + degrades to empty).
 *   6. Atomic write semantics — no `.tmp` file remains after success.
 *   7. Idempotency — appending the same entry twice is detected.
 *   8. Round-trip preserves ULID order (insertion order).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  appendOverride,
  findOverride,
  readLedger,
  readLedgerResult,
  writeLedger,
} from '../../src/audit/namespace-overrides.js'
import {
  CURRENT_VERSION,
  type OverrideRecord,
  type OverridesLedger,
} from '../../src/audit/namespace-overrides.types.js'

let TEST_HOME: string
let LEDGER_PATH: string

beforeEach(() => {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-overrides-'))
  LEDGER_PATH = path.join(TEST_HOME, '.skillsmith', 'namespace-overrides.json')
})

afterEach(() => {
  if (TEST_HOME && fs.existsSync(TEST_HOME)) {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function makeOverrideInput(
  overrides: Partial<Omit<OverrideRecord, 'id' | 'appliedAt'>> = {}
): Omit<OverrideRecord, 'id' | 'appliedAt'> {
  return {
    skillId: 'anthropic/code-helper',
    kind: 'command',
    originalIdentifier: '/ship',
    renamedTo: '/anthropic-ship',
    originalPath: '/Users/test/.claude/commands/ship.md',
    renamedPath: '/Users/test/.claude/commands/anthropic-ship.md',
    auditId: '01HXYAUDIT00000000000000000',
    reason: 'collision with skillsmith/release-tools /ship',
    ...overrides,
  }
}

describe('readLedger / readLedgerResult', () => {
  it('returns an empty ledger when the file does not exist (case 1)', async () => {
    expect(fs.existsSync(LEDGER_PATH)).toBe(false)
    const ledger = await readLedger({ ledgerPath: LEDGER_PATH })
    expect(ledger.version).toBe(CURRENT_VERSION)
    expect(ledger.overrides).toEqual([])
  })

  it('readLedgerResult also returns ok+empty for missing file', async () => {
    const result = await readLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.ledger.overrides).toEqual([])
    }
  })

  it('throws a typed error when version is greater than CURRENT_VERSION (case 3)', async () => {
    await fsp.mkdir(path.dirname(LEDGER_PATH), { recursive: true })
    await fsp.writeFile(LEDGER_PATH, JSON.stringify({ version: 99, overrides: [] }))

    // readLedgerResult: returns the typed discriminator, not silent empty.
    const result = await readLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(result.kind).toBe('namespace.ledger.version_unsupported')
    if (result.kind === 'namespace.ledger.version_unsupported') {
      expect(result.found).toBe(99)
      expect(result.expected).toBe(CURRENT_VERSION)
    }

    // readLedger: throws (does NOT silently degrade) — plan §2 Edit 6.
    await expect(readLedger({ ledgerPath: LEDGER_PATH })).rejects.toMatchObject({
      kind: 'namespace.ledger.version_unsupported',
      found: 99,
      expected: CURRENT_VERSION,
    })
  })

  it('returns malformed discriminator for invalid JSON; readLedger warns + degrades (case 5)', async () => {
    await fsp.mkdir(path.dirname(LEDGER_PATH), { recursive: true })
    await fsp.writeFile(LEDGER_PATH, '{not json at all')

    const typedResult = await readLedgerResult({ ledgerPath: LEDGER_PATH })
    expect(typedResult.kind).toBe('namespace.ledger.malformed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ledger = await readLedger({ ledgerPath: LEDGER_PATH })
    expect(ledger.overrides).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/ledger malformed/)
  })
})

describe('writeLedger + readLedger round-trip', () => {
  it('round-trips a single appended entry (case 2)', async () => {
    const empty = await readLedger({ ledgerPath: LEDGER_PATH })
    const updated = appendOverride(empty, makeOverrideInput())
    await writeLedger(updated, { ledgerPath: LEDGER_PATH })

    const restored = await readLedger({ ledgerPath: LEDGER_PATH })
    expect(restored.overrides).toHaveLength(1)
    const entry = restored.overrides[0]!
    expect(entry.originalIdentifier).toBe('/ship')
    expect(entry.renamedTo).toBe('/anthropic-ship')
    expect(entry.id).toMatch(/^ovr_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(entry.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('atomic write — no .tmp file remains after success (case 6)', async () => {
    const empty = await readLedger({ ledgerPath: LEDGER_PATH })
    const updated = appendOverride(empty, makeOverrideInput())
    await writeLedger(updated, { ledgerPath: LEDGER_PATH })

    // Writer uses a unique-suffix tmp filename per call (concurrency
    // hardening). Assert no stray `*.tmp` file remains in the ledger
    // directory after a successful write.
    const dir = path.dirname(LEDGER_PATH)
    const stragglers = fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))
    expect(stragglers).toEqual([])
    expect(fs.existsSync(LEDGER_PATH)).toBe(true)
  })

  it('preserves insertion order across round-trip (case 8)', async () => {
    let ledger = await readLedger({ ledgerPath: LEDGER_PATH })
    ledger = appendOverride(ledger, makeOverrideInput({ originalIdentifier: '/first' }))
    ledger = appendOverride(ledger, makeOverrideInput({ originalIdentifier: '/second' }))
    ledger = appendOverride(ledger, makeOverrideInput({ originalIdentifier: '/third' }))
    await writeLedger(ledger, { ledgerPath: LEDGER_PATH })

    const restored = await readLedger({ ledgerPath: LEDGER_PATH })
    expect(restored.overrides.map((o) => o.originalIdentifier)).toEqual([
      '/first',
      '/second',
      '/third',
    ])
  })

  it('concurrent writes — last-write-wins on a single process (case 4)', async () => {
    // Two writers race on the same ledger path. The atomic
    // tmp+rename strategy guarantees the file is never corrupt; one of
    // the two writes wins. We assert the winning ledger validates and
    // contains exactly one of the two entries (not interleaved bytes).
    const writerA = (async () => {
      const ledger = await readLedger({ ledgerPath: LEDGER_PATH })
      const next = appendOverride(ledger, makeOverrideInput({ originalIdentifier: '/A' }))
      await writeLedger(next, { ledgerPath: LEDGER_PATH })
    })()
    const writerB = (async () => {
      const ledger = await readLedger({ ledgerPath: LEDGER_PATH })
      const next = appendOverride(ledger, makeOverrideInput({ originalIdentifier: '/B' }))
      await writeLedger(next, { ledgerPath: LEDGER_PATH })
    })()
    await Promise.all([writerA, writerB])

    // File must parse cleanly — no half-written JSON.
    const restored = await readLedger({ ledgerPath: LEDGER_PATH })
    const ids = restored.overrides.map((o) => o.originalIdentifier).sort()
    // Last-write-wins on a single event loop: one writer's snapshot
    // overwrites the other. The surviving ledger contains exactly one
    // of /A or /B — never both, never neither, never garbage.
    expect(ids.length).toBe(1)
    expect(['/A', '/B']).toContain(ids[0])
  })
})

describe('appendOverride', () => {
  it('returns a new ledger; the input is not mutated', () => {
    const initial: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    const next = appendOverride(initial, makeOverrideInput())
    expect(initial.overrides).toEqual([]) // input untouched
    expect(next.overrides).toHaveLength(1)
    expect(next).not.toBe(initial)
  })

  it('detects duplicates by (skillId, kind, originalIdentifier, renamedTo) — case 7 idempotency', () => {
    const initial: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    const once = appendOverride(initial, makeOverrideInput())
    const twice = appendOverride(once, makeOverrideInput())
    expect(twice.overrides).toHaveLength(1)
    // Identity check: duplicate append returns the unchanged ledger by reference.
    expect(twice).toBe(once)
  })

  it('treats different renamedTo for the same identifier as a new entry', () => {
    const initial: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    const a = appendOverride(initial, makeOverrideInput({ renamedTo: '/anthropic-ship' }))
    const b = appendOverride(a, makeOverrideInput({ renamedTo: '/release-ship' }))
    expect(b.overrides).toHaveLength(2)
  })

  it('generates ULID-prefixed ids and ISO timestamps', () => {
    const initial: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    const next = appendOverride(initial, makeOverrideInput())
    const entry = next.overrides[0]!
    expect(entry.id).toMatch(/^ovr_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(() => new Date(entry.appliedAt).toISOString()).not.toThrow()
  })
})

describe('findOverride', () => {
  it('returns the matching record when (skillId, kind, originalIdentifier) all match', () => {
    let ledger: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    ledger = appendOverride(ledger, makeOverrideInput())
    const match = findOverride(ledger, {
      skillId: 'anthropic/code-helper',
      kind: 'command',
      originalIdentifier: '/ship',
    })
    expect(match).not.toBeNull()
    expect(match?.renamedTo).toBe('/anthropic-ship')
  })

  it('returns null when no match exists', () => {
    const ledger: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    const match = findOverride(ledger, { originalIdentifier: '/nonexistent' })
    expect(match).toBeNull()
  })

  it('matches identifier-only when skillId/kind are omitted', () => {
    let ledger: OverridesLedger = { version: CURRENT_VERSION, overrides: [] }
    ledger = appendOverride(ledger, makeOverrideInput({ skillId: null }))
    const match = findOverride(ledger, { originalIdentifier: '/ship' })
    expect(match?.skillId).toBeNull()
  })
})
