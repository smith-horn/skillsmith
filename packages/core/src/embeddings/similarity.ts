/**
 * SMI-659: Shared similarity computation utilities
 *
 * Extracted from VectorStore and EmbeddingService to eliminate code duplication
 * and provide a single, well-tested implementation.
 */

/**
 * Compute cosine similarity between two embedding vectors.
 *
 * The cosine similarity measures the cosine of the angle between two vectors,
 * ranging from -1 (opposite direction) to 1 (same direction), with 0 indicating
 * orthogonal vectors.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity score between -1 and 1
 * @throws Error if vectors have different dimensions
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vectors must have same dimension: got ${a.length} and ${b.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  // Handle zero vectors - they have no direction, so similarity is 0
  if (normA === 0 || normB === 0) return 0

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Compute Euclidean distance between two embedding vectors.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Euclidean distance (always >= 0)
 * @throws Error if vectors have different dimensions
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vectors must have same dimension: got ${a.length} and ${b.length}`)
  }

  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }

  return Math.sqrt(sum)
}

/**
 * Compute dot product between two embedding vectors.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Dot product value
 * @throws Error if vectors have different dimensions
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vectors must have same dimension: got ${a.length} and ${b.length}`)
  }

  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i]
  }

  return sum
}

/**
 * Compute the L2 (Euclidean) norm of a vector.
 *
 * @param v - The vector
 * @returns The L2 norm (magnitude)
 */
export function vectorNorm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i]
  }
  return Math.sqrt(sum)
}

/**
 * Normalize a vector to unit length (L2 normalization).
 *
 * @param v - The vector to normalize
 * @returns A new normalized vector (or zero vector if input is zero)
 */
export function normalize(v: Float32Array): Float32Array {
  const norm = vectorNorm(v)
  if (norm === 0) {
    return new Float32Array(v.length) // Return zero vector
  }

  const result = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) {
    result[i] = v[i] / norm
  }
  return result
}
