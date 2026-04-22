import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetadataStore } from '../src/metadata-store.js'
import type { ChunkMetadata } from '../src/types.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doc-retrieval-meta-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fixture(id: string, filePath = 'a.md'): ChunkMetadata {
  return {
    id,
    filePath,
    lineStart: 1,
    lineEnd: 10,
    headingChain: ['H'],
    text: 't',
    tokens: 10,
  }
}

describe('MetadataStore', () => {
  it('round-trips via flush/load', async () => {
    const path = join(dir, 'm.json')
    const s1 = new MetadataStore(path)
    s1.upsert(fixture('a'))
    s1.upsert(fixture('b'))
    await s1.flush()

    const s2 = await MetadataStore.load(path)
    expect(s2.size()).toBe(2)
    expect(s2.get('a')).not.toBeNull()
    expect(s2.get('missing')).toBeNull()
  })

  it('deletes entries by file', async () => {
    const store = new MetadataStore(join(dir, 'm.json'))
    store.upsert(fixture('x', 'a.md'))
    store.upsert(fixture('y', 'a.md'))
    store.upsert(fixture('z', 'b.md'))
    expect(store.size()).toBe(3)
    const removed = store.deleteByFile('a.md')
    expect(removed.sort()).toEqual(['x', 'y'])
    expect(store.size()).toBe(1)
    expect(store.fileCount()).toBe(1)
  })

  it('tracks file count distinct from chunk count', () => {
    const store = new MetadataStore(join(dir, 'm.json'))
    store.upsert(fixture('1', 'a.md'))
    store.upsert(fixture('2', 'a.md'))
    store.upsert(fixture('3', 'b.md'))
    expect(store.size()).toBe(3)
    expect(store.fileCount()).toBe(2)
  })

  it('rejects unsupported versions', async () => {
    const path = join(dir, 'm.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ version: 99, chunks: {} }))
    await expect(MetadataStore.load(path)).rejects.toThrow(/unsupported version/)
  })
})
