// EvoSkill benchmark module barrel export

export { ndcg, mrr, mapAtK, precisionAtK, recallAtK } from './ir-metrics.js'

export {
  exactMatchScorer,
  createLlmJudgeScorer,
  getScorerForBenchmark,
  type LlmJudgeClient,
} from './scorers.js'

export type {
  BenchmarkTask,
  ConditionConfig,
  EvoSkillBenchmarkResult,
  ScorerFn,
  HarnessConfig,
} from './types.js'

export { EVOSKILL_DEFAULTS } from './types.js'

// Dataset loader
export {
  loadDataset,
  loadCSVDataset,
  loadJSONDataset,
  type DatasetLoadResult,
} from './dataset-loader.js'

// Skill selector
export {
  createBaselineSelector,
  createEvoSkillEvolvedSelector,
  createSearchSelector,
  createRecommendSelector,
  createOptimizedSelector,
  createSkillCreateSelector,
  createIterativeSelector,
  createHybridSelector,
  createCuratedSelector,
  NotImplementedError,
  CONDITIONS,
  type ConditionNumber,
  type ConditionName,
  type SkillSelectorFn,
  type SkillsmithSearchClient,
  type SkillsmithRecommendClient,
  type TransformationService,
  type SkillCreateRunner,
} from './skill-selector.js'

// Agent runner
export {
  runTask,
  runBatch,
  calculateCost,
  type AgentClient,
  type AgentRunnerConfig,
  type TaskResult,
  type TaskTokenUsage,
} from './agent-runner.js'

// Evaluator
export {
  evaluate,
  aggregateSeeds,
  type EvaluatorConfig,
} from './evaluator.js'

// Harness orchestrator
export {
  runHarness,
  type HarnessDependencies,
  type HarnessResult,
  type HarnessProgressFn,
  type HarnessProgressEvent,
} from './harness.js'

// Report generator
export {
  generateMarkdownReport,
  generateJsonReport,
  type ReportOptions,
} from './report.js'
