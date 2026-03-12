/**
 * @fileoverview Repository for EvoSkill benchmark evaluator tables
 * @module @skillsmith/core/repositories/BenchmarkRepository
 * @see SMI-3292: BenchmarkRepository CRUD + migration
 *
 * Provides CRUD operations for:
 *  - benchmark_results: evaluation results across conditions/benchmarks/splits
 *  - skill_variants: skill variants generated during iterative evaluation
 *  - failure_patterns: categorized failure patterns per evaluation
 */

import type { Database } from '../db/database-interface.js'
import type {
  BenchmarkResultInput,
  BenchmarkResultRow,
  SkillVariantInput,
  SkillVariantRow,
  FailurePatternInput,
  FailurePatternRow,
  BenchmarkId,
  SplitType,
} from '../evaluation/types.js'

export class BenchmarkRepository {
  constructor(private readonly db: Database) {}

  // ==========================================================================
  // benchmark_results
  // ==========================================================================

  insertResult(input: BenchmarkResultInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO benchmark_results
        (id, skill_id, skill_variant_hash, benchmark, split, condition,
         iteration, accuracy, task_count, correct_count, cost_tokens,
         cost_dollars, wall_clock_ms, scorer, model_id, seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      input.id,
      input.skillId,
      input.skillVariantHash,
      input.benchmark,
      input.split,
      input.condition,
      input.iteration ?? 0,
      input.accuracy,
      input.taskCount,
      input.correctCount,
      input.costTokens ?? null,
      input.costDollars ?? null,
      input.wallClockMs ?? null,
      input.scorer,
      input.modelId,
      input.seed
    )
  }

  getResult(id: string): BenchmarkResultRow | undefined {
    return this.db.prepare('SELECT * FROM benchmark_results WHERE id = ?').get(id) as
      | BenchmarkResultRow
      | undefined
  }

  getResultsBySkill(
    skillId: string,
    benchmark?: BenchmarkId,
    split?: SplitType
  ): BenchmarkResultRow[] {
    let sql = 'SELECT * FROM benchmark_results WHERE skill_id = ?'
    const params: unknown[] = [skillId]

    if (benchmark) {
      sql += ' AND benchmark = ?'
      params.push(benchmark)
    }
    if (split) {
      sql += ' AND split = ?'
      params.push(split)
    }

    sql += ' ORDER BY created_at DESC'
    return this.db.prepare(sql).all(...params) as BenchmarkResultRow[]
  }

  getResultsByCondition(condition: string, benchmark: BenchmarkId): BenchmarkResultRow[] {
    return this.db
      .prepare(
        `SELECT * FROM benchmark_results
         WHERE condition = ? AND benchmark = ?
         ORDER BY iteration ASC, seed ASC`
      )
      .all(condition, benchmark) as BenchmarkResultRow[]
  }

  deleteResult(id: string): boolean {
    const info = this.db.prepare('DELETE FROM benchmark_results WHERE id = ?').run(id)
    return info.changes > 0
  }

  // ==========================================================================
  // skill_variants
  // ==========================================================================

  insertVariant(input: SkillVariantInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_variants
        (id, skill_id, parent_variant_id, content_hash, iteration,
         generation_method, accuracy_train, accuracy_val, accuracy_test,
         content_lines, cost_tokens, is_frontier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      input.id,
      input.skillId,
      input.parentVariantId ?? null,
      input.contentHash,
      input.iteration,
      input.generationMethod,
      input.accuracyTrain ?? null,
      input.accuracyVal ?? null,
      input.accuracyTest ?? null,
      input.contentLines ?? null,
      input.costTokens ?? null,
      input.isFrontier ? 1 : 0
    )
  }

  getVariant(id: string): SkillVariantRow | undefined {
    return this.db.prepare('SELECT * FROM skill_variants WHERE id = ?').get(id) as
      | SkillVariantRow
      | undefined
  }

  getVariantByHash(skillId: string, contentHash: string): SkillVariantRow | undefined {
    return this.db
      .prepare('SELECT * FROM skill_variants WHERE skill_id = ? AND content_hash = ?')
      .get(skillId, contentHash) as SkillVariantRow | undefined
  }

  getFrontierVariants(skillId: string): SkillVariantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM skill_variants
         WHERE skill_id = ? AND is_frontier = 1
         ORDER BY accuracy_val DESC NULLS LAST`
      )
      .all(skillId) as SkillVariantRow[]
  }

  updateVariantAccuracy(
    id: string,
    accuracyTrain: number | null,
    accuracyVal: number | null,
    accuracyTest: number | null
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE skill_variants
         SET accuracy_train = ?, accuracy_val = ?, accuracy_test = ?
         WHERE id = ?`
      )
      .run(accuracyTrain, accuracyVal, accuracyTest, id)
    return info.changes > 0
  }

  setFrontier(id: string, isFrontier: boolean): boolean {
    const info = this.db
      .prepare('UPDATE skill_variants SET is_frontier = ? WHERE id = ?')
      .run(isFrontier ? 1 : 0, id)
    return info.changes > 0
  }

  clearFrontier(skillId: string): void {
    this.db.prepare('UPDATE skill_variants SET is_frontier = 0 WHERE skill_id = ?').run(skillId)
  }

  deleteVariant(id: string): boolean {
    const info = this.db.prepare('DELETE FROM skill_variants WHERE id = ?').run(id)
    return info.changes > 0
  }

  // ==========================================================================
  // failure_patterns
  // ==========================================================================

  insertPattern(input: FailurePatternInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO failure_patterns
        (id, benchmark_result_id, category, frequency, example_tasks, suggested_fix)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      input.id,
      input.benchmarkResultId,
      input.category,
      input.frequency,
      input.exampleTasks ? JSON.stringify(input.exampleTasks) : null,
      input.suggestedFix ?? null
    )
  }

  getPattern(id: string): FailurePatternRow | undefined {
    return this.db.prepare('SELECT * FROM failure_patterns WHERE id = ?').get(id) as
      | FailurePatternRow
      | undefined
  }

  getPatternsByResult(benchmarkResultId: string): FailurePatternRow[] {
    return this.db
      .prepare(
        `SELECT * FROM failure_patterns
         WHERE benchmark_result_id = ?
         ORDER BY frequency DESC`
      )
      .all(benchmarkResultId) as FailurePatternRow[]
  }

  deletePattern(id: string): boolean {
    const info = this.db.prepare('DELETE FROM failure_patterns WHERE id = ?').run(id)
    return info.changes > 0
  }

  deletePatternsByResult(benchmarkResultId: string): number {
    const info = this.db
      .prepare('DELETE FROM failure_patterns WHERE benchmark_result_id = ?')
      .run(benchmarkResultId)
    return info.changes
  }
}
