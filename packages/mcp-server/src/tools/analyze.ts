/**
 * @fileoverview MCP analyze_codebase Tool
 * @module @skillsmith/mcp-server/tools/analyze
 * @see SMI-600: Implement analyze_codebase MCP tool
 *
 * Analyzes a codebase to extract context for skill recommendations.
 * Uses TypeScript/JavaScript analysis per ADR-010.
 *
 * @example
 * // Analyze current directory
 * const result = await executeAnalyze({ path: '.' });
 * console.log(result.frameworks);
 *
 * @example
 * // Analyze with options
 * const result = await executeAnalyze({
 *   path: '/path/to/project',
 *   max_files: 500,
 *   include_dev_deps: false
 * });
 */

import { z } from 'zod'
import { CodebaseAnalyzer, type CodebaseContext, type FrameworkInfo } from '@skillsmith/core'

/**
 * Zod schema for analyze tool input validation
 */
export const analyzeInputSchema = z.object({
  /** Path to analyze (default: current directory) */
  path: z.string().default('.'),
  /** Maximum files to analyze (default: 1000) */
  max_files: z.number().min(1).max(10000).default(1000),
  /** Directories to exclude */
  exclude_dirs: z.array(z.string()).optional(),
  /** Include dev dependencies in analysis */
  include_dev_deps: z.boolean().default(true),
})

/**
 * Input type for analyze tool
 */
export type AnalyzeInput = z.input<typeof analyzeInputSchema>

/**
 * Simplified framework info for response
 */
export interface AnalyzeFramework {
  /** Framework name */
  name: string
  /** Confidence level (0-100) */
  confidence: number
}

/**
 * Simplified dependency info for response
 */
export interface AnalyzeDependency {
  /** Package name */
  name: string
  /** Whether this is a dev dependency */
  is_dev: boolean
}

/**
 * Analysis response with codebase context
 */
export interface AnalyzeResponse {
  /** Detected frameworks */
  frameworks: AnalyzeFramework[]
  /** Top dependencies */
  dependencies: AnalyzeDependency[]
  /** Unique import modules */
  imports: string[]
  /** File statistics */
  stats: {
    total_files: number
    total_lines: number
    file_types: Record<string, number>
  }
  /** Summary for skill matching */
  summary: string
  /** Analysis timing */
  timing: {
    duration_ms: number
  }
}

/**
 * MCP tool schema definition for analyze_codebase
 */
export const analyzeToolSchema = {
  name: 'analyze_codebase',
  description:
    'Analyze a codebase to understand its structure, frameworks, and dependencies. ' +
    'Returns context useful for skill recommendations. ' +
    'Supports TypeScript, JavaScript, TSX, and JSX files.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Path to the codebase to analyze (default: current directory)',
        default: '.',
      },
      max_files: {
        type: 'number',
        description: 'Maximum files to analyze (default: 1000, max: 10000)',
        minimum: 1,
        maximum: 10000,
        default: 1000,
      },
      exclude_dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directories to exclude (default: node_modules, dist, .git, coverage)',
      },
      include_dev_deps: {
        type: 'boolean',
        description: 'Include dev dependencies in analysis (default: true)',
        default: true,
      },
    },
    required: [],
  },
}

/**
 * Execute codebase analysis.
 *
 * Scans the specified directory for TypeScript/JavaScript files,
 * extracts imports, detects frameworks, and returns context
 * suitable for skill recommendations.
 *
 * @param input - Analysis parameters
 * @returns Promise resolving to analysis response
 * @throws {Error} When path doesn't exist or analysis fails
 *
 * @example
 * const response = await executeAnalyze({
 *   path: './my-project',
 *   max_files: 500
 * });
 * console.log('Detected:', response.frameworks.map(f => f.name).join(', '));
 */
export async function executeAnalyze(input: AnalyzeInput): Promise<AnalyzeResponse> {
  // Validate input
  const validated = analyzeInputSchema.parse(input)

  const analyzer = new CodebaseAnalyzer()

  const context = await analyzer.analyze(validated.path, {
    maxFiles: validated.max_files,
    excludeDirs: validated.exclude_dirs,
    includeDevDeps: validated.include_dev_deps,
  })

  // Transform to response format
  return transformContextToResponse(context, analyzer)
}

/**
 * Transform CodebaseContext to AnalyzeResponse
 */
function transformContextToResponse(
  context: CodebaseContext,
  analyzer: CodebaseAnalyzer
): AnalyzeResponse {
  // Get unique import modules (external only)
  const uniqueImports = new Set<string>()
  for (const imp of context.imports) {
    // Skip relative imports
    if (!imp.module.startsWith('.') && !imp.module.startsWith('/')) {
      // Get base package name (e.g., '@scope/pkg' or 'pkg')
      const parts = imp.module.split('/')
      const basePkg = imp.module.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
      uniqueImports.add(basePkg)
    }
  }

  // Transform frameworks
  const frameworks: AnalyzeFramework[] = context.frameworks
    .slice(0, 10)
    .map((f: FrameworkInfo) => ({
      name: f.name,
      confidence: Math.round(f.confidence * 100),
    }))

  // Transform dependencies (top 20)
  const dependencies: AnalyzeDependency[] = context.dependencies.slice(0, 20).map((d) => ({
    name: d.name,
    is_dev: d.isDev,
  }))

  // Get summary
  const summary = analyzer.getSummary(context)

  return {
    frameworks,
    dependencies,
    imports: Array.from(uniqueImports).slice(0, 50),
    stats: {
      total_files: context.stats.totalFiles,
      total_lines: context.stats.totalLines,
      file_types: context.stats.filesByExtension,
    },
    summary,
    timing: {
      duration_ms: context.metadata.durationMs,
    },
  }
}

/**
 * Format analysis results for terminal display
 */
export function formatAnalysisResults(response: AnalyzeResponse): string {
  const lines: string[] = []

  lines.push('\n=== Codebase Analysis ===\n')

  // Stats
  lines.push(
    `Files: ${response.stats.total_files} | Lines: ${response.stats.total_lines.toLocaleString()}`
  )
  lines.push(`Duration: ${response.timing.duration_ms}ms`)
  lines.push('')

  // File types
  const fileTypes = Object.entries(response.stats.file_types)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ')
  lines.push(`File types: ${fileTypes}`)
  lines.push('')

  // Frameworks
  if (response.frameworks.length > 0) {
    lines.push('Frameworks detected:')
    for (const fw of response.frameworks.slice(0, 5)) {
      lines.push(`  • ${fw.name} (${fw.confidence}% confidence)`)
    }
    lines.push('')
  }

  // Dependencies
  if (response.dependencies.length > 0) {
    const prodDeps = response.dependencies.filter((d) => !d.is_dev)
    const devDeps = response.dependencies.filter((d) => d.is_dev)

    if (prodDeps.length > 0) {
      lines.push(`Dependencies (${prodDeps.length}):`)
      lines.push(
        `  ${prodDeps
          .slice(0, 10)
          .map((d) => d.name)
          .join(', ')}`
      )
      if (prodDeps.length > 10) {
        lines.push(`  ... and ${prodDeps.length - 10} more`)
      }
      lines.push('')
    }

    if (devDeps.length > 0) {
      lines.push(`Dev dependencies (${devDeps.length}):`)
      lines.push(
        `  ${devDeps
          .slice(0, 10)
          .map((d) => d.name)
          .join(', ')}`
      )
      if (devDeps.length > 10) {
        lines.push(`  ... and ${devDeps.length - 10} more`)
      }
      lines.push('')
    }
  }

  // Summary
  lines.push('---')
  lines.push(`Summary: ${response.summary}`)

  return lines.join('\n')
}
