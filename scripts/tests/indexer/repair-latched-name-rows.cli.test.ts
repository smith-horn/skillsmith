/**
 * SMI-5930 Wave 2: CLI arg-parsing + partial-failure exit-status tests for
 * scripts/indexer/repair-latched-name-rows.ts / .cli.ts.
 *
 * Split out of repair-latched-name-rows.test.ts to stay under the 500-line
 * CI gate, mirroring the source split (repair-latched-name-rows.cli.ts) --
 * these are exactly the code-review-finding (MEDIUM) cases: a value-taking
 * flag must reject a missing or flag-like value rather than silently
 * misinterpreting it, --batch-size must reject non-integer input rather
 * than silently flooring or falling back to the default, and a run with any
 * failed batch must surface that in `result.errors` so the CLI entrypoint
 * can set a non-zero exit code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runRepair,
  MIN_BATCH_SIZE,
  isFlagLikeToken,
  parseLogPathArg,
  parseBatchSizeArg,
  type RepairDbDeps,
} from '../../indexer/repair-latched-name-rows.ts'

function makeIds(n: number, prefix = 'id'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`)
}

describe('isFlagLikeToken', () => {
  it('true for a token starting with --', () => {
    expect(isFlagLikeToken('--apply')).toBe(true)
  })

  it('false for a plain value, and false for undefined', () => {
    expect(isFlagLikeToken('/tmp/out.jsonl')).toBe(false)
    expect(isFlagLikeToken(undefined)).toBe(false)
  })
})

describe('parseLogPathArg (code-review finding, MEDIUM)', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseLogPathArg(['--apply'])).toBeUndefined()
  })

  it('parses the --log-path=<path> attached form', () => {
    expect(parseLogPathArg(['--log-path=/tmp/out.jsonl'])).toBe('/tmp/out.jsonl')
  })

  it('parses the --log-path <path> space-separated form', () => {
    expect(parseLogPathArg(['--log-path', '/tmp/out.jsonl'])).toBe('/tmp/out.jsonl')
  })

  it('throws instead of silently taking the next flag as the path value (the original bug)', () => {
    expect(() => parseLogPathArg(['--log-path', '--apply'])).toThrow(/flag-like/)
  })

  it('throws when --log-path is the last token with no value at all', () => {
    expect(() => parseLogPathArg(['--log-path'])).toThrow(/requires a non-empty value/)
  })

  it('throws on --log-path= (empty string via the attached form) — PR-review finding, BLOCKING', () => {
    // The `=` form's empty-string case previously bypassed the
    // missing/flag-like guard entirely (that guard only ran for the
    // bare-next-token form), and runRepair's `opts.logPath ?? defaultLogPath()`
    // does not substitute on an empty string (only null/undefined) -- so an
    // empty log path used to survive all the way to appendBatchLog, which
    // fails only AFTER that batch's UPDATE has already committed against prod.
    expect(() => parseLogPathArg(['--log-path='])).toThrow(/requires a non-empty value/)
    expect(() => parseLogPathArg(['--log-path='])).toThrow(/an empty string/)
  })
})

describe('parseBatchSizeArg (code-review finding, MEDIUM)', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseBatchSizeArg(['--apply'])).toBeUndefined()
  })

  it('parses the --batch-size=<n> attached form', () => {
    expect(parseBatchSizeArg(['--batch-size=750'])).toBe(750)
  })

  it('parses the --batch-size <n> space-separated form', () => {
    expect(parseBatchSizeArg(['--batch-size', '750'])).toBe(750)
  })

  it('throws on a fractional value instead of silently flooring it', () => {
    expect(() => parseBatchSizeArg(['--batch-size', '750.5'])).toThrow(/whole number/)
  })

  it('throws on a non-numeric value instead of silently falling back to the default', () => {
    expect(() => parseBatchSizeArg(['--batch-size', 'abc'])).toThrow(/whole number/)
  })

  it('throws when --batch-size is the last token with no value at all', () => {
    expect(() => parseBatchSizeArg(['--batch-size'])).toThrow(/requires a value/)
  })

  it('throws instead of silently taking the next flag as the value', () => {
    expect(() => parseBatchSizeArg(['--batch-size', '--apply'])).toThrow(/requires a value/)
  })
})

// ---------------------------------------------------------------------------
// runRepair — partial-failure exit status (code-review finding, MEDIUM: the
// CLI entrypoint must not exit 0 when any batch failed)
// ---------------------------------------------------------------------------

describe('runRepair — reports errors for the CLI entrypoint to act on', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('result.errors is non-empty when a batch fails, so main() can set a non-zero exit code', async () => {
    const ids = makeIds(4)
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => ids,
      nullContentHashForIds: async () => {
        throw new Error('connection reset by peer')
      },
    }

    const result = await runRepair(db, { apply: true, batchSize: MIN_BATCH_SIZE })

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.updatedIds).toEqual([])
  })

  it('result.errors is empty on a fully successful run', async () => {
    const ids = makeIds(4)
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => ids,
      nullContentHashForIds: async (batch) => [...batch],
    }

    const result = await runRepair(db, { apply: true, batchSize: MIN_BATCH_SIZE })

    expect(result.errors).toEqual([])
    expect(result.updatedIds.sort()).toEqual([...ids].sort())
  })

  it('preflights the log path BEFORE any batch commits — PR-review finding, BLOCKING', async () => {
    // A bad log path used to only fail at the first appendBatchLog call,
    // AFTER that batch's nullContentHashForIds had already run against
    // prod. Point logPath's directory at a path segment that is a plain
    // FILE, not a directory -- mkdir(dirname(logPath), {recursive:true})
    // must throw (ENOTDIR) before nullContentHashForIds is ever called.
    const tmpDir = await mkdtemp(join(tmpdir(), 'smi5930-preflight-'))
    const notADir = join(tmpDir, 'this-is-a-file')
    await writeFile(notADir, 'x')
    const badLogPath = join(notADir, 'subdir', 'log.jsonl')

    const calls: string[][] = []
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => makeIds(10),
      nullContentHashForIds: async (ids) => {
        calls.push([...ids])
        return [...ids]
      },
    }

    await expect(
      runRepair(db, { apply: true, batchSize: MIN_BATCH_SIZE, logPath: badLogPath })
    ).rejects.toThrow()
    expect(calls).toEqual([])

    await rm(tmpDir, { recursive: true, force: true })
  })
})
