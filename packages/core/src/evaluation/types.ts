/**
 * @fileoverview Types for the EvoSkill task-accuracy evaluator (Study B)
 * @module @skillsmith/core/evaluation/types
 * @see Plan: docs/internal/implementation/evoskill-task-accuracy-evaluator.md
 */

// ============================================================================
// Failure Analysis Types
// ============================================================================

/** Categories of task failures detected by FailureAnalyzer */
export type FailureCategory =
  | 'wrong_format'
  | 'missing_context'
  | 'reasoning_error'
  | 'tool_misuse'
  | 'hallucination'

/** A single task failure with agent output and ground truth */
export interface TaskFailure {
  taskId: string
  predicted: string
  groundTruth: string
  agentOutput: string
  toolCallFailed?: boolean
  toolCallCount?: number
}

/** A categorized failure pattern with frequency and fix suggestion */
export interface FailurePattern {
  category: FailureCategory
  frequency: number
  examples: TaskFailure[] // max 5 representative examples
  suggestedFix: string // natural language improvement for skill content
}

/** Configuration for FailureAnalyzer */
export interface FailureAnalyzerConfig {
  mode: 'heuristic' | 'llm'
  maxExamplesPerCategory?: number // default: 5
}

// ============================================================================
// Skill Variant Types
// ============================================================================

/** Generation methods for producing skill variants */
export type GenerationMethod = 'baseline' | 'decompose' | 'augment' | 'specialize' | 'llm_rewrite'

/** A skill variant generated during iterative evaluation */
export interface SkillVariant {
  id: string // UUID (primary key for DB references)
  contentHash: string // SHA-256 of content (deduplication key)
  content: string // SKILL.md content
  parentId: string | null // derivation lineage
  skillId: string
  iteration: number
  generationMethod: GenerationMethod
  contentLines?: number
  costTokens?: number
}

/** A variant scored on accuracy and cost for Pareto selection */
export interface ScoredVariant {
  variant: SkillVariant
  accuracy: number // 0-1 on validation split
  cost: number // tokens consumed during generation
  skillSize: number // lines in SKILL.md
}

// ============================================================================
// Benchmark Result Types (DB rows)
// ============================================================================

/** Benchmark identifiers supported by the evaluator */
export type BenchmarkId = 'officeqa' | 'sealqa' | 'browsecomp'

/** Data split types */
export type SplitType = 'train' | 'val' | 'test'

/** Scorer types */
export type ScorerType = 'exact_match' | 'llm_judge'

/** Row shape for benchmark_results table */
export interface BenchmarkResultRow {
  id: string
  skill_id: string
  skill_variant_hash: string
  benchmark: BenchmarkId
  split: SplitType
  condition: string
  iteration: number
  accuracy: number
  task_count: number
  correct_count: number
  cost_tokens: number | null
  cost_dollars: number | null
  wall_clock_ms: number | null
  scorer: ScorerType
  model_id: string
  seed: number
  created_at: string
}

/** Input for inserting a benchmark result */
export interface BenchmarkResultInput {
  id: string
  skillId: string
  skillVariantHash: string
  benchmark: BenchmarkId
  split: SplitType
  condition: string
  iteration?: number
  accuracy: number
  taskCount: number
  correctCount: number
  costTokens?: number
  costDollars?: number
  wallClockMs?: number
  scorer: ScorerType
  modelId: string
  seed: number
}

/** Row shape for skill_variants table */
export interface SkillVariantRow {
  id: string
  skill_id: string
  parent_variant_id: string | null
  content_hash: string
  iteration: number
  generation_method: GenerationMethod
  accuracy_train: number | null
  accuracy_val: number | null
  accuracy_test: number | null
  content_lines: number | null
  cost_tokens: number | null
  is_frontier: number // 0 or 1
  created_at: string
}

/** Input for inserting a skill variant */
export interface SkillVariantInput {
  id: string
  skillId: string
  parentVariantId?: string | null
  contentHash: string
  iteration: number
  generationMethod: GenerationMethod
  accuracyTrain?: number | null
  accuracyVal?: number | null
  accuracyTest?: number | null
  contentLines?: number | null
  costTokens?: number | null
  isFrontier?: boolean
}

/** Row shape for failure_patterns table */
export interface FailurePatternRow {
  id: string
  benchmark_result_id: string
  category: FailureCategory
  frequency: number
  example_tasks: string | null // JSON array of task IDs
  suggested_fix: string | null
  created_at: string
}

/** Input for inserting a failure pattern */
export interface FailurePatternInput {
  id: string
  benchmarkResultId: string
  category: FailureCategory
  frequency: number
  exampleTasks?: string[] // task IDs
  suggestedFix?: string
}
