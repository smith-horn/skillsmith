/**
 * Shared constants for scripts
 * SMI-2203: Centralize configuration values
 */

/**
 * Base delay between GitHub API requests (ms)
 * Can be overridden via GITHUB_API_BASE_DELAY environment variable
 */
export const GITHUB_API_BASE_DELAY = parseInt(process.env.GITHUB_API_BASE_DELAY || '150', 10)

/**
 * Default checkpoint interval (number of skills between saves)
 */
export const DEFAULT_CHECKPOINT_INTERVAL = 50

/**
 * Checkpoint file name for batch-transform
 */
export const BATCH_TRANSFORM_CHECKPOINT_FILE = '.batch-transform-checkpoint.json'
