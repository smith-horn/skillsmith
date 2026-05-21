/**
 * SMI-5039: Unit tests for the canonical `probeEmbeddingCapability` helper in
 * `@skillsmith/core/embeddings/probe`. Mirrors the shape of the legacy
 * `packages/mcp-server/tests/startup-probe.test.ts` unit tier (SMI-5009) but
 * exercises the real exported function — not an inline copy — so the four
 * consumers (mcp-server, doc-retrieval-mcp server/cli, cli) all share the
 * same audited behavior.
 *
 * The mcp-server integration tier (spawn-based) is preserved separately to
 * pin the MCP stdio invariant — see SMI-5009 for the rationale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmbeddingService } from '../../src/embeddings/index.js'
import { probeEmbeddingCapability } from '../../src/embeddings/probe.js'

describe('SMI-5039 probeEmbeddingCapability — success path', () => {
  let checkSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    // Spy on getTransformersLoadError to prevent any accidental real-module
    // access during the test even though the success path never reads it.
    vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('is silent when real embeddings are available', async () => {
    checkSpy.mockResolvedValue(true)
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m) })
    expect(logs).toEqual([])
  })
})

describe('SMI-5039 probeEmbeddingCapability — mock fallback path', () => {
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('logs structured mock-fallback warning with reason when checkAvailability returns false', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('ENOENT: cannot find module @huggingface/transformers'))
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(
      /\[skillsmith\] embeddings: mock \(transformers unavailable: ENOENT: cannot find module @huggingface\/transformers/
    )
    // Remediation hint MUST be present.
    expect(logs[0]).toContain('install @huggingface/transformers')
    expect(logs[0]).toContain('SKILLSMITH_USE_MOCK_EMBEDDINGS=true')
  })

  it('falls back to "module-load-failed" when no load error is recorded', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(null)
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('transformers unavailable: module-load-failed')
  })
})

describe('SMI-5039 probeEmbeddingCapability — timeout path', () => {
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('emits probe-timeout line and returns within the bound when checkAvailability hangs', async () => {
    // Hangs forever — only the timeout sentinel should resolve.
    checkSpy.mockImplementation(() => new Promise<boolean>(() => undefined))
    getErrSpy.mockReturnValue(null)
    const logs: string[] = []
    const start = Date.now()
    await probeEmbeddingCapability({ logger: (m) => logs.push(m), timeoutMs: 100 })
    const elapsed = Date.now() - start
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/embeddings: mock \(transformers unavailable: probe-timeout/)
    // Must complete within a small multiple of the timeout — proves the
    // hard-bound holds even when checkAvailability never resolves.
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('SMI-5039 probeEmbeddingCapability — error path', () => {
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('catches a thrown error and logs probe-failed without rethrowing', async () => {
    checkSpy.mockRejectedValue(new Error('boom'))
    getErrSpy.mockReturnValue(null)
    const logs: string[] = []
    await expect(probeEmbeddingCapability({ logger: (m) => logs.push(m) })).resolves.toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/embeddings: probe-failed \(boom/)
    expect(logs[0]).toContain('install @huggingface/transformers')
  })
})

describe('SMI-5039 probeEmbeddingCapability — quiet mode', () => {
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('suppresses the warning when opts.quiet=true', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('boom'))
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m), quiet: true })
    expect(logs).toEqual([])
  })

  it('suppresses the warning when SKILLSMITH_QUIET=true', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('boom'))
    process.env['SKILLSMITH_QUIET'] = 'true'
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m) })
    expect(logs).toEqual([])
  })

  it('honors SKILLSMITH_QUIET=1 (numeric truthy)', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('boom'))
    process.env['SKILLSMITH_QUIET'] = '1'
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m) })
    expect(logs).toEqual([])
  })

  it('does NOT suppress when SKILLSMITH_QUIET is unset and quiet=false', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('boom'))
    const logs: string[] = []
    await probeEmbeddingCapability({ logger: (m) => logs.push(m), quiet: false })
    expect(logs).toHaveLength(1)
  })
})
