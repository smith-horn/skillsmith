/**
 * SMI-5039: Stdout-pollution test for `@skillsmith/doc-retrieval-mcp` —
 * mirrors the mcp-server R2 stdio invariant for the new shared probe.
 *
 * Asserts that `probeEmbeddingCapability()` writes ONLY to the supplied
 * `logger` (stderr-equivalent). MCP servers communicate over stdio; if the
 * probe ever leaks to stdout, the JSON-RPC frame is corrupted and the client
 * disconnects. This test pins that invariant at the unit boundary so a
 * regression is caught before it reaches a spawn test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmbeddingService } from '@skillsmith/core/embeddings'
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'

describe('SMI-5039 doc-retrieval-mcp probe — MCP stdio invariant (R2)', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let checkSpy: ReturnType<typeof vi.spyOn>
  let getErrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    checkSpy = vi.spyOn(EmbeddingService, 'checkAvailability')
    getErrSpy = vi.spyOn(EmbeddingService, 'getTransformersLoadError')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never writes to stdout on mock fallback (would corrupt MCP stdio frame)', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('transformers absent'))
    const stderrChunks: string[] = []
    await probeEmbeddingCapability({ logger: (m: string) => stderrChunks.push(m) })
    expect(stderrChunks).toHaveLength(1)
    expect(stderrChunks[0]).toMatch(/\[skillsmith\] embeddings: mock/)
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('never writes to stdout on probe-failed path', async () => {
    checkSpy.mockRejectedValue(new Error('boom'))
    getErrSpy.mockReturnValue(null)
    const stderrChunks: string[] = []
    await probeEmbeddingCapability({ logger: (m: string) => stderrChunks.push(m) })
    expect(stderrChunks[0]).toMatch(/\[skillsmith\] embeddings: probe-failed/)
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('never writes to stdout on success path (silent)', async () => {
    checkSpy.mockResolvedValue(true)
    const stderrChunks: string[] = []
    await probeEmbeddingCapability({ logger: (m: string) => stderrChunks.push(m) })
    expect(stderrChunks).toEqual([])
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('default logger (console.error) does not touch stdout', async () => {
    checkSpy.mockResolvedValue(false)
    getErrSpy.mockReturnValue(new Error('default-logger path'))
    // No explicit logger — exercise the production default (`console.error`).
    await probeEmbeddingCapability()
    expect(stdoutWrite).not.toHaveBeenCalled()
  })
})
