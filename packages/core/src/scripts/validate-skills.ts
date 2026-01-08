/**
 * SMI-863: Skill Validation and Deduplication Pipeline
 *
 * This file re-exports from the split validation module for backwards compatibility.
 * See ./validation/ for the implementation.
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/validate-skills.ts [--input skills.json] [--output-dir data]
 */

// Re-export everything from the validation module
export * from './validation/index.js'

// Import and re-run the CLI if this file is executed directly
import * as fs from 'fs'
import { CONFIG, runValidationPipeline } from './validation/index.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

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

const isMainModule = process.argv[1]?.includes('validate-skills')
if (isMainModule) {
  main().catch(console.error)
}
