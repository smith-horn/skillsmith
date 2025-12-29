/**
 * SMI-738: Embedding Generation Benchmarks
 *
 * Measures performance of embedding operations:
 * - Single text embedding generation
 * - Batch embedding generation
 * - Cosine similarity calculations
 * - Vector search operations
 * - Model loading time
 */

import { BenchmarkRunner, type BenchmarkReport, type BenchmarkConfig } from './BenchmarkRunner.js'
import { EmbeddingService } from '../embeddings/index.js'

/**
 * Embedding benchmark configuration
 */
export interface EmbeddingBenchmarkConfig extends BenchmarkConfig {
  /** Number of texts to embed in batch tests (default: 100) */
  batchSize?: number
  /** Skip model loading benchmark (default: false) */
  skipModelLoad?: boolean
  /** Use shorter iterations for slow operations (default: 50) */
  embeddingIterations?: number
}

const DEFAULT_CONFIG: Required<EmbeddingBenchmarkConfig> = {
  warmupIterations: 3,
  iterations: 100,
  measureMemory: true,
  suiteName: 'embedding',
  batchSize: 100,
  skipModelLoad: false,
  embeddingIterations: 50,
  enableMemoryProfiler: false,
  memoryRegressionThreshold: 10,
  memoryBaselines: {},
}

/**
 * Performance targets for embedding operations
 */
export const EMBEDDING_TARGETS = {
  /** Single embedding generation p50 (ms) */
  single_embed_p50_ms: 50,
  /** Single embedding generation p95 (ms) */
  single_embed_p95_ms: 100,
  /** Batch embedding per-item p50 (ms) */
  batch_embed_per_item_p50_ms: 30,
  /** Cosine similarity p95 (ms) */
  similarity_p95_ms: 0.1,
  /** Vector search p95 (ms) for 1000 vectors */
  vector_search_p95_ms: 10,
  /** Max memory for embedding service (MB) */
  memoryPeak_mb: 500,
}

/**
 * Embedding operation benchmark suite
 */
export class EmbeddingBenchmark {
  private config: Required<EmbeddingBenchmarkConfig>
  private embeddingService: EmbeddingService | null = null
  private testTexts: string[] = []
  private testEmbeddings: Float32Array[] = []

  constructor(config: EmbeddingBenchmarkConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run all embedding benchmarks
   */
  async run(): Promise<BenchmarkReport> {
    const runner = new BenchmarkRunner({
      warmupIterations: this.config.warmupIterations,
      iterations: this.config.embeddingIterations,
      measureMemory: this.config.measureMemory,
      suiteName: this.config.suiteName,
      enableMemoryProfiler: this.config.enableMemoryProfiler,
      memoryRegressionThreshold: this.config.memoryRegressionThreshold,
      memoryBaselines: this.config.memoryBaselines,
    })

    // Generate test data
    this.generateTestData()

    // Model loading benchmark (only if not skipped)
    if (!this.config.skipModelLoad) {
      runner.add({
        name: 'model_load',
        fn: async () => {
          // Create fresh service to measure cold load
          const service = new EmbeddingService()
          await service.loadModel()
        },
      })
    }

    // Setup: Load model once for remaining benchmarks
    await this.setup()

    // Single text embedding
    let singleEmbedIndex = 0
    runner.add({
      name: 'single_embed',
      fn: async () => {
        const text = this.testTexts[singleEmbedIndex % this.testTexts.length]
        singleEmbedIndex++
        await this.embeddingService!.embed(text)
      },
    })

    // Short text embedding (faster)
    let shortEmbedIndex = 0
    runner.add({
      name: 'short_text_embed',
      fn: async () => {
        const text = `skill ${shortEmbedIndex++}`
        await this.embeddingService!.embed(text)
      },
    })

    // Long text embedding (slower, more realistic)
    let longEmbedIndex = 0
    runner.add({
      name: 'long_text_embed',
      fn: async () => {
        const text = this.generateLongText(longEmbedIndex++)
        await this.embeddingService!.embed(text)
      },
    })

    // Cosine similarity calculation (pre-computed embeddings)
    let simIndex = 0
    runner.add({
      name: 'cosine_similarity',
      fn: () => {
        const idx1 = simIndex % this.testEmbeddings.length
        const idx2 = (simIndex + 1) % this.testEmbeddings.length
        simIndex++
        this.embeddingService!.cosineSimilarity(
          this.testEmbeddings[idx1],
          this.testEmbeddings[idx2]
        )
      },
    })

    // Batch cosine similarity (simulate vector search)
    runner.add({
      name: 'batch_similarity_100',
      fn: () => {
        const query = this.testEmbeddings[0]
        for (let i = 1; i < Math.min(100, this.testEmbeddings.length); i++) {
          this.embeddingService!.cosineSimilarity(query, this.testEmbeddings[i])
        }
      },
    })

    // Large batch similarity (1000 vectors)
    runner.add({
      name: 'batch_similarity_1000',
      fn: () => {
        const query = this.testEmbeddings[0]
        // Simulate 1000 comparisons by repeating
        for (let i = 0; i < 1000; i++) {
          const idx = i % this.testEmbeddings.length
          this.embeddingService!.cosineSimilarity(query, this.testEmbeddings[idx])
        }
      },
    })

    // Find similar (full workflow)
    runner.add({
      name: 'find_similar_top10',
      fn: () => {
        const queryEmbedding = this.testEmbeddings[0]
        this.embeddingService!.findSimilar(queryEmbedding, 10)
      },
    })

    // Embedding storage (if database configured)
    let storeIndex = 0
    runner.add({
      name: 'store_embedding',
      fn: () => {
        const idx = storeIndex % this.testEmbeddings.length
        storeIndex++
        this.embeddingService!.storeEmbedding(
          `skill_${idx}`,
          this.testEmbeddings[idx],
          this.testTexts[idx]
        )
      },
    })

    // Embedding retrieval
    let retrieveIndex = 0
    runner.add({
      name: 'retrieve_embedding',
      fn: () => {
        const idx = retrieveIndex % this.testEmbeddings.length
        retrieveIndex++
        this.embeddingService!.getEmbedding(`skill_${idx}`)
      },
    })

    // Get all embeddings
    runner.add({
      name: 'get_all_embeddings',
      fn: () => {
        this.embeddingService!.getAllEmbeddings()
      },
    })

    // Run benchmarks
    const report = await runner.run()

    // Cleanup
    await this.teardown()

    return report
  }

  /**
   * Run batch embedding benchmark separately (fewer iterations due to cost)
   */
  async runBatchBenchmark(): Promise<BenchmarkReport> {
    const runner = new BenchmarkRunner({
      warmupIterations: 1,
      iterations: 10, // Fewer iterations for expensive batch operations
      measureMemory: true,
      suiteName: 'embedding_batch',
      enableMemoryProfiler: this.config.enableMemoryProfiler,
      memoryRegressionThreshold: this.config.memoryRegressionThreshold,
      memoryBaselines: this.config.memoryBaselines,
    })

    await this.setup()
    this.generateTestData()

    // Batch embedding
    runner.add({
      name: 'batch_embed_100',
      fn: async () => {
        const batch = this.testTexts.slice(0, 100).map((text, i) => ({
          id: `batch_${i}`,
          text,
        }))
        await this.embeddingService!.embedBatch(batch)
      },
    })

    // Precompute embeddings
    runner.add({
      name: 'precompute_embeddings',
      fn: async () => {
        const skills = this.testTexts.slice(0, 50).map((text, i) => ({
          id: `precompute_${i}`,
          name: `Skill ${i}`,
          description: text,
        }))
        await this.embeddingService!.precomputeEmbeddings(skills)
      },
    })

    const report = await runner.run()
    await this.teardown()

    return report
  }

  /**
   * Setup embedding service
   */
  private async setup(): Promise<void> {
    this.embeddingService = new EmbeddingService(':memory:')
    await this.embeddingService.loadModel()

    // Pre-compute test embeddings for similarity benchmarks
    if (this.testEmbeddings.length === 0) {
      for (let i = 0; i < Math.min(100, this.testTexts.length); i++) {
        const embedding = await this.embeddingService.embed(this.testTexts[i])
        this.testEmbeddings.push(embedding)
        // Also store for retrieval benchmarks
        this.embeddingService.storeEmbedding(`skill_${i}`, embedding, this.testTexts[i])
      }
    }
  }

  /**
   * Generate test data
   */
  private generateTestData(): void {
    if (this.testTexts.length > 0) return

    const languages = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java']
    const categories = ['formatting', 'linting', 'testing', 'deployment', 'documentation']
    const adjectives = ['comprehensive', 'lightweight', 'advanced', 'simple', 'powerful']

    for (let i = 0; i < this.config.batchSize; i++) {
      const lang = languages[i % languages.length]
      const category = categories[i % categories.length]
      const adj = adjectives[i % adjectives.length]

      this.testTexts.push(
        `${lang} ${category} skill - A ${adj} tool for ${category} ` +
          `${lang} code with best practices support and automated fixes. ` +
          `Integrates with popular editors and CI/CD pipelines for seamless workflow.`
      )
    }
  }

  /**
   * Generate long text for stress testing
   */
  private generateLongText(seed: number): string {
    const base = `Skill ${seed}: A comprehensive development tool that provides `
    const features = [
      'code formatting',
      'static analysis',
      'automated testing',
      'documentation generation',
      'security scanning',
      'performance profiling',
      'dependency management',
      'build optimization',
    ]

    let text = base
    for (let i = 0; i < 10; i++) {
      text += features[(seed + i) % features.length] + ', '
    }
    text += 'and much more. '

    // Add more content to approach model limits
    text += 'This skill integrates seamlessly with modern development workflows, '
    text += 'supporting multiple programming languages and frameworks. '
    text += 'It provides real-time feedback and suggestions for improving code quality.'

    return text.slice(0, 1000) // Truncate to model limit
  }

  /**
   * Cleanup resources
   */
  private async teardown(): Promise<void> {
    if (this.embeddingService) {
      this.embeddingService.close()
      this.embeddingService = null
    }
  }
}

/**
 * Validate embedding benchmark results against targets
 */
export function validateEmbeddingResults(report: BenchmarkReport): EmbeddingValidationResult {
  const failures: string[] = []
  const warnings: string[] = []

  const checkTarget = (name: string, metric: 'p50_ms' | 'p95_ms', target: number) => {
    const stats = report.results[name]
    if (!stats) return

    const value = stats[metric]
    if (value > target) {
      failures.push(`${name}: ${metric} (${value.toFixed(2)}ms) exceeds target (${target}ms)`)
    }
  }

  // Check embedding performance
  checkTarget('single_embed', 'p50_ms', EMBEDDING_TARGETS.single_embed_p50_ms)
  checkTarget('single_embed', 'p95_ms', EMBEDDING_TARGETS.single_embed_p95_ms)

  // Check similarity performance
  checkTarget('cosine_similarity', 'p95_ms', EMBEDDING_TARGETS.similarity_p95_ms)

  // Check vector search performance
  checkTarget('batch_similarity_1000', 'p95_ms', EMBEDDING_TARGETS.vector_search_p95_ms)

  // Memory warnings
  for (const [name, stats] of Object.entries(report.results)) {
    if (stats.memoryPeak_mb && stats.memoryPeak_mb > EMBEDDING_TARGETS.memoryPeak_mb) {
      warnings.push(
        `${name}: high memory usage (${stats.memoryPeak_mb}MB) exceeds target (${EMBEDDING_TARGETS.memoryPeak_mb}MB)`
      )
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  }
}

/**
 * Embedding validation result
 */
export interface EmbeddingValidationResult {
  passed: boolean
  failures: string[]
  warnings: string[]
}
