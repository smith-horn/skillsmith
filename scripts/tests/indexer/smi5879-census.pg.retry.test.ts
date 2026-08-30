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
  isAmbiguousConnectionLoss,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
} = await import('../../indexer/smi5879-census.pg.ts')

/** Minimal fake ChildProcess: EventEmitter + stdout/stderr/stdin/kill the module actually uses. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (s: string) => void; end: () => void }
    kill: (signal?: string) => boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.kill = vi.fn().mockReturnValue(true)
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

/**
 * SMI-6294: queue one spawn() call that hangs FOREVER — a genuinely stuck
 * `psql` whose stdin is fed (production code always writes/ends stdin) but
 * which never emits `'close'` or `'error'` on its own. Only production
 * code's own `options.timeoutMs` timer (calling `child.kill('SIGTERM')`) can
 * ever resolve this. Returns the fake child so a test can assert whether/how
 * `kill()` was called.
 */
function queueSpawnHangOutcome(): ReturnType<typeof makeFakeChild> {
  const child = makeFakeChild()
  spawnMock.mockImplementationOnce(() => child)
  return child
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

describe('SMI-6294: isAmbiguousConnectionLoss', () => {
  it.each([
    'psql: error: server closed the connection unexpectedly',
    'psql: error: terminating connection due to administrator command',
    'psql: error: timeout expired',
  ])('classifies %s as an ambiguous post-execution connection loss', (message) => {
    expect(isAmbiguousConnectionLoss(message)).toBe(true)
  })

  it('does NOT classify a real SQL error as an ambiguous connection loss', () => {
    expect(
      isAmbiguousConnectionLoss(
        'ERROR:  duplicate key value violates unique constraint "smi5879_run_pkey"'
      )
    ).toBe(false)
  })

  it('does NOT misclassify a real SQL error whose message happens to contain "timeout expired" as incidental text', () => {
    expect(
      isAmbiguousConnectionLoss(
        'ERROR:  invalid input syntax for type text: "timeout expired for lock acquisition"'
      )
    ).toBe(false)
  })
})

describe('SMI-6294: spawnPsqlOnce timeout (options.timeoutMs)', () => {
  it('with NO timeoutMs, a hung psql call never settles (contrast with the timeoutMs case below -- not a tautology: this proves the absence of a timer, not merely the presence of one)', async () => {
    queueSpawnHangOutcome()

    const promise = runPsql(CONN, 'SELECT 1;')
    // A sentinel timer scheduled under the SAME fake-timer clock: if `promise`
    // had any bound at all it would settle by 10 minutes and win the race.
    const sentinel = new Promise<string>((resolve) => {
      setTimeout(() => resolve('sentinel'), 10 * 60_000)
    })
    const racePromise = Promise.race([promise, sentinel])

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(racePromise).resolves.toBe('sentinel')
  })

  it('with { timeoutMs: 5000 }, a hung psql call rejects with PsqlTimeoutError and kills the child with SIGTERM', async () => {
    const child = queueSpawnHangOutcome()

    const promise = runPsql(CONN, 'SELECT 1;', {}, { timeoutMs: 5000 })
    const assertion = expect(promise).rejects.toThrow(
      /SMI-6294: psql timed out after 5000ms with no response/
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // treatAmbiguousLossAsRetryable is unset -- a PsqlTimeoutError is NOT
    // retried by default, so exactly one spawn() call was made.
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('a timer that fires does not double-reject after the child ALSO closes on the same tick (clearTimeout hygiene)', async () => {
    // Exercises the doc-commented "harmless either way" race: queue a normal
    // successful close so if the timer's reject somehow fired AFTER close's
    // resolve, the test would see an unhandled rejection / mismatched result.
    queueSpawnOutcome(0, '', 'ok')

    const promise = runPsql(CONN, 'SELECT 1;', {}, { timeoutMs: 5000 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ stdout: 'ok', stderr: '' })
  })
})

describe('SMI-6294: treatAmbiguousLossAsRetryable opt-in', () => {
  it('regression guard: WITHOUT treatAmbiguousLossAsRetryable, an ambiguous-loss stderr is still NOT retried (existing non-idempotent-write safety property)', async () => {
    queueSpawnOutcome(2, 'psql: error: server closed the connection unexpectedly')

    const promise = runPsql(CONN, "INSERT INTO smi5879_run (run_id) VALUES ('x');", {}, {})
    const assertion = expect(promise).rejects.toThrow(/server closed the connection unexpectedly/)
    await vi.runAllTimersAsync()
    await assertion
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('WITH { treatAmbiguousLossAsRetryable: true }, the SAME ambiguous-loss stderr IS retried and can succeed within budget', async () => {
    queueSpawnOutcome(2, 'psql: error: server closed the connection unexpectedly')
    queueSpawnOutcome(0, '', '')

    const promise = runPsql(
      CONN,
      `SELECT smi5879_heartbeat(:'run_id', :'token');`,
      { run_id: 'run-1', token: 'tok-1' },
      { treatAmbiguousLossAsRetryable: true }
    )
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ stdout: '', stderr: '' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('WITH { treatAmbiguousLossAsRetryable: true }, a hung/timing-out call is retried as a PsqlTimeoutError and can succeed on a later attempt', async () => {
    const hungChild = queueSpawnHangOutcome()
    queueSpawnOutcome(0, '', '')

    const promise = runPsql(
      CONN,
      `SELECT smi5879_heartbeat(:'run_id', :'token');`,
      { run_id: 'run-1', token: 'tok-1' },
      { timeoutMs: 2000, treatAmbiguousLossAsRetryable: true }
    )
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ stdout: '', stderr: '' })
    expect(hungChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
