/**
 * SMI-4315 + SMI-4316: hardening tests for pythonIncremental.
 *
 * SMI-4315 — `resolvePythonWasmPath` probes each candidate with
 * `fs.existsSync` instead of always returning `candidates[0]`. Regression
 * test for the package-local-fallback case.
 *
 * SMI-4316 — both silent catches now emit logger.warn. Tests verify:
 *   - `parseSync` catch: rate-limited warn keyed per file; payload is
 *     `{ file, error }` only with error truncated to <=200 chars and no
 *     `stack` field (no source code leak).
 *   - `doInit` catch: one-shot warn per parser instance on init failure.
 *
 * All SUT access goes through a dynamic `import('./pythonIncremental.js')`
 * inside the tests so the vi.mock calls below are applied even when vitest
 * shares its module cache with sibling test files in the same worker.
 * Mixing static `import { X } from './pythonIncremental.js'` with vi.mock
 * against the same module has been observed to bypass the mock when a
 * sibling test file imports the SUT first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRateLimiter } from '../../utils/rate-limit.js'
import type { WebTreeSitterDeps, WebTreeSitterLoader } from './pythonIncremental.js'

// vi.hoisted runs before vi.mock factories; closure-sharing the spy
// objects avoids the createLogger-spy trap (feedback_logger_spy_pattern).
const { loggerSpies, existsSyncMock } = vi.hoisted(() => ({
  loggerSpies: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    auditLog: vi.fn(),
    securityLog: vi.fn(),
  },
  existsSyncMock: vi.fn<(p: string) => boolean>(),
}))

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => loggerSpies,
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) }
})

// Dynamic SUT import so the mocks above definitely apply.
type SUT = typeof import('./pythonIncremental.js')
let SUT_CACHE: SUT | null = null
async function getSUT(): Promise<SUT> {
  if (!SUT_CACHE) SUT_CACHE = await import('./pythonIncremental.js')
  return SUT_CACHE
}

describe('SMI-4315 · resolvePythonWasmPath existsSync probe', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
  })

  it('returns candidates[0] when the workspace-hoist path exists', async () => {
    const { resolvePythonWasmPath } = await getSUT()
    const seen: string[] = []
    existsSyncMock.mockImplementation((p: string) => {
      seen.push(p)
      return true // first candidate hits; loop exits after one probe
    })
    const result = resolvePythonWasmPath()
    expect(result).toMatch(/tree-sitter-python\.wasm$/)
    expect(seen).toHaveLength(1)
    expect(result).toBe(seen[0])
  })

  it('falls back to candidates[1] (package-local) when the hoist is missing', async () => {
    const { resolvePythonWasmPath } = await getSUT()
    const seen: string[] = []
    existsSyncMock.mockImplementation((p: string) => {
      seen.push(p)
      return seen.length === 2 // second candidate exists
    })
    const result = resolvePythonWasmPath()
    expect(result).toBe(seen[1])
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })

  it('returns candidates[0] as a stable error anchor when neither exists', async () => {
    const { resolvePythonWasmPath } = await getSUT()
    const seen: string[] = []
    existsSyncMock.mockImplementation((p: string) => {
      seen.push(p)
      return false
    })
    const result = resolvePythonWasmPath()
    expect(result).toBe(seen[0])
    expect(seen).toHaveLength(2)
  })
})

describe('SMI-4316 · parseSync catch emits rate-limited warn', () => {
  beforeEach(() => {
    loggerSpies.warn.mockReset()
    resetRateLimiter()
    // existsSync returns true so the constructor wasm-path resolution is
    // stable even though we don't actually load WASM in these tests.
    existsSyncMock.mockReturnValue(true)
  })

  afterEach(() => {
    resetRateLimiter()
  })

  /**
   * Build a parser primed with a cached entry whose `tree.edit` throws on
   * re-parse. This drives `parseSync` into the catch without needing a
   * real WASM runtime.
   */
  function primeFailingCache(
    parser: InstanceType<SUT['PythonIncrementalParser']>,
    filePath: string,
    error: Error
  ) {
    const p = parser as unknown as {
      parser: { parse: () => unknown }
      language: unknown
      queries: unknown
      cache: Map<string, { tree: unknown; content: string; lastUsed: number; lastResult: null }>
    }
    // Force `isReady` true with minimal stubs.
    p.parser = { parse: () => ({}) }
    p.language = {}
    p.queries = {}
    p.cache.set(filePath, {
      tree: {
        edit: () => {
          throw error
        },
        delete: () => {},
      },
      content: 'placeholder\n',
      lastUsed: 1,
      lastResult: null,
    })
  }

  it('emits one warn on the first parseSync failure with safe payload', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const parser = new PythonIncrementalParser()
    const filePath = 'a.py'
    primeFailingCache(parser, filePath, new Error('simulated parse failure'))

    const result = parser.parseSync('different content\n', filePath)
    expect(result).toBeNull()
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1)

    const [message, payload] = loggerSpies.warn.mock.calls[0]
    expect(message).toContain('parseSync failed')
    // Strictly { file, error } — no stack, no source content.
    expect(payload).toEqual({
      file: filePath,
      error: 'simulated parse failure',
    })
    expect(Object.keys(payload ?? {}).sort()).toEqual(['error', 'file'])
  })

  it('truncates error messages to <=200 chars (no source code leak)', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const parser = new PythonIncrementalParser()
    const filePath = 'b.py'
    const longMsg = 'E'.repeat(500)
    // Include a newline that contains fake "source" content; the formatter
    // must only keep the first line.
    const faux = new Error(`${longMsg}\nSECRET_API_KEY=sk_live_should_never_appear`)
    primeFailingCache(parser, filePath, faux)

    parser.parseSync('xx\n', filePath)

    const payload = loggerSpies.warn.mock.calls[0][1] as { file: string; error: string }
    expect(payload.error.length).toBeLessThanOrEqual(200)
    expect(payload.error).not.toContain('\n')
    expect(payload.error).not.toContain('SECRET_API_KEY')
  })

  it('rate-limits a hot-loop flood (FIRST_N fire, then 1-in-SAMPLE_EVERY)', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const parser = new PythonIncrementalParser()
    const filePath = 'flood.py'
    // FIRST_N (5) fires; after that, one-in-SAMPLE_EVERY (100) fires.
    // 200 events after the first 5 → 2 sampled hits. Total = 7.
    for (let i = 0; i < 205; i += 1) {
      primeFailingCache(parser, filePath, new Error(`fail ${i}`))
      parser.parseSync(`content ${i}\n`, filePath)
    }
    expect(loggerSpies.warn).toHaveBeenCalledTimes(7)
  })

  it('isolates rate-limit buckets across files', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const parser = new PythonIncrementalParser()
    // Drive hot.py well past its FIRST_N + next sampled boundary (5 + 1 = 6).
    for (let i = 0; i < 50; i += 1) {
      primeFailingCache(parser, 'hot.py', new Error('x'))
      parser.parseSync(`content ${i}\n`, 'hot.py')
    }
    const hotWarns = loggerSpies.warn.mock.calls.length
    // hot.py should have burned FIRST_N=5 + 1 sampled (count=6) = 6 warns.
    expect(hotWarns).toBe(6)
    // cool.py still gets its own FIRST_N budget, so the very first failure
    // emits a warn regardless of what hot.py did.
    primeFailingCache(parser, 'cool.py', new Error('y'))
    parser.parseSync('ctn\n', 'cool.py')
    expect(loggerSpies.warn.mock.calls.length).toBe(hotWarns + 1)
    const cool = loggerSpies.warn.mock.calls.find(
      (c) => (c[1] as { file: string }).file === 'cool.py'
    )
    expect(cool).toBeDefined()
  })
})

describe('SMI-4316 · doInit catch emits one-shot warn', () => {
  beforeEach(() => {
    loggerSpies.warn.mockReset()
    resetRateLimiter()
    existsSyncMock.mockReturnValue(true)
  })

  it('logs a single warn on init failure with wasmPath + error + stack', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const failingLoader: WebTreeSitterLoader = async () => {
      throw new Error('module not found')
    }
    const parser = new PythonIncrementalParser({}, failingLoader)
    const result = await parser.parse('def x(): pass\n', 'fail.py')

    expect(result).toBeNull()
    expect(parser.hasFailedInit).toBe(true)
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1)
    const [message, payload] = loggerSpies.warn.mock.calls[0]
    expect(message).toContain('init failed')
    const p = payload as { wasmPath: string; error: string; stack?: string }
    expect(p.wasmPath).toMatch(/tree-sitter-python\.wasm$/)
    expect(p.error).toBe('module not found')
    expect(typeof p.stack).toBe('string')
  })

  it('does not warn on a successful parse path (no init failure)', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const parser = new PythonIncrementalParser()
    // Mark ready via stubs; we only assert doInit never fired a warn.
    const p = parser as unknown as {
      parser: { parse: () => unknown }
      language: unknown
      queries: unknown
      initFailed: boolean
    }
    p.parser = { parse: () => ({ rootNode: {} }) }
    p.language = {}
    p.queries = {}
    p.initFailed = false
    try {
      parser.parseSync('def ok(): pass\n', 'ok.py')
    } catch {
      // swallow — assertion is on the warn spy, not the parse result.
    }
    const initWarns = loggerSpies.warn.mock.calls.filter((c) =>
      String(c[0]).includes('init failed')
    )
    expect(initWarns).toHaveLength(0)
  })
})

/**
 * SMI-5567 · bounded, jittered retry around the WASM boot.
 *
 * Under full-suite parallel vitest load, many workers boot their own
 * web-tree-sitter runtime concurrently and instantiation transiently fails.
 * `doInit` now retries a bounded number of times with a jittered backoff. These
 * tests drive that path via the injectable `WebTreeSitterLoader` stub — no real
 * WASM — asserting (a) recovery within budget, (b) graceful, diagnosable failure
 * on exhaustion, and (c) that a failed-then-retried attempt neither leaks nor
 * double-instantiates the WASM parser/language (retry-safety, the crux finding).
 */
interface CountingLoaderState {
  initCalls: number
  parserConstructed: number
  parserDeleted: number
  langLoadCalls: number
  languagesCreated: number
}

/**
 * A loader stub that counts every WASM resource it hands out. `initFailUntil`
 * makes `init()` throw while `initCalls < initFailUntil` (so it first succeeds
 * on the Nth call); `langLoadFailUntil` does the same for `Language.load()`
 * (which throws only after a `Parser` has been constructed, exercising the
 * partial-parser-cleanup path).
 */
function makeCountingLoader(opts: { initFailUntil?: number; langLoadFailUntil?: number }): {
  loader: WebTreeSitterLoader
  state: CountingLoaderState
} {
  const state: CountingLoaderState = {
    initCalls: 0,
    parserConstructed: 0,
    parserDeleted: 0,
    langLoadCalls: 0,
    languagesCreated: 0,
  }
  const loader: WebTreeSitterLoader = async () => {
    const ParserStub = class {
      constructor() {
        state.parserConstructed += 1
      }
      setLanguage(): void {}
      parse(): unknown {
        return {}
      }
      delete(): void {
        state.parserDeleted += 1
      }
    }
    const deps = {
      init: async () => {
        state.initCalls += 1
        if (opts.initFailUntil && state.initCalls < opts.initFailUntil) {
          throw new Error(`init boom #${state.initCalls}`)
        }
      },
      Parser: ParserStub,
      Language: {
        load: async () => {
          state.langLoadCalls += 1
          if (opts.langLoadFailUntil && state.langLoadCalls < opts.langLoadFailUntil) {
            throw new Error(`language load boom #${state.langLoadCalls}`)
          }
          state.languagesCreated += 1
          return {}
        },
      },
      // Constructable, args ignored — PythonQuerySet just `new Query(lang, src)`s.
      Query: class {
        constructor(..._args: unknown[]) {
          void _args
        }
      },
    }
    return deps as unknown as WebTreeSitterDeps
  }
  return { loader, state }
}

describe('SMI-5567 · doInit bounded retry', () => {
  beforeEach(() => {
    loggerSpies.warn.mockReset()
    resetRateLimiter()
    existsSyncMock.mockReturnValue(true)
  })

  it('recovers when init() fails N-1 times then succeeds within the budget', async () => {
    const { PythonIncrementalParser } = await getSUT()
    // init fails on calls 1 and 2, succeeds on call 3 (== budget of 3).
    const { loader, state } = makeCountingLoader({ initFailUntil: 3 })
    const parser = new PythonIncrementalParser(
      { wasmPath: '/fake/python.wasm', maxInitAttempts: 3, initBackoffMs: () => 0 },
      loader
    )

    await parser.ensureReady()

    expect(state.initCalls).toBe(3)
    expect(parser.isReady).toBe(true)
    expect(parser.hasFailedInit).toBe(false)
    // No warn on a successful (recovered) init.
    expect(loggerSpies.warn).not.toHaveBeenCalled()
  })

  it('applies the injected backoff once per inter-attempt gap (jitter wiring)', async () => {
    const { PythonIncrementalParser } = await getSUT()
    const { loader } = makeCountingLoader({ initFailUntil: 3 })
    const backoff = vi.fn((_attempt: number) => 0)
    const parser = new PythonIncrementalParser(
      { wasmPath: '/fake/python.wasm', maxInitAttempts: 3, initBackoffMs: backoff },
      loader
    )

    await parser.ensureReady()

    // Backoff fires between attempts only: after attempt 1 and attempt 2, never
    // after the final (3rd) attempt. It is called with the just-failed 1-based
    // attempt number, so a fixed delay is impossible by construction.
    expect(backoff.mock.calls.map((c) => c[0])).toEqual([1, 2])
    expect(parser.isReady).toBe(true)
  })

  it('does not leak or double-instantiate across a failed-then-retried init', async () => {
    const { PythonIncrementalParser } = await getSUT()
    // Language.load fails on calls 1 and 2 (AFTER a Parser was constructed each
    // time), succeeds on call 3. This is the partial-parser-cleanup path.
    const { loader, state } = makeCountingLoader({ langLoadFailUntil: 3 })
    const parser = new PythonIncrementalParser(
      { wasmPath: '/fake/python.wasm', maxInitAttempts: 3, initBackoffMs: () => 0 },
      loader
    )

    await parser.ensureReady()

    expect(parser.isReady).toBe(true)
    expect(parser.hasFailedInit).toBe(false)
    // One Parser constructed per attempt (3), but the two from the failed
    // attempts were freed — exactly one survives.
    expect(state.parserConstructed).toBe(3)
    expect(state.parserDeleted).toBe(2)
    expect(state.parserConstructed - state.parserDeleted).toBe(1)
    // Exactly one Language survived — no double-instantiation of the grammar.
    expect(state.languagesCreated).toBe(1)
  })

  it('fails gracefully and diagnosably when the retry budget is exhausted', async () => {
    const { PythonIncrementalParser } = await getSUT()
    // Never succeeds within 3 attempts.
    const { loader, state } = makeCountingLoader({ initFailUntil: 99 })
    const parser = new PythonIncrementalParser(
      { wasmPath: '/fake/python.wasm', maxInitAttempts: 3, initBackoffMs: () => 0 },
      loader
    )

    await parser.ensureReady()

    expect(state.initCalls).toBe(3) // bounded — did not loop unbounded
    expect(parser.isReady).toBe(false)
    expect(parser.hasFailedInit).toBe(true)
    // A single diagnostic warn carrying the actual last error + attempt count,
    // so a recurrence doesn't require re-deriving the SMI-5567 analysis.
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1)
    const [message, payload] = loggerSpies.warn.mock.calls[0]
    expect(message).toContain('init failed')
    const p = payload as { attempts: number; error: string; stack?: string }
    expect(p.attempts).toBe(3)
    expect(p.error).toBe('init boom #3') // the LAST error, not a generic flag
    expect(typeof p.stack).toBe('string')
  })

  it('jitteredInitBackoffMs is bounded per attempt and NOT a fixed delay', async () => {
    const { jitteredInitBackoffMs } = await getSUT()
    const attempt1 = Array.from({ length: 200 }, () => jitteredInitBackoffMs(1))
    const attempt2 = Array.from({ length: 200 }, () => jitteredInitBackoffMs(2))

    // Full-jitter bounds: [0, base*2^(n-1)). base = 25 → attempt1 < 25, attempt2 < 50.
    expect(Math.min(...attempt1)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...attempt1)).toBeLessThan(25)
    expect(Math.max(...attempt2)).toBeLessThan(50)
    // Later attempts back off further (wider ceiling).
    expect(Math.max(...attempt2)).toBeGreaterThan(Math.max(...attempt1) - 1)
    // Jitter: the samples must spread, not collapse to a single fixed value.
    expect(new Set(attempt1.map((v) => Math.round(v))).size).toBeGreaterThan(1)
  })
})
