/**
 * @fileoverview Unit tests for the Enterprise scheduled-scan runner.
 * @module @skillsmith/enterprise/audit/scheduled-scan.test
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §7
 * (Wave 4 PR 6/6, SMI-4590).
 *
 * Coverage:
 *   - Idempotency cache hit (recent audit dir → return cached)
 *   - Idempotency cache miss (no audit dir → run fresh)
 *   - Cache window override via `cacheMinutes`
 *   - Force flag bypasses cache
 *   - `applyExclusions: false` propagates to runInventoryAudit
 *   - Webhook delivery success
 *   - Webhook delivery failure → fallback to file + failure log
 *   - URL secret stripping (path/query never logged)
 *   - Invalid cacheMinutes → ScheduledScanError
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScheduledScanError, stripUrlSecrets } from '../../src/audit/scheduled-scan.js'
import { acquireScanLock } from '../../src/audit/scheduled-scan.lock.js'

// Mock @skillsmith/mcp-server/audit so we can control runInventoryAudit
// without invoking the real audit pipeline (which scans the host inventory).
const mockRunInventoryAudit = vi.fn()
vi.mock('@skillsmith/mcp-server/audit', () => ({
  get runInventoryAudit() {
    return mockRunInventoryAudit
  },
}))

/**
 * Minimal deferred — an externally-resolvable promise. Used by the
 * concurrent-fire lock test to park the lock-holder inside the mock until
 * the test has provably driven the second caller into the held-lock
 * branch. Removes the wall-clock (`setTimeout`) timing assumption that
 * made the test flaky under saturated CPU (SMI-5372).
 */
function createDeferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runScheduledScan', () => {
  let tmpHome: string
  // Late-binding import — the dynamic-import branch in scheduled-scan.ts
  // resolves the mock above only after vi.mock is wired.
  let runScheduledScan: (typeof import('../../src/audit/scheduled-scan.js'))['runScheduledScan']

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-scan-test-'))
    await fs.mkdir(path.join(tmpHome, '.skillsmith'), { recursive: true, mode: 0o700 })
    mockRunInventoryAudit.mockReset()
    const mod = await import('../../src/audit/scheduled-scan.js')
    runScheduledScan = mod.runScheduledScan
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
    delete process.env['SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN']
  })

  it('returns a fresh audit when no cache present', async () => {
    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-FRESH-1',
      reportPath: path.join(tmpHome, '.skillsmith', 'audits', 'AUDIT-FRESH-1', 'report.md'),
      exactCollisions: [{}, {}],
      genericFlags: [{}],
      semanticCollisions: [],
    })

    const result = await runScheduledScan({ homeDir: tmpHome })

    expect(result.cached).toBe(false)
    expect(result.auditId).toBe('AUDIT-FRESH-1')
    expect(result.counts).toEqual({ exact: 2, generic: 1, semantic: 0 })
    expect(result.outputDisposition).toBe('file')
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)
  })

  it('propagates applyExclusions:false and tier:enterprise to runInventoryAudit', async () => {
    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'A',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    await runScheduledScan({ homeDir: tmpHome })

    expect(mockRunInventoryAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        applyExclusions: false,
        deep: true,
        tier: 'enterprise',
        homeDir: tmpHome,
      })
    )
  })

  it('returns the cached result when a recent audit dir exists', async () => {
    // Plant a recent audit dir.
    const auditDir = path.join(tmpHome, '.skillsmith', 'audits', 'AUDIT-CACHED-1')
    await fs.mkdir(auditDir, { recursive: true })
    await fs.writeFile(
      path.join(auditDir, 'result.json'),
      JSON.stringify({
        exactCollisions: [{ a: 1 }],
        genericFlags: [],
        semanticCollisions: [{ b: 2 }, { c: 3 }],
      })
    )
    await fs.writeFile(path.join(auditDir, 'report.md'), '# test')

    const result = await runScheduledScan({ homeDir: tmpHome, cacheMinutes: 60 })

    expect(result.cached).toBe(true)
    expect(result.auditId).toBe('AUDIT-CACHED-1')
    expect(result.counts).toEqual({ exact: 1, generic: 0, semantic: 2 })
    expect(mockRunInventoryAudit).not.toHaveBeenCalled()
  })

  it('skips the cache when force:true is passed', async () => {
    const auditDir = path.join(tmpHome, '.skillsmith', 'audits', 'AUDIT-CACHED-2')
    await fs.mkdir(auditDir, { recursive: true })
    await fs.writeFile(
      path.join(auditDir, 'result.json'),
      JSON.stringify({ exactCollisions: [], genericFlags: [], semanticCollisions: [] })
    )
    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-FORCED-1',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    const result = await runScheduledScan({
      homeDir: tmpHome,
      cacheMinutes: 60,
      force: true,
    })

    expect(result.cached).toBe(false)
    expect(result.auditId).toBe('AUDIT-FORCED-1')
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)
  })

  it('treats audits older than cacheMinutes as a miss', async () => {
    const auditDir = path.join(tmpHome, '.skillsmith', 'audits', 'AUDIT-STALE-1')
    await fs.mkdir(auditDir, { recursive: true })
    const resultPath = path.join(auditDir, 'result.json')
    await fs.writeFile(
      resultPath,
      JSON.stringify({ exactCollisions: [], genericFlags: [], semanticCollisions: [] })
    )
    // Set mtime to 1 hour ago.
    const oldTime = Date.now() / 1000 - 3600
    await fs.utimes(resultPath, oldTime, oldTime)

    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-FRESH-2',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    // 5-min cache window — 1h-old audit is stale.
    const result = await runScheduledScan({ homeDir: tmpHome, cacheMinutes: 5 })

    expect(result.cached).toBe(false)
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid cacheMinutes', async () => {
    await expect(runScheduledScan({ homeDir: tmpHome, cacheMinutes: 0 })).rejects.toThrow(
      ScheduledScanError
    )
    await expect(runScheduledScan({ homeDir: tmpHome, cacheMinutes: 100_000 })).rejects.toThrow(
      ScheduledScanError
    )
  })

  it('reads the cache window from SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN env', async () => {
    process.env['SKILLSMITH_SCHEDULED_AUDIT_CACHE_MIN'] = '60'
    const auditDir = path.join(tmpHome, '.skillsmith', 'audits', 'AUDIT-ENV-1')
    await fs.mkdir(auditDir, { recursive: true })
    await fs.writeFile(
      path.join(auditDir, 'result.json'),
      JSON.stringify({ exactCollisions: [], genericFlags: [], semanticCollisions: [] })
    )
    const oldTime = Date.now() / 1000 - 1800 // 30 min ago — within 60-min env cache.
    await fs.utimes(path.join(auditDir, 'result.json'), oldTime, oldTime)

    const result = await runScheduledScan({ homeDir: tmpHome })

    expect(result.cached).toBe(true)
    expect(mockRunInventoryAudit).not.toHaveBeenCalled()
  })

  it('wraps audit failures in ScheduledScanError', async () => {
    mockRunInventoryAudit.mockRejectedValue(new Error('inventory boom'))
    await expect(runScheduledScan({ homeDir: tmpHome })).rejects.toThrow(ScheduledScanError)
  })

  it('marks output as webhook on successful delivery', async () => {
    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-WH-1',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    const result = await runScheduledScan({
      homeDir: tmpHome,
      output: { kind: 'webhook', url: 'https://example.com/hook' },
    })

    expect(result.outputDisposition).toBe('webhook')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })

  it('falls back to file output and logs a redacted failure on webhook error', async () => {
    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-WH-2',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    // URL with secrets in path — must NEVER reach the failure log verbatim.
    const secretUrl = 'https://hooks.slack.com/services/T1/B2/SECRETKEY?token=opaque'
    const result = await runScheduledScan({
      homeDir: tmpHome,
      output: { kind: 'webhook', url: secretUrl },
    })

    expect(result.outputDisposition).toBe('webhook_fallback')

    const logPath = path.join(tmpHome, '.skillsmith', 'scheduled-scan-webhook-failures.log')
    const logRaw = await fs.readFile(logPath, 'utf-8')
    expect(logRaw).toContain('https://hooks.slack.com')
    // The path and query MUST be stripped — never logged.
    expect(logRaw).not.toContain('SECRETKEY')
    expect(logRaw).not.toContain('opaque')
    expect(logRaw).not.toContain('/services/')
    fetchSpy.mockRestore()
  })
})

describe('runScheduledScan — concurrent-fire lock (SMI-4752)', () => {
  let tmpHome: string
  let runScheduledScan: (typeof import('../../src/audit/scheduled-scan.js'))['runScheduledScan']

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-scan-lock-test-'))
    await fs.mkdir(path.join(tmpHome, '.skillsmith'), { recursive: true, mode: 0o700 })
    mockRunInventoryAudit.mockReset()
    const mod = await import('../../src/audit/scheduled-scan.js')
    runScheduledScan = mod.runScheduledScan
  })

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true })
    delete process.env['SKILLSMITH_SCHEDULED_AUDIT_LOCK_STALE_MS']
  })

  it('serializes two concurrent runScheduledScan calls — only one invokes runInventoryAudit', async () => {
    let invocations = 0
    const holderInMock = createDeferred() // resolves once the lock-holder is inside the mock
    const releaseHolder = createDeferred() // test resolves this to let the holder finish + publish

    mockRunInventoryAudit.mockImplementation(async () => {
      invocations += 1
      const id = `AUDIT-CONCURRENT-${invocations}`
      // Signal that we hold the lock, then park here until the test has
      // confirmed the second caller observed the held lock. Deterministic —
      // no setTimeout/wall-clock race.
      holderInMock.resolve()
      await releaseHolder.promise
      const dir = path.join(tmpHome, '.skillsmith', 'audits', id)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const resultJson = {
        exactCollisions: [],
        genericFlags: [],
        semanticCollisions: [],
      }
      await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(resultJson))
      await fs.writeFile(path.join(dir, 'report.md'), '# concurrent test')
      return { auditId: id, reportPath: path.join(dir, 'report.md'), ...resultJson }
    })

    // First caller acquires the lock and parks inside the mock.
    const first = runScheduledScan({ homeDir: tmpHome })
    await holderInMock.promise

    // Second caller starts only after the lock is provably held. The lock
    // module does not wait-loop on a fresh, alive lock and the holder has not
    // published a result yet, so the second caller must reject in_flight.
    const second = runScheduledScan({ homeDir: tmpHome })
    await expect(second).rejects.toBeInstanceOf(ScheduledScanError)
    await expect(second).rejects.toMatchObject({ code: 'scheduled_scan.in_flight' })

    // Exactly one runInventoryAudit invocation — the lock serialized the pair.
    expect(invocations).toBe(1)

    // Release the holder; it publishes result.json and releases the lock.
    releaseHolder.resolve()
    const firstResult = await first
    expect(firstResult.cached).toBe(false)
    expect(firstResult.auditId).toBe('AUDIT-CONCURRENT-1')

    // Lock file must be cleaned up after release.
    const lockPath = path.join(tmpHome, '.skillsmith', 'audits', '.scan.lock')
    await expect(fs.access(lockPath)).rejects.toThrow()
  })

  it('rides a peer-published cache when the lock is held (acquireScanLock cached outcome)', async () => {
    // Deterministically exercise acquireScanLock's `kind: 'cached'` branch:
    // the path a second caller takes when a peer has already published a
    // result while still holding the lock. The concurrent-fire test above now
    // resolves to in_flight (the lock does not wait-loop on a fresh, alive
    // lock), so this unit test pins the cached branch directly instead of
    // relying on the old setTimeout race window (SMI-5372).
    const auditsDir = path.join(tmpHome, '.skillsmith', 'audits')
    await fs.mkdir(auditsDir, { recursive: true, mode: 0o700 })
    // Plant a fresh, alive lock owned by this very process so the acquire
    // hits EEXIST → fresh-and-alive (not stale-reclaim) → cacheProbe.
    await fs.writeFile(
      path.join(auditsDir, '.scan.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), hostname: os.hostname() }),
      { mode: 0o600 }
    )

    const peerResult = {
      auditId: 'AUDIT-PEER-1',
      reportPath: path.join(auditsDir, 'AUDIT-PEER-1', 'report.md'),
      counts: { exact: 1, generic: 0, semantic: 2 },
    }
    const outcome = await acquireScanLock(
      tmpHome,
      async () => peerResult,
      (err) => {
        throw err instanceof Error ? err : new Error(String(err))
      }
    )

    expect(outcome.kind).toBe('cached')
    if (outcome.kind === 'cached') {
      expect(outcome.cached.auditId).toBe('AUDIT-PEER-1')
      expect(outcome.cached.counts).toEqual({ exact: 1, generic: 0, semantic: 2 })
    }
  })

  it('reclaims a stale lock (older than lock-stale window) and proceeds', async () => {
    // Plant a synthetic stale lock — startedAt 6 minutes ago, default
    // stale window is 5 minutes.
    const auditsDir = path.join(tmpHome, '.skillsmith', 'audits')
    await fs.mkdir(auditsDir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(auditsDir, '.scan.lock')
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid, // Real pid — so PID-liveness check would say "alive"
        startedAt: Date.now() - 6 * 60 * 1000,
        hostname: os.hostname(),
      }),
      { mode: 0o600 }
    )

    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-RECLAIM-1',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    const result = await runScheduledScan({ homeDir: tmpHome })
    expect(result.cached).toBe(false)
    expect(result.auditId).toBe('AUDIT-RECLAIM-1')
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)

    // Lock cleaned up after release.
    await expect(fs.access(lockPath)).rejects.toThrow()
  })

  it('reclaims a lock held by a definitely-dead PID', async () => {
    // PID 0x7fffffff is reserved-ish on Linux/macOS; process.kill(0x7fffffff, 0)
    // returns ESRCH because no real process can use it.
    const auditsDir = path.join(tmpHome, '.skillsmith', 'audits')
    await fs.mkdir(auditsDir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(auditsDir, '.scan.lock')
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 0x7fffffff,
        startedAt: Date.now(), // Fresh — only the dead-PID branch can reclaim it.
        hostname: os.hostname(),
      }),
      { mode: 0o600 }
    )

    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-DEADPID-1',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    const result = await runScheduledScan({ homeDir: tmpHome })
    expect(result.cached).toBe(false)
    expect(result.auditId).toBe('AUDIT-DEADPID-1')
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)
    await expect(fs.access(lockPath)).rejects.toThrow()
  })

  it('reclaims an unparseable lock file as stale', async () => {
    const auditsDir = path.join(tmpHome, '.skillsmith', 'audits')
    await fs.mkdir(auditsDir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(auditsDir, '.scan.lock')
    await fs.writeFile(lockPath, 'not-json{{{')

    mockRunInventoryAudit.mockResolvedValue({
      auditId: 'AUDIT-JUNK-1',
      reportPath: 'r',
      exactCollisions: [],
      genericFlags: [],
      semanticCollisions: [],
    })

    const result = await runScheduledScan({ homeDir: tmpHome })
    expect(result.auditId).toBe('AUDIT-JUNK-1')
    expect(mockRunInventoryAudit).toHaveBeenCalledTimes(1)
  })

  it('releases the lock even when runInventoryAudit throws', async () => {
    mockRunInventoryAudit.mockRejectedValue(new Error('inventory boom'))

    await expect(runScheduledScan({ homeDir: tmpHome })).rejects.toThrow(ScheduledScanError)

    // Lock must NOT remain after a failure — try/finally guards it.
    const lockPath = path.join(tmpHome, '.skillsmith', 'audits', '.scan.lock')
    await expect(fs.access(lockPath)).rejects.toThrow()
  })
})

describe('stripUrlSecrets', () => {
  it('strips path and query', () => {
    expect(stripUrlSecrets('https://hooks.slack.com/services/T1/B2/SECRET?x=1')).toBe(
      'https://hooks.slack.com'
    )
  })

  it('preserves port', () => {
    expect(stripUrlSecrets('http://example.com:8080/x/y')).toBe('http://example.com:8080')
  })

  it('returns "<unparseable>" for invalid URLs', () => {
    expect(stripUrlSecrets('not a url')).toBe('<unparseable>')
  })
})
