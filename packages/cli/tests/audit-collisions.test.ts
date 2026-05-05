/**
 * @fileoverview SMI-4590 Wave 4 PR 5/6 — `sklx audit collisions` tests
 * @module @skillsmith/cli/tests/audit-collisions
 *
 * Coverage:
 *
 * Typed-confirmation gate (`requireConfirmationPhrase`) — load-bearing per
 * plan §235-239. Strict literal equality, NO normalization.
 *   1. Exact phrase   ('APPLY ALL')              — RESOLVES.
 *   2. Single-letter  ('Y')                      — REJECTS.
 *   3. Lowercase word ('yes')                    — REJECTS.
 *   4. Lowercase phrase ('apply all')            — REJECTS.
 *   5. No-space variant ('APPLYALL')             — REJECTS.
 *   6. Trailing whitespace ('APPLY ALL ')        — REJECTS (no trim).
 *   7. Empty string                              — REJECTS.
 *
 * Both interactive (TTY) and piped-stdin paths route through the same
 * `@inquirer/prompts` `input()` call, so the rejection invariant holds for
 * both. We mock `input` to assert the contract — the prompt library
 * receives the answer verbatim and our code applies strict equality.
 *
 * Interactive prompt loop (`runInteractiveLoop`):
 *   8.  'apply' choice  → applyOneSuggestion called, status=applied.
 *   9.  'skip'  choice  → outcome recorded as skipped, no apply call.
 *   10. 'edit'  choice  → input prompts for custom name, applyRename
 *                          receives `customName`.
 *   11. 'quit'  choice  → loop terminates early; remaining suggestions
 *                          are NOT processed.
 *   12. Empty suggestion list → prints "No collisions found." and returns.
 *
 * Reset-ledger flow (`runResetLedger`):
 *   13. Backs up an existing ledger to `~/.skillsmith/backups/ledger-*.json`
 *       BEFORE clearing.
 *   14. No backup file when no prior ledger exists.
 *   15. Confirmation phrase mismatch → throws, NO writeLedger call.
 *
 * `--json` output (`runAuditCollisions`):
 *   16. JSON mode prints `RunInventoryAuditResult` to stdout, no prompts,
 *       no apply.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

// ============================================================================
// Mock setup — must precede source imports.
// ============================================================================

const mocks = vi.hoisted(() => ({
  input: vi.fn(),
  select: vi.fn(),
  applyRename: vi.fn(),
  readLedger: vi.fn(),
  writeLedger: vi.fn(),
  runInventoryAudit: vi.fn(),
  getLicenseStatus: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  input: (opts: unknown) => mocks.input(opts),
  select: (opts: unknown) => mocks.select(opts),
}))

vi.mock('@skillsmith/mcp-server/audit', () => ({
  applyRename: (opts: unknown) => mocks.applyRename(opts),
  readLedger: () => mocks.readLedger(),
  writeLedger: (data: unknown) => mocks.writeLedger(data),
  runInventoryAudit: (opts: unknown) => mocks.runInventoryAudit(opts),
  NAMESPACE_OVERRIDES_CURRENT_VERSION: 1,
}))

vi.mock('../src/utils/license.js', () => ({
  getLicenseStatus: () => mocks.getLicenseStatus(),
}))

import {
  requireConfirmationPhrase,
  runResetLedger,
  runInteractiveLoop,
  runAuditCollisions,
  APPLY_ALL_PHRASE,
  RESET_LEDGER_PHRASE,
  CONFIRMATION_REJECTED_MESSAGE,
} from '../src/commands/audit-collisions.js'

// ============================================================================
// Helpers
// ============================================================================

function makeSuggestion(id: string, currentName: string, suggested: string) {
  return {
    collisionId: id,
    currentName,
    suggested,
    reason: `mock-reason-${id}`,
    targetMtime: 0,
    siblingMtime: 0,
  }
}

interface MockAudit {
  auditId: string
  reportPath: string
  renameSuggestions: ReturnType<typeof makeSuggestion>[]
}

function makeAudit(overrides: Partial<MockAudit> = {}): MockAudit {
  return {
    auditId: '01HMOCKAUDITID000000000000',
    reportPath: '/tmp/audit-report.md',
    renameSuggestions: [],
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-4590 Wave 4 PR 5/6 — sklx audit collisions', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.applyRename.mockResolvedValue({ success: true, summary: 'renamed' })
    mocks.readLedger.mockResolvedValue({ version: 1, overrides: [] })
    mocks.writeLedger.mockResolvedValue(undefined)
    mocks.getLicenseStatus.mockResolvedValue({ tier: 'team' })
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  describe('typed-confirmation gate (plan §235-239)', () => {
    it('resolves on exact APPLY ALL match', async () => {
      mocks.input.mockResolvedValueOnce(APPLY_ALL_PHRASE)
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).resolves.toBeUndefined()
    })

    it('rejects single-letter Y', async () => {
      mocks.input.mockResolvedValueOnce('Y')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('rejects lowercase yes', async () => {
      mocks.input.mockResolvedValueOnce('yes')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('rejects lowercase apply all (case-sensitive)', async () => {
      mocks.input.mockResolvedValueOnce('apply all')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('rejects no-space APPLYALL', async () => {
      mocks.input.mockResolvedValueOnce('APPLYALL')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('rejects trailing whitespace (no trim)', async () => {
      mocks.input.mockResolvedValueOnce('APPLY ALL ')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('rejects empty string', async () => {
      mocks.input.mockResolvedValueOnce('')
      await expect(requireConfirmationPhrase(APPLY_ALL_PHRASE, 'msg')).rejects.toThrow(
        CONFIRMATION_REJECTED_MESSAGE
      )
    })

    it('resolves on exact RESET LEDGER match', async () => {
      mocks.input.mockResolvedValueOnce(RESET_LEDGER_PHRASE)
      await expect(requireConfirmationPhrase(RESET_LEDGER_PHRASE, 'msg')).resolves.toBeUndefined()
    })
  })

  describe('interactive prompt loop choices', () => {
    it("'apply' choice triggers applyRename", async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'foo/bar', 'foo/bar-2')],
      })
      mocks.select.mockResolvedValueOnce('apply')
      await runInteractiveLoop(audit as never)
      expect(mocks.applyRename).toHaveBeenCalledTimes(1)
      expect(mocks.applyRename.mock.calls[0]?.[0]).toMatchObject({
        request: { action: 'apply', auditId: audit.auditId },
      })
    })

    it("'skip' choice records skipped outcome and does NOT call applyRename", async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'foo/bar', 'foo/bar-2')],
      })
      mocks.select.mockResolvedValueOnce('skip')
      await runInteractiveLoop(audit as never)
      expect(mocks.applyRename).not.toHaveBeenCalled()
    })

    it("'edit' choice forwards customName to applyRename", async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'foo/bar', 'foo/bar-2')],
      })
      mocks.select.mockResolvedValueOnce('edit')
      mocks.input.mockResolvedValueOnce('  custom-renamed  ')
      await runInteractiveLoop(audit as never)
      expect(mocks.applyRename).toHaveBeenCalledWith({
        suggestion: expect.objectContaining({ collisionId: 'c1' }),
        request: {
          action: 'apply',
          auditId: audit.auditId,
          customName: 'custom-renamed',
        },
      })
    })

    it("'quit' choice terminates the loop early", async () => {
      const audit = makeAudit({
        renameSuggestions: [
          makeSuggestion('c1', 'foo/bar', 'foo/bar-2'),
          makeSuggestion('c2', 'foo/baz', 'foo/baz-2'),
        ],
      })
      mocks.select.mockResolvedValueOnce('quit')
      await runInteractiveLoop(audit as never)
      // Loop aborted before processing any suggestion → applyRename never called.
      expect(mocks.applyRename).not.toHaveBeenCalled()
      // And select was only consulted once (for the first suggestion before quit).
      expect(mocks.select).toHaveBeenCalledTimes(1)
    })

    it('empty suggestions prints No collisions found and returns', async () => {
      const audit = makeAudit({ renameSuggestions: [] })
      await runInteractiveLoop(audit as never)
      expect(mocks.select).not.toHaveBeenCalled()
      expect(mocks.applyRename).not.toHaveBeenCalled()
    })
  })

  describe('--reset-ledger flow', () => {
    let tmpHome: string
    let originalHome: string | undefined

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(join(os.tmpdir(), 'sklx-test-home-'))
      originalHome = process.env['HOME']
      process.env['HOME'] = tmpHome
    })

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome
      } else {
        delete process.env['HOME']
      }
      fs.rmSync(tmpHome, { recursive: true, force: true })
    })

    it('backs up an existing ledger before clearing', async () => {
      const ledgerDir = join(tmpHome, '.skillsmith')
      fs.mkdirSync(ledgerDir, { recursive: true })
      const ledgerFile = join(ledgerDir, 'namespace-overrides.json')
      fs.writeFileSync(ledgerFile, '{"version":1,"overrides":[{"id":"x"}]}', 'utf-8')

      mocks.input.mockResolvedValueOnce(RESET_LEDGER_PHRASE)
      await runResetLedger()

      // Backup file written.
      const backupsDir = join(ledgerDir, 'backups')
      expect(fs.existsSync(backupsDir)).toBe(true)
      const entries = fs.readdirSync(backupsDir).filter((f) => f.startsWith('ledger-'))
      expect(entries.length).toBe(1)
      // Backup contains the original payload.
      const backup = fs.readFileSync(join(backupsDir, entries[0] as string), 'utf-8')
      expect(backup).toContain('"id":"x"')
      // writeLedger called with empty overrides.
      expect(mocks.writeLedger).toHaveBeenCalledWith({
        version: 1,
        overrides: [],
      })
    })

    it('no backup file when no prior ledger exists', async () => {
      mocks.input.mockResolvedValueOnce(RESET_LEDGER_PHRASE)
      await runResetLedger()
      const backupsDir = join(tmpHome, '.skillsmith', 'backups')
      // backupsDir may not exist at all when no source ledger present.
      const entries = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []
      expect(entries.length).toBe(0)
      expect(mocks.writeLedger).toHaveBeenCalledWith({
        version: 1,
        overrides: [],
      })
    })

    it('confirmation mismatch throws and does NOT call writeLedger', async () => {
      mocks.input.mockResolvedValueOnce('reset ledger') // wrong case
      await expect(runResetLedger()).rejects.toThrow(CONFIRMATION_REJECTED_MESSAGE)
      expect(mocks.writeLedger).not.toHaveBeenCalled()
    })
  })

  describe('--reset-ledger preflight (plan §297)', () => {
    let tmpHome: string
    let originalHome: string | undefined

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(join(os.tmpdir(), 'sklx-test-home-'))
      originalHome = process.env['HOME']
      process.env['HOME'] = tmpHome
    })

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome
      } else {
        delete process.env['HOME']
      }
      fs.rmSync(tmpHome, { recursive: true, force: true })
    })

    it('reads the ledger BEFORE prompting (so version_unsupported errors surface first)', async () => {
      // Simulate a higher-version ledger by having readLedger throw.
      const versionError = new Error('namespace.ledger.version_unsupported')
      mocks.readLedger.mockRejectedValueOnce(versionError)

      await expect(
        runAuditCollisions({
          deep: false,
          json: false,
          applyAll: false,
          reportOnly: false,
          resetLedger: true,
        })
      ).rejects.toThrow('namespace.ledger.version_unsupported')

      // The user was never prompted because readLedger threw first.
      expect(mocks.input).not.toHaveBeenCalled()
      expect(mocks.writeLedger).not.toHaveBeenCalled()
    })
  })

  describe('--apply-all end-to-end (typed gate + sequential apply)', () => {
    it('applies every suggestion sequentially after APPLY ALL phrase', async () => {
      const audit = makeAudit({
        renameSuggestions: [
          makeSuggestion('c1', 'a/x', 'a/x-2'),
          makeSuggestion('c2', 'a/y', 'a/y-2'),
          makeSuggestion('c3', 'a/z', 'a/z-2'),
        ],
      })
      mocks.runInventoryAudit.mockResolvedValueOnce(audit)
      mocks.input.mockResolvedValueOnce(APPLY_ALL_PHRASE)

      await runAuditCollisions({
        deep: false,
        json: false,
        applyAll: true,
        reportOnly: false,
        resetLedger: false,
      })

      // applyRename invoked once per suggestion.
      expect(mocks.applyRename).toHaveBeenCalledTimes(3)
      expect(mocks.select).not.toHaveBeenCalled()
    })

    it('rejects --apply-all when phrase is wrong; no applyRename calls', async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'a/x', 'a/x-2')],
      })
      mocks.runInventoryAudit.mockResolvedValueOnce(audit)
      mocks.input.mockResolvedValueOnce('apply all') // wrong case

      await expect(
        runAuditCollisions({
          deep: false,
          json: false,
          applyAll: true,
          reportOnly: false,
          resetLedger: false,
        })
      ).rejects.toThrow(CONFIRMATION_REJECTED_MESSAGE)

      expect(mocks.applyRename).not.toHaveBeenCalled()
    })
  })

  describe('interactive default is `skip` (regression guard for inattentive Enter-press)', () => {
    it('defaults the select prompt to `skip` not `apply`', async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'a/x', 'a/x-2')],
      })
      // Capture the options passed to select.
      let capturedOpts: { default?: string } | undefined
      mocks.select.mockImplementationOnce((opts: unknown) => {
        capturedOpts = opts as { default?: string }
        return Promise.resolve('skip')
      })

      await runInteractiveLoop(audit as never)

      expect(capturedOpts).toBeDefined()
      expect(capturedOpts?.default).toBe('skip')
    })
  })

  describe('--json output', () => {
    it('prints RunInventoryAuditResult JSON and skips prompts', async () => {
      const audit = makeAudit({
        renameSuggestions: [makeSuggestion('c1', 'foo/bar', 'foo/bar-2')],
      })
      mocks.runInventoryAudit.mockResolvedValueOnce(audit)

      await runAuditCollisions({
        deep: false,
        json: true,
        applyAll: false,
        reportOnly: false,
        resetLedger: false,
      })

      // No prompts consulted.
      expect(mocks.input).not.toHaveBeenCalled()
      expect(mocks.select).not.toHaveBeenCalled()
      expect(mocks.applyRename).not.toHaveBeenCalled()

      // Last console.log call should contain serialized JSON of audit.
      const calls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? ''))
      const jsonOutput = calls.find((c: string) => c.includes(audit.auditId))
      expect(jsonOutput).toBeDefined()
      // Parse and check shape.
      const parsed = JSON.parse(jsonOutput as string) as { auditId: string }
      expect(parsed.auditId).toBe(audit.auditId)
    })
  })
})
