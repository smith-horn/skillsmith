import { EmbeddingService } from '@skillsmith/core/embeddings'

let cached: EmbeddingService | null = null

/**
 * Singleton EmbeddingService (Skillsmith's). Both index-time and query-time
 * embeddings share this pipeline to keep the cosine space aligned. RuVector's
 * own ONNX pipeline is NOT used — we pass raw 384-dim vectors into
 * @ruvector/core via VectorDB.insert / VectorDB.search.
 *
 * Note: EmbeddingService truncates input to 1000 chars (~250 tokens). Chunks
 * must target ≤240 tokens — see corpus.config.json `_rationale`.
 */
export async function getEmbedder(): Promise<EmbeddingService> {
  if (cached) return cached
  cached = await EmbeddingService.create({})
  return cached
}

export async function embed(text: string): Promise<Float32Array> {
  const svc = await getEmbedder()
  return svc.embed(text)
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const svc = await getEmbedder()
  const items = texts.map((text, i) => ({ id: String(i), text }))
  const results = await svc.embedBatch(items)
  return results.map((r) => r.embedding)
}

export function resetEmbedderCache(): void {
  cached = null
}
