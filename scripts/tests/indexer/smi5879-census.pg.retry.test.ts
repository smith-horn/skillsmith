/**
 * SMI-6015 Wave 3 incident (2026-08-17): a transient DNS/connection blip
 * crashed a multi-hour census run outright -- every `psql`-backed DB call in
 * `smi5879-census.pg.ts` had zero tolerance for a purely transient connection
 * failure, unlike the GitHub API call path's own retry/circuit-breaker logic.
 * This suite proves the fix: `isTransientConnectionError()` classifies known
 * libpq connection-failure text correctly, and `runPsql`/`queryRows` retry a
 * transient failure (bounded) while still failing immediately on a real SQL
 * error -- verified by mocking `node:child_process.spawn` directly, not
 * against a live Postgres, so this runs in every CI pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

// Imported AFTER the mock so the module under test picks up the mocked spawn.
const { runPsql, queryRows, isTransientConnectionError, TRANSIENT_RETRY_MAX_ATTEMPTS } =
  await import('../../indexer/smi5879-census.pg.ts')

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
    'Temporary failure in name resolution',
    'Connection refused',
    'could not connect to server: Connection refused',
    'server closed the connection unexpectedly',
    'timeout expired',
    'Operation timed out',
    'Network is unreachable',
  ])('classifies %s as transient', (message) => {
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
})

describe('SMI-6015: transient-connection retry (runPsql/queryRows)', () => {
  it('retries a transient connection failure and succeeds within budget', async () => {
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
      queueSpawnOutcome(2, 'connection refused')
    }

    const promise = runPsql(CONN, 'SELECT 1;')
    // Attach a rejection handler immediately so the eventually-rejected
    // promise is never seen as unhandled while fake timers advance.
    const assertion = expect(promise).rejects.toThrow(/connection refused/)
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

  it('queryRows also retries transparently (shares the same spawnPsql retry wrapper)', async () => {
    queueSpawnOutcome(2, 'could not connect to server: Connection refused')
    queueSpawnOutcome(0, '', 'value1\x1fvalue2\n')

    const promise = queryRows(CONN, 'SELECT a, b FROM t;')
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual([['value1', 'value2']])
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
