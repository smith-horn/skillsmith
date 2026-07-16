import { describe, it, expect } from 'vitest'
import { createMarkdownCorpusAdapter } from './markdown-corpus.js'
import type { AdapterContext, AdapterFile } from '../types.js'
import type { CorpusConfig } from '../config.js'

/**
 * Focused unit test for the `markdown-corpus` adapter's `chunk()` provenance
 * tagging (SMI-4703 §1). This adapter previously had no dedicated test file
 * — the only existing coverage was indirect, via
 * `tests/integration/indexer.test.ts` (which asserts on chunk COUNTS, not
 * on individual `ChunkMetadata` fields). Added here because SMI-4703 is the
 * first change to touch this file's `chunk()` output shape.
 */
function makeCtx(): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
    globs: ['**/*.md'],
  }
  return {
    repoRoot: '/fake/repo',
    cfg,
    mode: 'full',
    lastSha: null,
    lastRunAt: null,
  }
}

describe('markdown-corpus adapter — chunk provenance tagging (SMI-4703 §1)', () => {
  it('tags every chunk provenanceTier: "tier-a" (reaches the corpus via a human-reviewed PR merge)', async () => {
    const adapter = createMarkdownCorpusAdapter()
    const file: AdapterFile = {
      logicalPath: 'docs/internal/example.md',
      rawContent: '# Example\n\nSome documentation content that forms a single chunk.\n',
      absolutePath: null,
    }
    const chunks = await adapter.chunk(file, makeCtx())
    expect(chunks.length).toBeGreaterThan(0)
    for (const c of chunks) {
      expect(c.provenanceTier).toBe('tier-a')
      expect(c.kind).toBe('markdown-doc')
      expect(c.lifetime).toBe('long-term')
    }
  })

  it('returns [] (no chunks to tag) when the file cannot be read', async () => {
    const adapter = createMarkdownCorpusAdapter()
    const file: AdapterFile = {
      logicalPath: 'docs/internal/missing.md',
      rawContent: '',
      absolutePath: '/fake/repo/docs/internal/missing.md',
    }
    const chunks = await adapter.chunk(file, makeCtx())
    expect(chunks).toEqual([])
  })
})
