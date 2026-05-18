/**
 * Shared types for the Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import { type MigrationCheckpoint } from './lib/migration-utils'

/**
 * SMI-2204: Progress mode types
 */
export type ProgressMode = 'dots' | 'bar' | 'json'

export interface CliOptions {
  limit: number
  offset: number
  dryRun: boolean
  verbose: boolean
  help: boolean
  resume: boolean
  reset: boolean
  checkpointInterval: number
  force: boolean
  noRateLimit: boolean
  // SMI-2201: Filter flags
  retryFailed: boolean
  retrySkipped: boolean
  onlyMissing: boolean
  since: string | undefined
  trustTier: string | undefined
  monorepoSkills: boolean
  // SMI-2204: Progress and output options
  progress: ProgressMode
  json: boolean
}

/**
 * SMI-2201: Filter configuration for targeted backfills
 */
export interface SkillFilters {
  retryFailed: boolean
  retrySkipped: boolean
  onlyMissing: boolean
  since: string | undefined
  trustTier: string | undefined
  monorepoSkills: boolean
}

export interface SkillRecord {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  trust_tier: string
}

export interface TransformStats {
  processed: number
  transformed: number
  skipped: number
  failed: number
  errors: string[]
  failedSkillIds: string[]
  skippedSkillIds: string[]
}

/**
 * SMI-2200: Extended checkpoint for batch-transform
 */
export interface BatchTransformCheckpoint extends MigrationCheckpoint {
  failedSkillIds: string[]
  skippedSkillIds: string[]
  runId: string
}

/**
 * SMI-2204: Result of processing a single skill
 */
export interface ProcessResult {
  status: 'transformed' | 'skipped' | 'failed'
  error?: string
}

/**
 * SMI-2204: JSON output schema for --json flag
 */
export interface JsonOutput {
  processed: number
  transformed: number
  skipped: number
  failed: number
  duration_ms: number
  checkpoint: { offset: number; timestamp: string } | null
  failed_skills: string[]
  skipped_skills: Array<{ id: string; reason: string }>
}

/**
 * SMI-2204: Interface for progress reporting during batch transformation
 */
export interface ProgressReporter {
  /** Initialize progress tracking */
  start(total: number | null, options: CliOptions): void
  /** Report start of a batch */
  batchStart(batchNum: number, startIdx: number, endIdx: number): void
  /** Report progress for a single skill */
  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void
  /** Report checkpoint saved */
  checkpoint(offset: number): void
  /** Report end of batch */
  batchEnd(): void
  /** Finalize and return optional JSON output */
  finish(stats: TransformStats, duration: number, runId: string): JsonOutput | null
}

export interface EnvConfig {
  supabaseUrl: string
  supabaseServiceKey: string
  githubToken?: string
}

/**
 * SMI-2200: Audit-log entry written to the audit_logs table
 */
export interface AuditLogEntry {
  event_type: string
  result?: 'success' | 'partial' | 'failed'
  metadata: Record<string, unknown>
}
