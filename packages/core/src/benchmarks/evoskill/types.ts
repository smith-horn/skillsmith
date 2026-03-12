// EvoSkill benchmark types
// Named EvoSkillBenchmarkResult to avoid collision with core BenchmarkResult

export interface BenchmarkTask {
  id: string
  question: string
  groundTruth: string
  split: 'train' | 'val' | 'test'
  benchmark: 'officeqa' | 'sealqa' | 'browsecomp'
}

/**
 * ConditionConfig.skillSelector implementations for Conditions 5 (Skillsmith-Optimized)
 * and 6 (Skillsmith-Create) require injected service instances (TransformationService,
 * CLI runner). Do not implement these as pure functions — pass dependencies via a
 * factory or closure over injected services before registering the selector.
 */
export interface ConditionConfig {
  name: string
  skillSelector: (tasks: BenchmarkTask[]) => Promise<string[]>
  /** Model ID for the agent under test */
  modelId: string
  /** Controls dataset split shuffle; temperature stays 0 for determinism */
  seed: number
}

/**
 * Named EvoSkillBenchmarkResult to avoid collision with core BenchmarkResult type.
 * Both are exported from @skillsmith/core; identical names would cause ambiguous imports.
 */
export interface EvoSkillBenchmarkResult {
  condition: string
  benchmark: string
  split: string
  accuracy: number
  taskCount: number
  correctCount: number
  costTokens: number
  costDollars: number
  wallClockMs: number
  /** Undefined for single-seed runs (Opus ablation); omit from JSON, render as "n/a" in markdown */
  accuracyStd?: number
  irMetrics?: {
    ndcg5: number
    mrr: number
    map5: number
  }
}

/** Scorer function signature: returns 0.0–1.0 */
export type ScorerFn = (
  question: string,
  predicted: string,
  groundTruth: string
) => number | Promise<number>

/** Configuration for the benchmark harness */
export interface HarnessConfig {
  benchmarks: Array<'officeqa' | 'sealqa' | 'browsecomp'>
  conditions: ConditionConfig[]
  seeds: number[]
  /** Fraction of test set to use (0-1, default 1.0) */
  sampleFraction: number
  /** Base directory for dataset files (absolute path) */
  datasetDir: string
  /** Output directory for results */
  outputDir: string
  /** Dry run — validate config without executing API calls */
  dryRun: boolean
}

/** Harness constants */
export const EVOSKILL_DEFAULTS = {
  /** EvoSkill's default seed for dataset splits */
  SEED: 42,
  /** Default split ratios matching EvoSkill */
  TRAIN_RATIO: 0.18,
  VAL_RATIO: 0.12,
  TEST_RATIO: 0.7,
  /** Judge model for LLM-scored benchmarks (always Sonnet, never the agent model) */
  JUDGE_MODEL_ID: 'claude-sonnet-4-6',
  /** Default agent model */
  AGENT_MODEL_ID: 'claude-sonnet-4-6',
  /** Retry delays for rate-limited API calls (ms) */
  RETRY_DELAYS: [1000, 2000, 4000] as const,
  /** Per-task timeout in ms */
  TASK_TIMEOUT_MS: 300_000,
} as const
