/**
 * SMI-863: Skill Validation and Deduplication Pipeline
 *
 * Validates skill data against schema rules and deduplicates
 * entries using repository URL as primary key with source priority.
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/validate-skills.ts [--input skills.json] [--output-dir data]
 *
 * Validation Rules:
 * 1. Name present (non-empty)
 * 2. Author present (use repo owner if missing)
 * 3. Description present (use first 100 chars of name if missing)
 * 4. Valid ID format (author/name)
 * 5. Quality score 0-100
 * 6. Valid trust tier enum
 *
 * Deduplication:
 * - Primary key: repo_url
 * - Source priority: anthropic-official (100) > github (80) > claude-plugins (40)
 * - Keep higher quality score on conflict
 * - Semantic similarity detection (threshold 0.85)
 */

import * as fs from 'fs'
import { CONFIG } from './types.js'
import { runValidationPipeline } from './pipeline.js'

// Re-export all types and functions for external use
export * from './types.js'
export * from './normalizers.js'
export * from './field-validators.js'
export * from './deduplication.js'
export { runValidationPipeline } from './pipeline.js'

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Parse arguments
  let inputPath: string = CONFIG.DEFAULT_INPUT
  let outputDir: string = CONFIG.DEFAULT_OUTPUT_DIR

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputPath = args[++i]
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i]
    } else if (args[i] === '--help') {
      console.log(`
Usage: npx tsx packages/core/src/scripts/validate-skills.ts [options]

Options:
  --input <path>       Path to input JSON file (default: ${CONFIG.DEFAULT_INPUT})
  --output-dir <path>  Output directory for results (default: ${CONFIG.DEFAULT_OUTPUT_DIR})
  --help               Show this help message

Output files:
  validated-skills.json   Clean, deduplicated skill data
  validation-report.json  Validation statistics and errors
  duplicates-report.json  Detected duplicate entries
`)
      process.exit(0)
    }
  }

  // Validate input file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`)
    process.exit(1)
  }

  try {
    await runValidationPipeline(inputPath, outputDir)
  } catch (error) {
    console.error('Pipeline failed:', error)
    process.exit(1)
  }
}

// Run if executed directly
const isMainModule =
  process.argv[1]?.includes('validate-skills') || process.argv[1]?.includes('validation/index')
if (isMainModule) {
  main().catch(console.error)
}
