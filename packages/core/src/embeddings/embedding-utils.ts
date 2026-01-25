/**
 * Utility functions for EmbeddingService
 * @module @skillsmith/core/embeddings/embedding-utils
 */

/**
 * Check if fallback mode should be used based on environment
 */
export function shouldUseFallback(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit
  }
  // Check environment variable
  const envValue = process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS
  if (envValue !== undefined) {
    return envValue === 'true' || envValue === '1'
  }
  // Default to real embeddings
  return false
}

/**
 * Generate a deterministic hash from text for mock embeddings.
 * Uses a simple but effective string hashing algorithm.
 */
export function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return hash
}

/**
 * Generate deterministic mock embedding based on text content.
 * Produces consistent vectors for the same input text.
 */
export function generateMockEmbedding(text: string, dimension: number): Float32Array {
  const embedding = new Float32Array(dimension)
  const baseHash = hashText(text)

  for (let i = 0; i < dimension; i++) {
    // Use sine wave with hash-based offset for pseudo-random but deterministic values
    const value = Math.sin(baseHash + i * 0.1) * 0.5 + 0.5
    embedding[i] = value
  }

  // Normalize the vector
  let norm = 0
  for (let i = 0; i < dimension; i++) {
    norm += embedding[i] * embedding[i]
  }
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      embedding[i] /= norm
    }
  }

  return embedding
}

// Lazy-loaded pipeline function - only loaded when embeddings are actually used
let pipelineModule: typeof import('@xenova/transformers') | null = null
let pipelineLoadPromise: Promise<typeof import('@xenova/transformers')> | null = null
let pipelineLoadFailed = false
let pipelineLoadError: Error | null = null

/**
 * Lazily load the @xenova/transformers module.
 * This avoids loading sharp at startup, which causes CLI crashes.
 */
export async function loadTransformersModule(): Promise<
  typeof import('@xenova/transformers') | null
> {
  // Return cached module if already loaded
  if (pipelineModule) {
    return pipelineModule
  }

  // Return null if we already tried and failed
  if (pipelineLoadFailed) {
    return null
  }

  // Start loading if not already in progress
  if (!pipelineLoadPromise) {
    pipelineLoadPromise = import('@xenova/transformers')
      .then((mod) => {
        pipelineModule = mod
        return mod
      })
      .catch((err) => {
        pipelineLoadFailed = true
        pipelineLoadError = err instanceof Error ? err : new Error(String(err))
        return null as unknown as typeof import('@xenova/transformers')
      })
  }

  const result = await pipelineLoadPromise
  return result || null
}

/**
 * Check if the transformers module is available without loading it.
 * This is a synchronous check that returns the current known state.
 *
 * @returns true if module is loaded, false if loading failed, undefined if not yet attempted
 */
export function isTransformersAvailable(): boolean | undefined {
  if (pipelineModule) return true
  if (pipelineLoadFailed) return false
  return undefined
}

/**
 * Check if embeddings functionality is available.
 * Attempts to load the transformers module if not yet loaded.
 *
 * @returns true if embeddings can be used, false otherwise
 */
export async function checkTransformersAvailability(): Promise<boolean> {
  const mod = await loadTransformersModule()
  return mod !== null
}

/**
 * Get the error that occurred when loading the transformers module, if any.
 */
export function getTransformersLoadError(): Error | null {
  return pipelineLoadError
}
