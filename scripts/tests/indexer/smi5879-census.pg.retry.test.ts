/**
 * SMI-6015 Wave 3 incident (2026-08-17): a transient DNS/connection blip
 * crashed a multi-hour census run outright -- every `psql`-backed DB call in
 * `smi5879-census.pg.ts` had zero tolerance for a purely transient connection
 * failure, unlike the GitHub API call path's own retry/circuit-breaker logic.
 * This suite proves the fix: `isTransientConnectionError()` classifies known
 * libpq PRE-connection-establishment error text correctly, and
 * `runPsql`/`queryRows` retry ONLY those (bounded) while still failing
 * immediately on a real SQL error OR an ambiguous post-execution connection
 * loss -- verified by mocking `node:child_process.spawn` directly, not
 * against a live Postgres, so this runs in every CI pass.
 *
 * GPT-5.6-Sol pre-merge review (High + Medium findings, both covered here):
 * (1) the original classifier also matched ambiguous post-execution failures
 * (`server closed the connection unexpectedly`, timeouts) that could occur
 * AFTER the server already executed/committed a non-idempotent write --
 * narrowed to provably pre-connection patterns only, anchored to psql's own
 * client-side `psql: error: ` prefix. (2) unrestricted substring matching
 * could misclassify a real SQL error whose message happens to contain one of
 * these words -- the prefix anchor also fixes this.
 *
 * SMI-6015 post-merge retro (2026-08-18): the census pipeline spawns tens of
 * thousands of `psql` subprocesses over a multi-hour run -- an OS-level
 * resource ceiling on `spawn()` itself (EMFILE/ENFILE/EAGAIN/ENOMEM) is a
 * realistic failure mode at that volume, not just a hypothetical one, and
 * the original fix left it entirely unretried. Covered below:
 * `isTransientSpawnErrorCode()` classifies transient-resource spawn codes
 * (never a permanent misconfiguration like ENOENT/EACCES), and
 * `runPsql`/`queryRows` retry a transient spawn failure the same way they
 * already retry a transient connection failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

// Imported AFTER the mock so the module under test picks up the mocked spawn.
const {
  runPsql,
  queryRows,
  isTransientConnectionError,
  isTransientSpawnErrorCode,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
} = await import('../../indexer/smi5879-census.pg.ts')

/** Minimal fake ChildProcess: EventEmitter + stdout/stderr/stdin the module actually uses. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (s: string) => void; end: () => void }
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn(), end: vi.fn() }
  return child
}

/** Queue one spawn() call: emits `stderr` (if any), then `close` with `exitCode` on next tick. */
function queueSpawnOutcome(exitCode: number, stderr = '', stdout = ''): void {
  spawnMock.mockImplementationOnce(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', exitCode)
    })
    return child
  })
}

/** Queue one spawn() call that fails at the OS level: emits ChildProcess `'error'`, never `'close'`. */
function queueSpawnErrorOutcome(code: string, message = 'spawn psql ' + code): void {
  spawnMock.mockImplementationOnce(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      const err = new Error(message) as NodeJS.ErrnoException
      err.code = code
      child.emit('error', err)
    })
    return child
  })
}

const CONN = {
  host: 'aws-1-us-east-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.test',
  password: 'test',
  database: 'postgres',
}

beforeEach(() => {
  spawnMock.mockReset()
  vi.useFakeTimers()
})

describe('SMI-6015: isTransientConnectionError', () => {
  it('classifies the exact production DNS-failure message as transient', () => {
    expect(
      isTransientConnectionError(
        'psql: error: could not translate host name "aws-1-us-east-1.pooler.supabase.com" to address: No address associated with hostname'
      )
    ).toBe(true)
  })

  it.each([
    'psql: error: Temporary failure in name resolution',
    'psql: error: Connection refused',
    'psql: error: could not connect to server: Connection refused',
    'psql: error: Network is unreachable',
  ])('classifies %s as transient (pre-connection, real psql prefix)', (message) => {
    expect(isTransientConnectionError(message)).toBe(true)
  })

  it('does NOT classify a real SQL error as transient', () => {
    expect(
      isTransientConnectionError(
        'ERROR:  duplicate key value violates unique constraint "smi5879_run_pkey"'
      )
    ).toBe(false)
  })

  it('does NOT classify a syntax error as transient', () => {
    expect(isTransientConnectionError('ERROR:  syntax error at or near "SELCT"')).toBe(false)
  })

  it('GPT-5.6-Sol High finding: does NOT classify an ambiguous post-execution connection loss as transient (unsafe to blindly replay)', () => {
    expect(
      isTransientConnectionError('psql: error: server closed the connection unexpectedly')
    ).toBe(false)
  })

  it('GPT-5.6-Sol High finding: does NOT classify a timeout as transient (ambiguous -- could be mid-execution)', () => {
    expect(isTransientConnectionError('psql: error: timeout expired')).toBe(false)
  })

  it('GPT-5.6-Sol Medium finding: does NOT misclassify a real SQL error whose message happens to contain "connection refused" as incidental text', () => {
    expect(
      isTransientConnectionError(
        'ERROR:  invalid input syntax for type text: "connection refused by upstream policy"'
      )
    ).toBe(false)
  })
})

describe('SMI-6015 post-merge retro: isTransientSpawnErrorCode', () => {
  it.each(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM'])(
    'classifies %s as a transient OS-resource-ceiling spawn error',
    (code) => {
      expect(isTransientSpawnErrorCode(code)).toBe(true)
    }
  )

  it('does NOT classify ENOENT (missing binary) as transient -- permanent misconfiguration', () => {
    expect(isTransientSpawnErrorCode('ENOENT')).toBe(false)
  })

  it('does NOT classify EACCES (permission denied) as transient -- permanent misconfiguration', () => {
    expect(isTransientSpawnErrorCode('EACCES')).toBe(false)
  })

  it('does NOT classify an undefined code as transient', () => {
    expect(isTransientSpawnErrorCode(undefined)).toBe(false)
  })
})

describe('SMI-6015: transient-connection retry (runPsql/queryRows)', () => {
  it('retries a transient pre-connection failure and succeeds within budget', async () => {
    queueSpawnOutcome(
      2,
      'psql: error: could not translate host name "aws-1-us-east-1.pooler.supabase.com" to address'
    )
    queueSpawnOutcome(0, '', '')

    const promise = runPsql(CONN, 'SELECT 1;')
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ stdout: '', stderr: '' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('fails after exhausting the retry budget on a persistent transient failure', async () => {
    for (let i = 0; i < TRANSIENT_RETRY_MAX_ATTEMPTS; i++) {
      queueSpawnOutcome(2, 'psql: error: Connection refused')
    }

    const promise = runPsql(CONN, 'SELECT 1;')
    // Attach a rejection handler immediately so the eventually-rejected
    // promise is never seen as unhandled while fake timers advance.
    const assertion = expect(promise).rejects.toThrow(/Connection refused/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(TRANSIENT_RETRY_MAX_ATTEMPTS)
  })

  it('does NOT retry a real SQL error -- fails on the first attempt', async () => {
    queueSpawnOutcome(
      3,
      'ERROR:  duplicate key value violates unique constraint "smi5879_run_pkey"'
    )

    const promise = runPsql(CONN, 'SELECT 1;')
    const assertion = expect(promise).rejects.toThrow(/duplicate key value/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry an ambiguous post-execution connection loss -- a non-idempotent write must not be silently replayed', async () => {
    queueSpawnOutcome(2, 'psql: error: server closed the connection unexpectedly')

    const promise = runPsql(CONN, "INSERT INTO smi5879_run (run_id) VALUES ('x');")
    const assertion = expect(promise).rejects.toThrow(/server closed the connection unexpectedly/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('queryRows also retries transparently (shares the same spawnPsql retry wrapper)', async () => {
    queueSpawnOutcome(2, 'psql: error: could not connect to server: Connection refused')
    queueSpawnOutcome(0, '', 'value1\x1fvalue2\n')

    const promise = queryRows(CONN, 'SELECT a, b FROM t;')
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual([['value1', 'value2']])
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('SMI-6015 post-merge retro: retries a transient spawn-level failure (EMFILE) and succeeds within budget', async () => {
    queueSpawnErrorOutcome('EMFILE')
    queueSpawnOutcome(0, '', '')

    const promise = runPsql(CONN, 'SELECT 1;')
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ stdout: '', stderr: '' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('SMI-6015 post-merge retro: fails after exhausting the retry budget on a persistent transient spawn failure', async () => {
    for (let i = 0; i < TRANSIENT_RETRY_MAX_ATTEMPTS; i++) {
      queueSpawnErrorOutcome('EAGAIN')
    }

    const promise = runPsql(CONN, 'SELECT 1;')
    const assertion = expect(promise).rejects.toThrow(/EAGAIN/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(TRANSIENT_RETRY_MAX_ATTEMPTS)
  })

  it('SMI-6015 post-merge retro: does NOT retry a permanent spawn failure (ENOENT, missing binary) -- fails on the first attempt', async () => {
    queueSpawnErrorOutcome('ENOENT')

    const promise = runPsql(CONN, 'SELECT 1;')
    const assertion = expect(promise).rejects.toThrow(/ENOENT/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
