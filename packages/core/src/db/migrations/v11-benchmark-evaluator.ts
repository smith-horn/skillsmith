/**
 * @fileoverview Migration v11 — EvoSkill benchmark evaluator tables
 * @module @skillsmith/core/db/migrations/v11-benchmark-evaluator
 * @see Plan: docs/internal/implementation/evoskill-task-accuracy-evaluator.md
 *
 * Adds three tables for Study B (Task-Accuracy Evaluator):
 *  - benchmark_results: evaluation results across conditions/benchmarks/splits/seeds
 *  - skill_variants: skill variants generated during iterative evaluation
 *  - failure_patterns: categorized failure patterns per evaluation
 *
 * SCHEMA_VERSION reserved: 11 (Study B — evoskill-task-accuracy-evaluator branch)
 */
export const MIGRATION_V11_SQL = `
CREATE TABLE IF NOT EXISTS benchmark_results (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_variant_hash TEXT NOT NULL,
  benchmark TEXT NOT NULL CHECK (benchmark IN ('officeqa', 'sealqa', 'browsecomp')),
  split TEXT NOT NULL CHECK (split IN ('train', 'val', 'test')),
  condition TEXT NOT NULL,
  iteration INTEGER DEFAULT 0,
  accuracy REAL NOT NULL CHECK (accuracy >= 0 AND accuracy <= 1),
  task_count INTEGER NOT NULL,
  correct_count INTEGER NOT NULL CHECK (correct_count >= 0 AND correct_count <= task_count),
  cost_tokens INTEGER,
  cost_dollars REAL,
  wall_clock_ms INTEGER,
  scorer TEXT NOT NULL CHECK (scorer IN ('exact_match', 'llm_judge')),
  model_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_results_skill
  ON benchmark_results(skill_id, benchmark, split);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_condition
  ON benchmark_results(condition, benchmark);

CREATE TABLE IF NOT EXISTS skill_variants (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  parent_variant_id TEXT,
  content_hash TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  generation_method TEXT NOT NULL CHECK (
    generation_method IN ('baseline', 'decompose', 'augment', 'specialize', 'llm_rewrite')
  ),
  accuracy_train REAL,
  accuracy_val REAL,
  accuracy_test REAL,
  content_lines INTEGER,
  cost_tokens INTEGER,
  is_frontier INTEGER DEFAULT 0 CHECK (is_frontier IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  FOREIGN KEY (parent_variant_id) REFERENCES skill_variants(id),
  UNIQUE (skill_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_skill_variants_frontier
  ON skill_variants(skill_id, is_frontier)
  WHERE is_frontier = 1;

CREATE TABLE IF NOT EXISTS failure_patterns (
  id TEXT PRIMARY KEY,
  benchmark_result_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('wrong_format', 'missing_context', 'reasoning_error', 'tool_misuse', 'hallucination')
  ),
  frequency INTEGER NOT NULL,
  example_tasks TEXT,           -- JSON array of task IDs
  suggested_fix TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (benchmark_result_id) REFERENCES benchmark_results(id)
);
`
