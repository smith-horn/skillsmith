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

// Mock @skillsmith/mcp-server/audit so we can control runInventoryAudit
// without invoking the real audit pipeline (which scans the host inventory).
const mockRunInventoryAudit = vi.fn()
vi.mock('@skillsmith/mcp-server/audit', () => ({
  get runInventoryAudit() {
    return mockRunInventoryAudit
  },
}))

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
    // Mock runInventoryAudit so it takes long enough for both callers
    // to be in flight simultaneously, and writes its result.json to
    // the audits dir so the second caller can pick up the cache.
    let invocations = 0
    mockRunInventoryAudit.mockImplementation(async () => {
      invocations += 1
      const id = `AUDIT-CONCURRENT-${invocations}`
      const dir = path.join(tmpHome, '.skillsmith', 'audits', id)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      // Simulate audit work — long enough that the second caller enters
      // the lock-acquire branch while we're still running.
      await new Promise((r) => setTimeout(r, 100))
      const resultJson = {
        exactCollisions: [],
        genericFlags: [],
        semanticCollisions: [],
      }
      await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(resultJson))
      await fs.writeFile(path.join(dir, 'report.md'), '# concurrent test')
      return {
        auditId: id,
        reportPath: path.join(dir, 'report.md'),
        ...resultJson,
      }
    })

    const settled = await Promise.allSettled([
      runScheduledScan({ homeDir: tmpHome }),
      runScheduledScan({ homeDir: tmpHome }),
    ])

    // Exactly one runInventoryAudit invocation.
    expect(invocations).toBe(1)

    // One caller must have produced a fresh result; the other must
    // have either ridden the cache (after the peer wrote result.json)
    // OR thrown ScheduledScanError with code 'scheduled_scan.in_flight'.
    const fulfilled = settled.filter((s) => s.status === 'fulfilled') as Array<
      PromiseFulfilledResult<Awaited<ReturnType<typeof runScheduledScan>>>
    >
    const rejected = settled.filter((s) => s.status === 'rejected') as Array<PromiseRejectedResult>

    // At least one caller succeeds — the lock-holder.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    if (rejected.length > 0) {
      // The losing caller threw — must be the typed in-flight error.
      const err = rejected[0]?.reason
      expect(err).toBeInstanceOf(ScheduledScanError)
      expect((err as ScheduledScanError).code).toBe('scheduled_scan.in_flight')
    } else {
      // Both fulfilled — the second one must have ridden the cache.
      const fresh = fulfilled.find((s) => !s.value.cached)
      const cached = fulfilled.find((s) => s.value.cached)
      expect(fresh).toBeDefined()
      expect(cached).toBeDefined()
      expect(fresh?.value.auditId).toBe(cached?.value.auditId)
    }

    // Lock file must be cleaned up.
    const lockPath = path.join(tmpHome, '.skillsmith', 'audits', '.scan.lock')
    await expect(fs.access(lockPath)).rejects.toThrow()
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
