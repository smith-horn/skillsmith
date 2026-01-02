/**
 * SMI-915: Metrics Exporter
 *
 * Exports aggregated metrics to various formats for analysis and reporting.
 * Supports:
 * - JSON export with full metrics data
 * - CSV export for spreadsheet analysis
 * - Weekly/daily/custom period exports
 * - Retention metrics (optional)
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { homedir } from 'os'

/**
 * Validates that a path does not escape the allowed base directory.
 * Prevents path traversal attacks using sequences like '../'.
 *
 * @param inputPath - The path to validate (can be relative or absolute)
 * @param baseDir - The allowed base directory
 * @returns The resolved, sanitized absolute path
 * @throws Error if the path attempts to escape the base directory
 */
export function validatePath(inputPath: string, baseDir: string): string {
  const resolvedBase = resolve(baseDir)
  const resolvedPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseDir, inputPath)

  // Ensure the resolved path starts with the base directory
  // Add path separator to prevent partial matches (e.g., /base vs /base-other)
  if (!resolvedPath.startsWith(resolvedBase + '/') && resolvedPath !== resolvedBase) {
    throw new Error(`Path traversal attempt detected: ${inputPath}`)
  }

  return resolvedPath
}
import type { MetricsAggregator, GlobalMetrics, AggregationPeriod } from './metrics-aggregator.js'
import type { SkillMetrics } from './types.js'

/**
 * Exported metrics structure
 */
export interface MetricsExport {
  /** ISO timestamp when export was generated */
  exportedAt: string
  /** Period information */
  period: {
    /** ISO timestamp of period start */
    start: string
    /** ISO timestamp of period end */
    end: string
    /** Human-readable label (e.g., "2026-W01") */
    label: string
  }
  /** Global metrics across all skills */
  global: GlobalMetrics
  /** Per-skill metrics keyed by skill ID */
  skills: Record<string, SkillMetrics>
  /** Optional retention data by skill */
  retention?: Record<string, number>
}

/**
 * Export configuration options
 */
export interface ExportOptions {
  /** Directory for output files (defaults to ~/.skillsmith/exports) */
  outputDir?: string
  /** Output format (defaults to 'json') */
  format?: 'json' | 'csv'
  /** Include retention rate calculations (defaults to false) */
  includeRetention?: boolean
  /** Retention period in days for calculation (defaults to 7) */
  retentionDays?: number
}

/**
 * Default export directory
 */
const DEFAULT_EXPORT_DIR = join(homedir(), '.skillsmith', 'exports')

/**
 * Exports metrics to files in various formats
 */
export class MetricsExporter {
  private aggregator: MetricsAggregator

  /**
   * Create a metrics exporter
   *
   * @param aggregator - MetricsAggregator instance
   */
  constructor(aggregator: MetricsAggregator) {
    this.aggregator = aggregator
  }

  /**
   * Get ISO week label (e.g., "2026-W01")
   *
   * @param date - Date to get week label for
   * @returns ISO week label string
   */
  private getWeekLabel(date: Date): string {
    const year = date.getFullYear()
    const oneJan = new Date(year, 0, 1)
    const days = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000))
    const weekNum = Math.ceil((days + oneJan.getDay() + 1) / 7)
    return `${year}-W${weekNum.toString().padStart(2, '0')}`
  }

  /**
   * Get day label (e.g., "2026-01-01")
   *
   * @param date - Date to get label for
   * @returns ISO date string (YYYY-MM-DD)
   */
  private getDayLabel(date: Date): string {
    return date.toISOString().split('T')[0]
  }

  /**
   * Export metrics for the last N days
   *
   * @param days - Number of days to include
   * @param options - Export options
   * @returns Exported metrics data
   */
  exportLastNDays(days: number, options: ExportOptions = {}): MetricsExport {
    const end = Date.now()
    const start = end - days * 24 * 60 * 60 * 1000
    const period: AggregationPeriod = { start, end }

    return this.export(period, options)
  }

  /**
   * Export metrics for a specific week
   *
   * @param date - Any date within the desired week (defaults to current week)
   * @param options - Export options
   * @returns Exported metrics data
   */
  exportWeek(date: Date = new Date(), options: ExportOptions = {}): MetricsExport {
    // Get start of week (Monday)
    const d = new Date(date)
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1)
    const start = new Date(d.setDate(diff))
    start.setHours(0, 0, 0, 0)

    const end = new Date(start)
    end.setDate(end.getDate() + 7)

    const period: AggregationPeriod = { start: start.getTime(), end: end.getTime() }
    return this.export(period, options)
  }

  /**
   * Export metrics for a specific day
   *
   * @param date - The date to export (defaults to today)
   * @param options - Export options
   * @returns Exported metrics data
   */
  exportDay(date: Date = new Date(), options: ExportOptions = {}): MetricsExport {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const start = d.getTime()
    const end = start + 24 * 60 * 60 * 1000

    const period: AggregationPeriod = { start, end }
    return this.export(period, options)
  }

  /**
   * Export metrics for a time period
   *
   * @param period - Aggregation period
   * @param options - Export options
   * @returns Exported metrics data
   */
  export(period: AggregationPeriod, options: ExportOptions = {}): MetricsExport {
    const global = this.aggregator.getGlobalMetrics(period)
    const skillMetrics = this.aggregator.getAllSkillMetrics(period)

    const skills: Record<string, SkillMetrics> = {}
    for (const metric of skillMetrics) {
      skills[metric.skillId] = metric
    }

    const exportData: MetricsExport = {
      exportedAt: new Date().toISOString(),
      period: {
        start: new Date(period.start).toISOString(),
        end: new Date(period.end).toISOString(),
        label: this.getWeekLabel(new Date(period.start)),
      },
      global,
      skills,
    }

    // Optionally include retention data
    if (options.includeRetention) {
      const retentionDays = options.retentionDays ?? 7
      const retention: Record<string, number> = {}

      for (const skillId of Object.keys(skills)) {
        retention[skillId] = this.aggregator.getRetentionRate(skillId, retentionDays)
      }

      exportData.retention = retention
    }

    return exportData
  }

  /**
   * Save export data to a file
   *
   * @param data - Metrics export data
   * @param options - Export options
   * @param allowedBaseDir - Optional base directory to restrict path access (defaults to DEFAULT_EXPORT_DIR)
   * @returns Path to the saved file
   * @throws Error if outputDir attempts to escape the allowedBaseDir
   */
  saveToFile(data: MetricsExport, options: ExportOptions = {}, allowedBaseDir?: string): string {
    const outputDir = options.outputDir || DEFAULT_EXPORT_DIR
    const format = options.format || 'json'

    // Validate output directory to prevent path traversal attacks
    const baseDir = allowedBaseDir ?? DEFAULT_EXPORT_DIR
    const validatedOutputDir = validatePath(outputDir, baseDir)

    if (!existsSync(validatedOutputDir)) {
      mkdirSync(validatedOutputDir, { recursive: true })
    }

    const filename = `metrics-${data.period.label}.${format}`
    const filepath = join(validatedOutputDir, filename)

    if (format === 'json') {
      writeFileSync(filepath, JSON.stringify(data, null, 2))
    } else if (format === 'csv') {
      const csv = this.toCSV(data)
      writeFileSync(filepath, csv)
    }

    return filepath
  }

  /**
   * Convert export data to CSV format
   *
   * @param data - Metrics export data
   * @returns CSV string
   */
  private toCSV(data: MetricsExport): string {
    const lines: string[] = []

    // Header with optional retention column
    const headers = [
      'skill_id',
      'total_invocations',
      'success_rate',
      'avg_duration_ms',
      'unique_users',
      'last_used',
    ]
    if (data.retention) {
      headers.push('retention_rate')
    }
    lines.push(headers.join(','))

    // Data rows
    for (const [skillId, metrics] of Object.entries(data.skills)) {
      const row = [
        this.escapeCSV(skillId),
        metrics.totalInvocations.toString(),
        metrics.successRate.toFixed(3),
        metrics.avgTaskDuration.toString(),
        metrics.uniqueUsers.toString(),
        metrics.lastUsed > 0 ? new Date(metrics.lastUsed).toISOString() : '',
      ]

      if (data.retention) {
        row.push((data.retention[skillId] ?? 0).toFixed(3))
      }

      lines.push(row.join(','))
    }

    return lines.join('\n')
  }

  /**
   * Escape a string for CSV output
   *
   * @param value - String to escape
   * @returns Escaped string
   */
  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }

  /**
   * Export to JSON string (for programmatic use)
   *
   * @param data - Metrics export data
   * @param pretty - Whether to format with indentation (defaults to true)
   * @returns JSON string
   */
  toJSON(data: MetricsExport, pretty: boolean = true): string {
    return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  }
}
