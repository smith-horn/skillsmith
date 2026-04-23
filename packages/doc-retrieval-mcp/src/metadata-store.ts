import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChunkMetadata } from './types.js'

export interface StoredMetadata {
  version: 1
  chunks: Record<string, ChunkMetadata>
}

export class MetadataStore {
  private data: StoredMetadata
  private dirty = false

  constructor(
    private readonly path: string,
    initial?: StoredMetadata
  ) {
    this.data = initial ?? { version: 1, chunks: {} }
  }

  static async load(path: string): Promise<MetadataStore> {
    if (!existsSync(path)) return new MetadataStore(path)
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as StoredMetadata
    if (parsed.version !== 1) {
      throw new Error(`MetadataStore: unsupported version ${parsed.version}`)
    }
    return new MetadataStore(path, parsed)
  }

  upsert(chunk: ChunkMetadata): void {
    this.data.chunks[chunk.id] = chunk
    this.dirty = true
  }

  delete(id: string): void {
    if (id in this.data.chunks) {
      delete this.data.chunks[id]
      this.dirty = true
    }
  }

  deleteByFile(filePath: string): string[] {
    const removed: string[] = []
    for (const [id, meta] of Object.entries(this.data.chunks)) {
      if (meta.filePath === filePath) {
        delete this.data.chunks[id]
        removed.push(id)
      }
    }
    if (removed.length > 0) this.dirty = true
    return removed
  }

  get(id: string): ChunkMetadata | null {
    return this.data.chunks[id] ?? null
  }

  has(id: string): boolean {
    return id in this.data.chunks
  }

  size(): number {
    return Object.keys(this.data.chunks).length
  }

  fileCount(): number {
    const set = new Set<string>()
    for (const meta of Object.values(this.data.chunks)) set.add(meta.filePath)
    return set.size
  }

  entries(): ChunkMetadata[] {
    return Object.values(this.data.chunks)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8')
    this.dirty = false
  }
}
