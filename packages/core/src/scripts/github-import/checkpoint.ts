/**
 * SMI-860: Checkpoint management for resume support
 */

import * as fs from 'fs'
import * as path from 'path'
import { CONFIG, Checkpoint } from './types.js'
import { log } from './utils.js'

/**
 * Saves checkpoint for resume support.
 *
 * @param checkpoint - Checkpoint data to save
 */
export function saveCheckpoint(checkpoint: Checkpoint): void {
  const dir = path.dirname(CONFIG.CHECKPOINT_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(CONFIG.CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2))
  log(`Checkpoint saved: ${checkpoint.skills.length} skills, last query: ${checkpoint.last_query}`)
}

/**
 * Loads checkpoint if exists.
 *
 * @returns Checkpoint data or null if not found
 */
export function loadCheckpoint(): Checkpoint | null {
  if (!fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    return null
  }

  try {
    const data = fs.readFileSync(CONFIG.CHECKPOINT_PATH, 'utf-8')
    const checkpoint = JSON.parse(data) as Checkpoint
    log(`Loaded checkpoint from ${checkpoint.timestamp}`)
    log(`  Skills: ${checkpoint.skills.length}`)
    log(`  Last query: ${checkpoint.last_query}`)
    return checkpoint
  } catch (error) {
    log(`Error loading checkpoint: ${error}`, 'warn')
    return null
  }
}

/**
 * Clears checkpoint file.
 */
export function clearCheckpoint(): void {
  if (fs.existsSync(CONFIG.CHECKPOINT_PATH)) {
    fs.unlinkSync(CONFIG.CHECKPOINT_PATH)
    log('Checkpoint cleared')
  }
}
