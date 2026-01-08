/**
 * SMI-860: Output generation for imported skills
 */

import * as fs from 'fs'
import * as path from 'path'
import { CONFIG, ImportedSkill, ImportStats, SEARCH_QUERIES } from './types.js'
import { log } from './utils.js'

/**
 * Saves imported skills to JSON file with metadata.
 *
 * @param skills - Array of skills to save
 * @param stats - Import statistics
 */
export function saveOutput(skills: ImportedSkill[], stats: ImportStats): void {
  const dir = path.dirname(CONFIG.OUTPUT_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const output = {
    metadata: {
      version: '1.0.0',
      generated_at: new Date().toISOString(),
      source: 'github',
      queries: SEARCH_QUERIES.map((q) => q.name),
    },
    stats,
    skills,
  }

  fs.writeFileSync(CONFIG.OUTPUT_PATH, JSON.stringify(output, null, 2))
  log(`Output saved to: ${CONFIG.OUTPUT_PATH}`)
  log(`  Total skills: ${skills.length}`)
  log(`  File size: ${(fs.statSync(CONFIG.OUTPUT_PATH).size / 1024).toFixed(2)} KB`)
}
