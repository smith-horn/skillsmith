import { describe, it, expect } from 'vitest'
import {
  parseMarkdown,
  chunkBlocks,
  chunkDocument,
  estimateTokens,
} from '../src/indexer.helpers.js'
import type { CorpusConfig } from '../src/config.js'

const cfg: CorpusConfig = {
  storagePath: '.ruvector/skillsmith-docs',
  metadataPath: '.ruvector/m.json',
  stateFile: '.ruvector/s.json',
  embeddingDim: 384,
  chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 1 },
  globs: ['**/*.md'],
}

describe('estimateTokens', () => {
  it('uses ~4 chars/token heuristic', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('parseMarkdown', () => {
  it('splits by headings and tracks heading chain', () => {
    const doc = [
      '# Title',
      '',
      'Intro.',
      '',
      '## Section A',
      'A body.',
      '',
      '### Sub A1',
      'Sub body.',
      '',
      '## Section B',
      'B body.',
    ].join('\n')
    const blocks = parseMarkdown(doc)
    expect(blocks).toHaveLength(4)
    expect(blocks[0].headingChain).toEqual(['Title'])
    expect(blocks[1].headingChain).toEqual(['Title', 'Section A'])
    expect(blocks[2].headingChain).toEqual(['Title', 'Section A', 'Sub A1'])
    expect(blocks[3].headingChain).toEqual(['Title', 'Section B'])
  })

  it('ignores headings inside fenced code blocks', () => {
    const doc = ['# Real', '', '```md', '## Fake heading', '```', ''].join('\n')
    const blocks = parseMarkdown(doc)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].headingChain).toEqual(['Real'])
  })

  it('records accurate line ranges', () => {
    const doc = ['# H1', 'body1', 'body2', '## H2', 'body3'].join('\n')
    const blocks = parseMarkdown(doc)
    expect(blocks[0].startLine).toBe(1)
    expect(blocks[0].endLine).toBe(3)
    expect(blocks[1].startLine).toBe(4)
    expect(blocks[1].endLine).toBe(5)
  })
})

describe('chunkBlocks', () => {
  it('emits one chunk per small block', () => {
    const blocks = parseMarkdown('# H\nbody')
    const chunks = chunkBlocks(blocks, 'f.md', cfg.chunk)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].filePath).toBe('f.md')
    expect(chunks[0].headingChain).toEqual(['H'])
  })

  it('drops chunks below minTokens', () => {
    const blocks = parseMarkdown('# H\nx')
    const strict = { ...cfg.chunk, minTokens: 1000 }
    const chunks = chunkBlocks(blocks, 'f.md', strict)
    expect(chunks).toHaveLength(0)
  })

  it('splits oversize blocks with overlap', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} with some text here`).join('\n')
    const blocks = parseMarkdown(`# H\n${body}`)
    const chunks = chunkBlocks(blocks, 'long.md', {
      targetTokens: 50,
      overlapTokens: 10,
      minTokens: 5,
    })
    expect(chunks.length).toBeGreaterThan(1)
    // Consecutive chunks must overlap in line coverage
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].lineStart).toBeLessThanOrEqual(chunks[i - 1].lineEnd)
    }
  })

  it('generates stable deterministic ids', () => {
    const blocks = parseMarkdown('# H\nhello world')
    const a = chunkBlocks(blocks, 'f.md', cfg.chunk)
    const b = chunkBlocks(blocks, 'f.md', cfg.chunk)
    expect(a[0].id).toBe(b[0].id)
  })
})

describe('chunkDocument', () => {
  it('round-trips text content', () => {
    const raw = '# Title\n\nParagraph one.\n\n## Section\nParagraph two.'
    const chunks = chunkDocument(raw, 'a.md', cfg)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].text).toContain('Title')
    expect(chunks.map((c) => c.filePath)).toEqual(chunks.map(() => 'a.md'))
  })
})
