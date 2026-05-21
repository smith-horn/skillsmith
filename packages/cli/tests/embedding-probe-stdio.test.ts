/**
 * SMI-5039: Stdout-pollution test for `@skillsmith/cli` — pins the same
 * "probe never writes to stdout" invariant exercised by the mcp-server and
 * doc-retrieval-mcp packages.
 *
 * CLI's `search` command emits structured table output to stdout for
 * downstream piping. A regression that lets the embedding probe leak to
 * stdout would garble that pipe — we catch it here before it lands in CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmbeddingService } from '@skillsmith/core/embeddings'
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'

describe('SMI-5039 cli embedding probe — stdout-clean invariant', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
    delete process.env['SKILLSMITH_QUIET']
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['SKILLSMITH_QUIET']
  })

  it('never writes to stdout on mock fallback (CLI pipe-safety invariant)', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('transformers absent'))
    const stderrChunks: string[] = []
    await probeEmbeddingCapability({ logger: (m: string) => stderrChunks.push(m) })
    expect(stderrChunks).toHaveLength(1)
    expect(stderrChunks[0]).toContain('[skillsmith] embeddings: mock')
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('SKILLSMITH_QUIET=true suppresses the warning AND keeps stdout clean', async () => {
    process.env['SKILLSMITH_QUIET'] = 'true'
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('transformers absent'))
    const stderrChunks: string[] = []
    await probeEmbeddingCapability({ logger: (m: string) => stderrChunks.push(m) })
    expect(stderrChunks).toEqual([])
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('default logger (console.error) does not touch stdout', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('default-logger path'))
    await probeEmbeddingCapability()
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('never throws — probe failure must not abort the CLI command', async () => {
    checkSpy.mockRejectedValue(new Error('catastrophic'))
    getErrSpy.mockReturnValue(null)
    await expect(probeEmbeddingCapability()).resolves.toBeUndefined()
    expect(stdoutWrite).not.toHaveBeenCalled()
  })
})
