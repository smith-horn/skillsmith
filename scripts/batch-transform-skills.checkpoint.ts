/**
 * SMI-2200: Checkpoint management and interactive confirmation for the
 * Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { BATCH_TRANSFORM_CHECKPOINT_FILE } from './lib/constants'
import type { BatchTransformCheckpoint } from './batch-transform-skills.types'

const CHECKPOINT_PATH = path.join(process.cwd(), BATCH_TRANSFORM_CHECKPOINT_FILE)

export function loadBatchTransformCheckpoint(): BatchTransformCheckpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const data = fs.readFileSync(CHECKPOINT_PATH, 'utf-8')
      const parsed = JSON.parse(data) as BatchTransformCheckpoint
      if (typeof parsed.processedCount === 'number' && parsed.runId) {
        console.log(`\n📍 Found checkpoint: ${parsed.processedCount} skills processed`)
        console.log(`   Run ID: ${parsed.runId}`)
        console.log(`   Last offset: ${parsed.lastProcessedOffset}`)
        console.log(`   Timestamp: ${parsed.timestamp}`)
        return parsed
      }
    }
  } catch (error) {
    // Log error details for debugging (SMI-2204: Fix silent catch)
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.warn(`Invalid checkpoint format, starting fresh: ${errorMsg}`)
  }
  return null
}

export function saveBatchTransformCheckpoint(checkpoint: BatchTransformCheckpoint): void {
  // Create backup before saving
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.copyFileSync(CHECKPOINT_PATH, CHECKPOINT_PATH + '.bak')
  }
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2))
}

export function clearBatchTransformCheckpoint(): void {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH)
    console.log('✓ Checkpoint cleared.')
  }
  // Also remove backup
  if (fs.existsSync(CHECKPOINT_PATH + '.bak')) {
    fs.unlinkSync(CHECKPOINT_PATH + '.bak')
  }
}

export async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}
