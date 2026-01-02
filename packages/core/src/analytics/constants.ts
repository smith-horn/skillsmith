/**
 * SMI-918: Analytics Constants
 *
 * Shared constants for analytics modules to eliminate magic numbers
 * and improve code maintainability.
 */

/** Number of days to retain analytics data before cleanup */
export const RETENTION_DAYS = 30

/** Cooldown period between suggestions in milliseconds */
export const SUGGESTION_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

/** Maximum suggestions per day per user */
export const MAX_SUGGESTIONS_PER_DAY = 3

/** Length of truncated context hash */
export const CONTEXT_HASH_LENGTH = 8

/** Milliseconds in one day */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Length of truncated user ID hash */
export const USER_ID_HASH_LENGTH = 16
